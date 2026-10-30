// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { ProviderError } from '../src/providers/provider-error.ts';
import { isConfigurableProviderId } from '../src/providers/connection-configuration.ts';
import type { ConfigurableProviderId } from '../src/providers/connection-configuration.ts';
import { OpenAICompatibleProvider } from './providers/openai-compatible.ts';
import { AnthropicProvider } from './providers/anthropic.ts';

export interface PrivateConnectionSettings {
  baseUrl?: string;
  model: string;
  apiKey: string;
}

// Small injectable boundary: unit tests do not depend on a user's OS key store.
export interface SecretEncryption {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}
type StoreFiles = Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'unlink'>;

export function validateSettings(settings: PrivateConnectionSettings, providerId: ConfigurableProviderId = 'openai-compatible'): PrivateConnectionSettings {
  const { model, apiKey } = settings;
  const baseUrl = settings.baseUrl ?? '';
  if (!apiKey.trim()) throw new ProviderError('KEY_REQUIRED');
  if (baseUrl.length > 2048 || model.length > 200 || apiKey.length > 8192
    || /[\x00-\x1f\x7f]/.test(baseUrl + model + apiKey)) throw new ProviderError('CONFIG_INVALID');
  if (providerId === 'anthropic' && settings.baseUrl !== undefined) throw new ProviderError('CONFIG_INVALID');
  const normalized = { ...(providerId === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}), model: model.trim(), apiKey: apiKey.trim() };
  const provider = providerId === 'anthropic' ? new AnthropicProvider(normalized)
    : new OpenAICompatibleProvider({ ...normalized, id: providerId, displayName: 'OpenAI-compatible' });
  if (provider.configurationError) throw new ProviderError('CONFIG_INVALID');
  // Never duplicate a known credential into plaintext metadata or a public summary.
  let decodedUrl: string;
  try { decodedUrl = decodeURIComponent(normalized.baseUrl ?? ''); } catch { throw new ProviderError('CONFIG_INVALID'); }
  if (normalized.baseUrl?.includes(normalized.apiKey) || decodedUrl.includes(normalized.apiKey)
    || normalized.model.includes(normalized.apiKey)) throw new ProviderError('CONFIG_INVALID');
  return normalized;
}

export class ConnectionStore {
  readonly #file: string;
  readonly #encryption: SecretEncryption;
  readonly #files: StoreFiles;
  readonly #providerId: ConfigurableProviderId;

  constructor(directory: string, encryption: SecretEncryption, files: StoreFiles = fs, providerId: ConfigurableProviderId = 'openai-compatible') {
    if (!isConfigurableProviderId(providerId)) throw new ProviderError('INVALID_REQUEST');
    this.#providerId = providerId;
    this.#file = path.join(directory, `${providerId}-connection.json`);
    this.#encryption = encryption;
    this.#files = files;
  }

  private async requireEncryption(): Promise<void> {
    try { if (await this.#encryption.isAvailable()) return; } catch { /* Fail closed. */ }
    throw new ProviderError('ENCRYPTION_UNAVAILABLE');
  }

  async read(): Promise<PrivateConnectionSettings | undefined> {
    let text: string;
    try { text = await this.#files.readFile(this.#file, 'utf8'); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw new ProviderError('STORAGE_READ_FAILED');
    }
    let saved: { baseUrl?: string; model: string; encryptedApiKey: string };
    try {
      if (text.length > 64_000) throw new Error();
      const value = JSON.parse(text);
      const fields = this.#providerId === 'openai-compatible' ? 'baseUrl,encryptedApiKey,model,providerId,version' : 'encryptedApiKey,model,providerId,version';
      if (!value || Array.isArray(value) || value.version !== 1 || value.providerId !== this.#providerId
        || Object.keys(value).sort().join(',') !== fields
        || (this.#providerId === 'openai-compatible' && typeof value.baseUrl !== 'string') || typeof value.model !== 'string'
        || typeof value.encryptedApiKey !== 'string' || !value.encryptedApiKey
        || Buffer.from(value.encryptedApiKey, 'base64').toString('base64') !== value.encryptedApiKey) throw new Error();
      saved = value;
    } catch { throw new ProviderError('STORAGE_CORRUPT'); }
    await this.requireEncryption();
    let apiKey: string;
    try { apiKey = await this.#encryption.decrypt(Buffer.from(saved.encryptedApiKey, 'base64')); }
    catch { throw new ProviderError('DECRYPTION_FAILED'); }
    try { return validateSettings({ ...(this.#providerId === 'openai-compatible' ? { baseUrl: saved.baseUrl } : {}), model: saved.model, apiKey }, this.#providerId); }
    catch { throw new ProviderError('STORAGE_CORRUPT'); }
  }

  async save(settings: PrivateConnectionSettings): Promise<void> {
    const valid = validateSettings(settings, this.#providerId);
    await this.requireEncryption();
    let encrypted: Buffer;
    try { encrypted = await this.#encryption.encrypt(valid.apiKey); }
    catch { throw new ProviderError('ENCRYPTION_FAILED'); }
    if (!encrypted.length) throw new ProviderError('ENCRYPTION_FAILED');
    // Base64 serializes OS-encrypted bytes; it is not the encryption mechanism.
    const data = JSON.stringify({ version: 1, providerId: this.#providerId, ...(this.#providerId === 'openai-compatible' ? { baseUrl: valid.baseUrl } : {}),
      model: valid.model, encryptedApiKey: encrypted.toString('base64') });
    const temporary = `${this.#file}.tmp`;
    try {
      await this.#files.mkdir(path.dirname(this.#file), { recursive: true });
      await this.#files.writeFile(temporary, data, { encoding: 'utf8', mode: 0o600 });
      await this.#files.rename(temporary, this.#file);
    } catch { throw new ProviderError('STORAGE_WRITE_FAILED'); }
    finally { await this.#files.unlink(temporary).catch(() => {}); }
  }

  async remove(): Promise<void> {
    try {
      // Both paths are fixed by main, never supplied over IPC.
      for (const file of [`${this.#file}.tmp`, this.#file]) {
        try { await this.#files.unlink(file); }
        catch (cause) { if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') throw cause; }
      }
    } catch { throw new ProviderError('STORAGE_REMOVE_FAILED'); }
  }
}
