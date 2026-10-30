// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SecretEncryption } from './connection-store.ts';
import { HISTORY_BYTES, HISTORY_LIMIT, HistoryError, historySummary, isHistoryId, validateHistory } from '../src/domain/loop-history.ts';
import type { LoopHistory } from '../src/domain/loop-history.ts';
import type { HistoryList } from '../src/application/history-ipc.ts';
import { HISTORY_SEARCH_LENGTH } from '../src/application/history-ipc.ts';

function searchQuery(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'query')) throw new HistoryError('invalid');
  const query = (input as { query: unknown }).query;
  if (typeof query !== 'string' || query.length > HISTORY_SEARCH_LENGTH) throw new HistoryError('invalid');
  return query.trim().toLowerCase();
}

type HistoryFiles = Pick<typeof fs, 'open' | 'mkdir' | 'readdir' | 'lstat' | 'link' | 'unlink'>;
type SearchRow = { summary: HistoryList['items'][number]; request: string };
export const HISTORY_DIRECTORY = 'loop-history';
const ENCRYPTED_LIMIT = HISTORY_BYTES + 65_536;
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === 'ENOENT';

export class LoopHistoryStore {
  readonly #directory: string;
  readonly #encryption: SecretEncryption;
  readonly #files: HistoryFiles;
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #closing = false;
  // Bounded main-only projection of the last listing; never retain outputs or
  // persist a plaintext index. No-argument list refreshes external disk changes.
  #listing?: { rows: SearchRow[]; partial: boolean };
  constructor(userData: string, encryption: SecretEncryption, files: HistoryFiles = fs) {
    this.#directory = path.join(userData, HISTORY_DIRECTORY);
    this.#encryption = encryption; this.#files = files;
  }
  get pending(): boolean { return this.#pending > 0; }
  async close(): Promise<void> { this.#closing = true; await this.#tail; this.#listing = undefined; }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#pending >= 8) return Promise.reject(new HistoryError('unavailable'));
    this.#pending++;
    const result = this.#tail.then(work).catch((cause: unknown) => {
      throw cause instanceof HistoryError ? cause : new HistoryError('unavailable');
    }).finally(() => { this.#pending--; });
    this.#tail = result.catch(() => {});
    return result;
  }
  private file(id: unknown): string {
    if (!isHistoryId(id)) throw new HistoryError('invalid');
    return path.join(this.#directory, `${id}.loop`);
  }
  private async encrypted(): Promise<void> {
    try { if (await this.#encryption.isAvailable()) return; } catch { /* fail closed */ }
    throw new HistoryError('encryption');
  }
  private async directory(): Promise<boolean> {
    try {
      const stat = await this.#files.lstat(this.#directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HistoryError('unavailable');
      return true;
    } catch (cause) { if (missing(cause)) return false; throw cause; }
  }
  private async entries(): Promise<string[]> {
    if (!await this.directory()) return [];
    return (await this.#files.readdir(this.#directory)).filter((name) => name.endsWith('.loop'));
  }
  private async read(id: string): Promise<LoopHistory> {
    const file = this.file(id);
    if (!await this.directory()) throw new HistoryError('missing');
    let handle;
    try {
      const stat = await this.#files.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ENCRYPTED_LIMIT) throw new HistoryError('corrupt');
      handle = await this.#files.open(file, 'r');
    } catch (cause) { if (missing(cause)) throw new HistoryError('missing'); throw cause; }
    let bytes: Buffer;
    try {
      // Bound reads even if an external process grows the file after stat.
      const buffer = Buffer.alloc(ENCRYPTED_LIMIT + 1); let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (!offset || offset > ENCRYPTED_LIMIT) throw new HistoryError('corrupt');
      bytes = buffer.subarray(0, offset);
    } finally { await handle.close(); }
    await this.encrypted();
    try {
      const plain = await this.#encryption.decrypt(bytes);
      if (Buffer.byteLength(plain, 'utf8') > HISTORY_BYTES) throw new HistoryError('too_large');
      const record = validateHistory(JSON.parse(plain));
      if (record.id !== id) throw new HistoryError('corrupt');
      return record;
    } catch (cause) {
      if (cause instanceof HistoryError && cause.code === 'version') throw cause;
      throw new HistoryError('corrupt');
    }
  }
  save(input: unknown) {
    // Take a bounded, sanitized copy synchronously, before another caller can mutate it.
    let record: LoopHistory;
    try { record = validateHistory(input); } catch (cause) { return Promise.reject(cause instanceof HistoryError ? cause : new HistoryError('invalid')); }
    return this.serial(async () => {
      const file = this.file(record.id);
      const data = JSON.stringify(record);
      try {
        const existing = await this.read(record.id);
        if (JSON.stringify(existing) !== data) throw new HistoryError('conflict');
        this.#listing = undefined;
        return historySummary(existing);
      } catch (cause) { if (!(cause instanceof HistoryError) || cause.code !== 'missing') throw cause; }
      if ((await this.entries()).length >= HISTORY_LIMIT) throw new HistoryError('limit');
      await this.encrypted();
      let cipher: Buffer;
      try { cipher = await this.#encryption.encrypt(data); } catch { throw new HistoryError('encryption'); }
      if (!Buffer.isBuffer(cipher) || !cipher.length || cipher.length > ENCRYPTED_LIMIT) throw new HistoryError('encryption');
      await this.#files.mkdir(this.#directory, { recursive: true });
      await this.directory();
      const temporary = path.join(this.#directory, `.${randomUUID()}.tmp`);
      const handle = await this.#files.open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(cipher); await handle.sync(); } finally { await handle.close(); }
        // Same-directory, exclusive publication: never replace an existing ID, even
        // if a second process publishes it while encryption is pending.
        try { await this.#files.link(temporary, file); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException)?.code !== 'EEXIST') throw cause;
          if (JSON.stringify(await this.read(record.id)) !== data) throw new HistoryError('conflict');
        }
      } finally { await this.#files.unlink(temporary).catch(() => {}); }
      this.#listing = undefined;
      return historySummary(record);
    });
  }
  list(search?: unknown): Promise<HistoryList> {
    let query: string | undefined;
    try { if (search !== undefined) query = searchQuery(search); }
    catch { return Promise.reject(new HistoryError('invalid')); }
    return this.serial(async () => {
      if (query === undefined || !this.#listing) {
        this.#listing = undefined;
        const entries = await this.entries();
        const rows: SearchRow[] = [];
        let partial = entries.length > HISTORY_LIMIT;
        for (const entry of entries.slice(0, HISTORY_LIMIT)) {
          try {
            const record = await this.read(entry.slice(0, -5));
            rows.push({ summary: historySummary(record), request: record.userRequest.toLowerCase() });
          } catch { partial = true; }
        }
        rows.sort((a, b) => b.summary.completedAt.localeCompare(a.summary.completedAt) || a.summary.id.localeCompare(b.summary.id));
        this.#listing = { rows, partial };
      }
      const { rows, partial } = this.#listing;
      const matches = query ? rows.filter(({ summary, request }) => summary.title.toLowerCase().includes(query) || request.includes(query)) : rows;
      return { items: matches.map(({ summary }) => structuredClone(summary)), partial,
        ...(query !== undefined ? { total: rows.length } : {}) };
    });
  }
  get(id: unknown): Promise<LoopHistory> {
    if (!isHistoryId(id)) return Promise.reject(new HistoryError('invalid'));
    return this.serial(() => this.read(id));
  }
  remove(id: unknown): Promise<null> {
    if (!isHistoryId(id)) return Promise.reject(new HistoryError('invalid'));
    return this.serial(async () => {
      // Preserve unknown versions/corrupt records; no automatic deletion or guessing.
      try { await this.read(id); } catch (cause) {
        if (cause instanceof HistoryError && cause.code === 'missing') { this.#listing = undefined; return null; }
        throw cause;
      }
      try { await this.#files.unlink(this.file(id)); } catch (cause) { if (!missing(cause)) throw cause; }
      this.#listing = undefined;
      return null;
    });
  }
}
