// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validOllamaModel } from '../src/providers/ollama.ts';
import { ProviderError } from '../src/providers/provider-error.ts';

// Only a non-secret model selection. Does not read or change Credential Store.
export class OllamaStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  async read(): Promise<string | undefined> {
    let raw: string;
    try { raw = await readFile(path.join(this.directory, 'ollama-local.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new ProviderError('STORAGE_READ_FAILED'); }
    try {
      if (raw.length > 4096) throw new Error();
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || Object.keys(data).sort().join(',') !== 'model,version' || !validOllamaModel(data.model)) throw new Error();
      return data.model;
    } catch { throw new ProviderError('STORAGE_CORRUPT'); }
  }
  async save(model: string): Promise<void> {
    if (!validOllamaModel(model)) throw new ProviderError('INVALID_REQUEST');
    const temporary = path.join(this.directory, `ollama-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, model }), { flag: 'wx' });
      await rename(temporary, path.join(this.directory, 'ollama-local.json'));
    } catch { throw new ProviderError('STORAGE_WRITE_FAILED'); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
}
