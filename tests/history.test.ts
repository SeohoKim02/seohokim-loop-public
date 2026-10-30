// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { LoopHistoryStore, HISTORY_DIRECTORY } from '../electron/history-store.ts';
import type { SecretEncryption } from '../electron/connection-store.ts';
import { registerHistoryIpc } from '../electron/history-ipc.ts';
import { HISTORY_LIMIT, HistoryError, historyLoop, historySnapshot, historySummary } from '../src/domain/loop-history.ts';
import type { LoopHistory } from '../src/domain/loop-history.ts';
import { saveCompletedHistory } from '../src/application/save-history.ts';
import { historySaveMessage } from '../src/application/history-ipc.ts';
import type { HistoryBridge } from '../src/application/history-ipc.ts';
import { exportCompletedResult } from '../src/application/result-export.ts';

const output = '  # 한국어 😀\r\n|열|값|\n|---|---|\n```js\nalert("text only");\n```\n<script>throw 1</script>  ';
const time = '2026-10-13T01:00:00.000Z';
function record(completedAt = '2026-10-13T01:00:02.000Z'): LoopHistory {
  return { schemaVersion: 1, id: randomUUID(), title: '작업 기록', userRequest: '원본 사용자 요청', executionMode: 'auto', createdAt: time, startedAt: time,
    completedAt, status: 'completed', finalResult: output, steps: [
      { id: randomUUID(), title: '분석', role: 'analyze', assignedProvider: { id: 'provider-b', displayName: '다른 AI' },
        originalProvider: { id: 'provider-a', displayName: '처음 AI' }, startedAt: time, completedAt: time, status: 'completed', output: '첫 단계 결과', retryCount: 1, fallbackCount: 1 },
      { id: randomUUID(), title: '최종 정리', role: 'deliver', assignedProvider: { id: 'provider-a', displayName: '처음 AI' },
        startedAt: time, completedAt, status: 'completed', output, retryCount: 0, fallbackCount: 0 },
    ] };
}
const key = randomBytes(32);
const encryption: SecretEncryption = {
  isAvailable: async () => true,
  encrypt: async (text) => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  },
  decrypt: async (data) => {
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  },
};
async function setup(t: TestContext, cipher = encryption, files?: ConstructorParameters<typeof LoopHistoryStore>[2]) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'seohokim-history-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('seohokim-history-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, folder: path.join(directory, HISTORY_DIRECTORY), store: new LoopHistoryStore(directory, cipher, files) };
}
const fails = (code: string) => (cause: unknown) => cause instanceof HistoryError && cause.code === code;
function storeBridge(store: LoopHistoryStore): HistoryBridge {
  return { saveHistory: async (data) => ({ ok: true, value: await store.save(data) }),
    listHistory: async () => ({ ok: true, value: await store.list() }),
    getHistory: async (id) => ({ ok: true, value: await store.get(id) }),
    deleteHistory: async (id) => ({ ok: true, value: await store.remove(id) }) };
}

test('manual re-save recovers encryption failure using the exact completed Loop with zero AI requests', async (t) => {
  let available = false; let saves = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async () => { assert.fail('Re-save must never call AI'); });
  const { store, directory, folder } = await setup(t, { ...encryption, isAvailable: async () => available });
  const bridge = storeBridge(store); const original = bridge.saveHistory;
  bridge.saveHistory = (data) => { saves++; return original(data); };
  const loop = historyLoop(record()); const before = structuredClone(loop);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await saveCompletedHistory(loop, bridge), { ok: false, code: 'encryption' });
    assert.deepEqual(loop, before); assert.deepEqual(await fs.readdir(directory), []);
  }
  available = true;
  assert.equal((await saveCompletedHistory(loop, bridge)).ok, true);
  assert.equal(saves, 3); assert.deepEqual(loop, before);
  assert.deepEqual(await store.get(loop.id), historySnapshot(loop));
  assert.deepEqual(await fs.readdir(folder), [`${loop.id}.loop`]);
  assert.equal(fetch.mock.callCount(), 0);
});

test('a lost success acknowledgement re-saves without rewriting ciphertext or damaging another record', async (t) => {
  const { store, folder } = await setup(t); const other = record(); await store.save(other);
  const loop = historyLoop(record()); const bridge = storeBridge(store);
  const lostReply = { ...bridge, saveHistory: async (data: LoopHistory) => {
    await store.save(data); throw new Error('private path Authorization fake-key stack');
  } };
  assert.deepEqual(await saveCompletedHistory(loop, lostReply), { ok: false, code: 'unavailable' });
  const bytes = await fs.readFile(path.join(folder, `${loop.id}.loop`));
  assert.equal((await saveCompletedHistory(loop, bridge)).ok, true);
  assert.deepEqual(await fs.readFile(path.join(folder, `${loop.id}.loop`)), bytes);
  assert.deepEqual(await store.get(other.id), other); assert.equal((await store.list()).items.length, 2);
});

test('overlapping automatic and manual save paths publish only the original ID', async (t) => {
  const { store, folder } = await setup(t); const loop = historyLoop(record()); const bridge = storeBridge(store);
  const replies = await Promise.all([saveCompletedHistory(loop, bridge), saveCompletedHistory(loop, bridge)]);
  assert.ok(replies.every((reply) => reply.ok));
  assert.deepEqual(await fs.readdir(folder), [`${loop.id}.loop`]);
});

for (const operation of ['open', 'link'] as const) {
  test(`manual re-save recovers ${operation} failure without mutating completed fields`, async (t) => {
    let broken = true;
    const files = { ...fs, [operation]: async (...args: unknown[]) => {
      if (broken) throw new Error('private disk path stack');
      return (fs[operation] as (...args: unknown[]) => unknown)(...args);
    } } as ConstructorParameters<typeof LoopHistoryStore>[2];
    const { store, folder } = await setup(t, encryption, files);
    const loop = historyLoop(record()); const before = structuredClone(loop); const bridge = storeBridge(store);
    assert.deepEqual(await saveCompletedHistory(loop, bridge), { ok: false, code: 'unavailable' });
    assert.deepEqual(await fs.readdir(folder), []); broken = false;
    assert.equal((await saveCompletedHistory(loop, bridge)).ok, true); assert.deepEqual(loop, before);
    assert.deepEqual(await store.get(loop.id), historySnapshot(loop));
  });
}

test('manual re-save cannot bypass the record count limit; removing one record permits recovery', async (t) => {
  const { store } = await setup(t); const first = record(); await store.save(first);
  for (let i = 1; i < HISTORY_LIMIT; i++) await store.save(record());
  const loop = historyLoop(record()); const bridge = storeBridge(store);
  for (let i = 0; i < 2; i++) assert.deepEqual(await saveCompletedHistory(loop, bridge), { ok: false, code: 'limit' });
  assert.equal((await store.list()).items.length, HISTORY_LIMIT);
  await store.remove(first.id); assert.equal((await saveCompletedHistory(loop, bridge)).ok, true);
  assert.equal((await store.list()).items.length, HISTORY_LIMIT);
});

test('oversized re-save remains rejected without truncation or plaintext while Markdown export stays available', async (t) => {
  const { store, directory } = await setup(t); const input = record(); input.finalResult = '한'.repeat(200_000);
  input.steps = Array.from({ length: 5 }, () => ({ ...input.steps[1]!, id: randomUUID(), output: input.finalResult }));
  const loop = historyLoop(input); const before = structuredClone(loop);
  for (let i = 0; i < 2; i++) assert.deepEqual(await saveCompletedHistory(loop, storeBridge(store)), { ok: false, code: 'too_large' });
  assert.deepEqual(await fs.readdir(directory), []); assert.deepEqual(loop, before);
  assert.deepEqual(await exportCompletedResult(loop, { exportMarkdown: async () => ({ status: 'saved' }) }), { status: 'saved' });
});

test('failed encryption creates nothing that a restarted store can restore', async (t) => {
  const { store, directory } = await setup(t, { ...encryption, isAvailable: async () => false });
  const loop = historyLoop(record());
  assert.deepEqual(await saveCompletedHistory(loop, storeBridge(store)), { ok: false, code: 'encryption' });
  await store.close(); const restarted = new LoopHistoryStore(directory, encryption);
  assert.deepEqual(await restarted.list(), { items: [], partial: false });
  await assert.rejects(restarted.get(loop.id), fails('missing'));
});

for (const code of ['invalid', 'conflict', 'corrupt', 'version'] as const) {
  test(`re-save ${code} preserves the error code and offers a safe Markdown alternative`, async () => {
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected history operation'); };
    const bridge: HistoryBridge = { saveHistory: async () => ({ ok: false, code }),
      listHistory: unexpected, getHistory: unexpected, deleteHistory: unexpected };
    assert.deepEqual(await saveCompletedHistory(historyLoop(record()), bridge), { ok: false, code });
    assert.match(historySaveMessage(code), /Markdown/);
    assert.doesNotMatch(historySaveMessage(code), /Authorization|apiKey|stack|C:\\/);
  });
}

test('completed snapshot persists exact fields, outputs, providers, counts, dates and survives a new store instance', async (t) => {
  const { directory, folder, store } = await setup(t); const input = record();
  assert.deepEqual(await store.save(input), historySummary(input));
  assert.deepEqual(await store.get(input.id), input);
  assert.deepEqual(await new LoopHistoryStore(directory, encryption).get(input.id), input);
  const bytes = await fs.readFile(path.join(folder, `${input.id}.loop`));
  for (const text of [input.userRequest, input.finalResult, input.steps[0]!.output!, 'schemaVersion']) assert.ok(!bytes.includes(Buffer.from(text)));
  assert.deepEqual(JSON.parse(await encryption.decrypt(bytes)), input);
  assert.deepEqual(await fs.readdir(folder), [`${input.id}.loop`]);
});
test('snapshot explicitly selects safe fields without copying internal or credential objects', () => {
  const loop = historyLoop(record());
  const polluted = Object.assign(loop, { apiKey: 'fake-key', env: {}, Authorization: 'fake-token', response: {}, stack: 'private', auto: { title: '계획 제목', phase: 'executing' } });
  Object.assign(polluted.steps[0]!.assignedProvider, { apiKey: 'fake-key', connection: {} });
  const snapshot = historySnapshot(polluted);
  assert.equal(snapshot.title, '계획 제목'); assert.equal(snapshot.finalResult, output); assert.equal(snapshot.steps[0]!.retryCount, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /fake-key|fake-token|Authorization|connection|stack|response|env/);
});
test('history mode distinguishes Auto, Single and Manual without changing domain mode', () => {
  const loop = historyLoop(record());
  assert.equal(historySnapshot(loop).executionMode, 'auto');
  assert.equal(historySnapshot({ ...loop, mode: 'manual' }).executionMode, 'single');
  assert.equal(historySnapshot({ ...loop, mode: 'manual', collaboration: { strategy: 'draft-review-improve', primaryProviderId: 'a', reviewerProviderId: 'b' } }).executionMode, 'manual');
});
for (const status of ['pending', 'running', 'failed', 'cancelled'] as const) {
  test(`${status} never saves even with finalResult present`, async (t) => {
    const { store, directory } = await setup(t); const input = record();
    await assert.rejects(store.save({ ...input, status }), fails('invalid'));
    assert.throws(() => historySnapshot({ ...historyLoop(input), status }), fails('invalid'));
    assert.deepEqual(await fs.readdir(directory), []);
  });
}
test('invalid fields, dates, counts, steps and unexpected credential fields are rejected', async (t) => {
  const { store, directory } = await setup(t); const input = record();
  const invalid = [null, [], {}, { ...input, finalResult: undefined }, { ...input, finalResult: '  ' }, { ...input, finalResult: 12 },
    { ...input, userRequest: '' }, { ...input, userRequest: 'x'.repeat(20_001) }, { ...input, title: 'x'.repeat(121) },
    { ...input, createdAt: '2026-02-30T00:00:00.000Z' }, { ...input, startedAt: '2027-01-01T00:00:00.000Z' },
    { ...input, completedAt: 'today' }, { ...input, executionMode: 'run' }, { ...input, steps: [] }, { ...input, steps: Array(6).fill(input.steps[0]) },
    ...['apiKey', 'Authorization', 'env', 'connection', 'response', 'path', 'fileName', 'stack'].map((field) => ({ ...input, [field]: 'secret' })),
    ...[{ retryCount: 2 }, { retryCount: -1 }, { fallbackCount: 2 }, { status: 'failed' }, { id: '../x' }, { role: 'admin' },
      { assignedProvider: { id: 1, displayName: 'x' } }, { assignedProvider: { id: 'valid', displayName: 'AI', apiKey: 'fake' } },
      { output: String.fromCharCode(0xd800) }, { output: '' }, { output: 'x'.repeat(200_001) }, { completedAt: time, startedAt: input.completedAt },
      { originalProvider: {} }, { promise: {} }].map((fields) => ({ ...input, steps: [{ ...input.steps[0], ...fields }, input.steps[1]] })),
    { ...input, steps: [input.steps[1], input.steps[1]] },
  ];
  for (const value of invalid) await assert.rejects(store.save(value), fails('invalid'));
  assert.deepEqual(await fs.readdir(directory), []);
});
test('record byte limit rejects oversized JSON without truncating outputs', async (t) => {
  const { store, directory } = await setup(t); const input = record();
  input.finalResult = '한'.repeat(200_000);
  input.steps = Array.from({ length: 5 }, () => ({ ...input.steps[1]!, id: randomUUID(), output: input.finalResult }));
  await assert.rejects(store.save(input), fails('too_large')); assert.deepEqual(await fs.readdir(directory), []);
});
test('throwing accessors fail safely before serialization or writing', async (t) => {
  const { store, directory } = await setup(t); const input = record();
  Object.defineProperty(input, 'userRequest', { get: () => { throw new Error('private-key stack'); }, enumerable: true });
  await assert.rejects(store.save(input), fails('invalid')); assert.deepEqual(await fs.readdir(directory), []);
});
for (const kind of ['unavailable', 'availability-error', 'encrypt-error', 'empty-cipher'] as const) {
  test(`encryption ${kind} refuses storage without plaintext fallback`, async (t) => {
    const cipher: SecretEncryption = { ...encryption,
      isAvailable: async () => { if (kind === 'availability-error') throw new Error('private'); return kind !== 'unavailable'; },
      encrypt: async () => { if (kind === 'empty-cipher') return Buffer.alloc(0); throw new Error('private'); },
    };
    const { store, directory } = await setup(t, cipher);
    await assert.rejects(store.save(record()), fails('encryption')); assert.deepEqual(await fs.readdir(directory), []);
  });
}
test('same ID is idempotent under concurrent requests and changed content cannot overwrite it', async (t) => {
  const { store, folder } = await setup(t); const input = record();
  await Promise.all(Array.from({ length: 6 }, () => store.save(input)));
  assert.deepEqual(await fs.readdir(folder), [`${input.id}.loop`]);
  const before = await fs.readFile(path.join(folder, `${input.id}.loop`)); await store.save(input);
  assert.deepEqual(await fs.readFile(path.join(folder, `${input.id}.loop`)), before);
  await assert.rejects(store.save({ ...input, title: 'changed' }), fails('conflict')); assert.deepEqual(await store.get(input.id), input);
});
test('save takes its own snapshot before queuing', async (t) => {
  const { store } = await setup(t); const input = record(); const expected = structuredClone(input);
  const saving = store.save(input); Object.assign(input.steps[0]!.assignedProvider, { displayName: 'mutated' }); input.title = 'mutated';
  await saving; assert.deepEqual(await store.get(expected.id), expected);
});
test('exclusive publication handles two store instances saving the same ID without replacement', async (t) => {
  const { store, directory, folder } = await setup(t); const input = record();
  await Promise.all([store.save(input), new LoopHistoryStore(directory, encryption).save(input)]);
  assert.deepEqual(await fs.readdir(folder), [`${input.id}.loop`]);
});
test('empty list and missing detail are safe; summaries sort by completion and exclude full content', async (t) => {
  const { store } = await setup(t); assert.deepEqual(await store.list(), { items: [], partial: false });
  await assert.rejects(store.get(randomUUID()), fails('missing'));
  const old = record(); const recent = record('2026-10-14T01:00:00.000Z'); await store.save(old); await store.save(recent);
  const list = await store.list(); assert.deepEqual(list, { items: [historySummary(recent), historySummary(old)], partial: false });
  assert.doesNotMatch(JSON.stringify(list), /userRequest|finalResult|output|"steps"/);
});
test('delete affects only selected history, preserves credentials and persists after restart', async (t) => {
  const { store, directory } = await setup(t); const first = record(); const second = record();
  const credential = path.join(directory, 'openai-compatible-connection.json'); await fs.writeFile(credential, 'fake encrypted fixture');
  await store.save(first); await store.save(second); await store.remove(first.id); await store.remove(first.id);
  const restarted = new LoopHistoryStore(directory, encryption);
  await assert.rejects(restarted.get(first.id), fails('missing')); assert.deepEqual(await restarted.get(second.id), second);
  assert.equal(await fs.readFile(credential, 'utf8'), 'fake encrypted fixture'); assert.equal((await restarted.list()).items.length, 1);
});
for (const id of ['../credential', '..\\file', '/tmp/file', 'C:\\private', 'file.loop', '', '00000000-0000-0000-0000-000000000000']) {
  test(`unsafe ID ${JSON.stringify(id)} cannot save/read/delete files`, async (t) => {
    const { store, directory } = await setup(t);
    await assert.rejects(store.get(id), fails('invalid')); await assert.rejects(store.remove(id), fails('invalid'));
    await assert.rejects(store.save({ ...record(), id }), fails('invalid')); assert.deepEqual(await fs.readdir(directory), []);
  });
}
test('corrupt, unknown-version, wrong-ID and plaintext files do not hide normal history or get deleted', async (t) => {
  const { store, folder } = await setup(t); const good = record(); await store.save(good);
  const bad = record(); const future = record(); const wrong = record(); const plain = record();
  await fs.writeFile(path.join(folder, `${bad.id}.loop`), randomBytes(20));
  await fs.writeFile(path.join(folder, `${future.id}.loop`), await encryption.encrypt(JSON.stringify({ ...future, schemaVersion: 9 })));
  await fs.writeFile(path.join(folder, `${wrong.id}.loop`), await encryption.encrypt(JSON.stringify(good)));
  await fs.writeFile(path.join(folder, `${plain.id}.loop`), JSON.stringify(plain));
  assert.deepEqual(await store.list(), { items: [historySummary(good)], partial: true });
  for (const item of [bad, future, wrong, plain]) {
    await assert.rejects(store.get(item.id), fails(item === future ? 'version' : 'corrupt'));
    await assert.rejects(store.remove(item.id)); await assert.rejects(store.save(item));
  }
  assert.equal((await fs.readdir(folder)).length, 5);
});
test('decrypt errors are isolated and do not leak private exceptions', async (t) => {
  const { store, directory } = await setup(t); const input = record(); await store.save(input);
  const broken = new LoopHistoryStore(directory, { ...encryption, decrypt: async () => { throw new Error('fake-key raw stack'); } });
  await assert.rejects(broken.get(input.id), fails('corrupt')); assert.deepEqual(await broken.list(), { items: [], partial: true });
});
test('maximum count refuses new IDs, keeps all old records and allows idempotent save', async (t) => {
  const { store, folder } = await setup(t); const first = record(); await store.save(first);
  for (let i = 1; i < HISTORY_LIMIT - 1; i++) await store.save(record());
  const concurrent = await Promise.allSettled([store.save(record()), store.save(record())]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'rejected' && fails('limit')(result.reason)).length, 1);
  await assert.rejects(store.save(record()), fails('limit')); await store.save(first);
  assert.equal((await store.list()).items.length, HISTORY_LIMIT); assert.equal((await fs.readdir(folder)).length, HISTORY_LIMIT);
});
for (const operation of ['mkdir', 'open', 'link'] as const) {
  test(`${operation} write failure publishes no file and preserves original result`, async (t) => {
    const files = { ...fs, [operation]: async () => { throw Object.assign(new Error('private path key stack'), { code: 'EACCES' }); } };
    const { store, folder } = await setup(t, encryption, files); const input = record(); const before = structuredClone(input);
    await assert.rejects(store.save(input), fails('unavailable')); assert.deepEqual(input, before);
    assert.deepEqual(await fs.readdir(folder).catch(() => []), []);
  });
}
test('mid-write failure removes temporary file and never publishes partial ciphertext', async (t) => {
  const files = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (args[1] === 'wx') handle.writeFile = async () => { throw new Error('disk full'); };
    return handle;
  } };
  const { store, folder } = await setup(t, encryption, files);
  await assert.rejects(store.save(record()), fails('unavailable')); assert.deepEqual(await fs.readdir(folder), []);
});
test('read and delete failures return safe errors while preserving files', async (t) => {
  const { store, directory, folder } = await setup(t); const input = record(); await store.save(input);
  const brokenRead = new LoopHistoryStore(directory, encryption, { ...fs, open: async () => { throw new Error('private'); } });
  await assert.rejects(brokenRead.get(input.id), fails('unavailable')); assert.deepEqual(await brokenRead.list(), { items: [], partial: true });
  const brokenDelete = new LoopHistoryStore(directory, encryption, { ...fs, unlink: async () => { throw new Error('private'); } });
  await assert.rejects(brokenDelete.remove(input.id), fails('unavailable')); assert.equal((await fs.readdir(folder)).length, 1);
});
test('directory-read failure returns safe error rather than a fabricated empty list', async (t) => {
  const { directory, store } = await setup(t); await store.save(record());
  const broken = new LoopHistoryStore(directory, encryption, { ...fs, readdir: (async () => { throw new Error('private'); }) as typeof fs.readdir });
  await assert.rejects(broken.list(), fails('unavailable'));
});
test('close drains accepted writes and refuses new work', async (t) => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const { store, directory } = await setup(t, { ...encryption, encrypt: async (text) => { await gate; return encryption.encrypt(text); } });
  const input = record(); const save = store.save(input); assert.equal(store.pending, true);
  const closing = store.close(); await assert.rejects(store.list(), fails('unavailable'));
  release(); await save; await closing; assert.equal(store.pending, false);
  assert.deepEqual(await new LoopHistoryStore(directory, encryption).get(input.id), input);
});
test('excess work is rejected instead of retaining an unbounded queue of snapshots', async (t) => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const { store } = await setup(t, { ...encryption, encrypt: async (text) => { await gate; return encryption.encrypt(text); } });
  const saves = Array.from({ length: 8 }, () => store.save(record()));
  await assert.rejects(store.save(record()), fails('unavailable'));
  release(); await Promise.all(saves); assert.equal((await store.list()).items.length, 8);
});
test('oversized encrypted file and directory replacement are rejected without reading outside the store', async (t) => {
  const { store, folder, directory } = await setup(t); const good = record(); await store.save(good);
  const huge = randomUUID(); await fs.writeFile(path.join(folder, `${huge}.loop`), Buffer.alloc(3 * 1024 * 1024));
  await assert.rejects(store.get(huge), fails('corrupt'));
  assert.deepEqual(await store.list(), { items: [historySummary(good)], partial: true });
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  const linkProfile = path.join(directory, 'linked-profile'); await fs.mkdir(linkProfile);
  await fs.symlink(outside, path.join(linkProfile, HISTORY_DIRECTORY), 'junction');
  const linked = new LoopHistoryStore(linkProfile, encryption);
  await assert.rejects(linked.list(), fails('unavailable'));
  await assert.rejects(linked.save(record()), fails('unavailable'));
  assert.deepEqual(await fs.readdir(outside), []);
});
test('history operations preserve completed Loop and allow Markdown export, with zero fetch calls', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('History must never call AI'); });
  const loop = historyLoop(record()); const before = structuredClone(loop); const { store } = await setup(t);
  const bridge: HistoryBridge = { saveHistory: async (data) => ({ ok: true, value: await store.save(data) }),
    listHistory: async () => ({ ok: true, value: await store.list() }), getHistory: async (id) => ({ ok: true, value: await store.get(id) }),
    deleteHistory: async (id) => ({ ok: true, value: await store.remove(id) }) };
  assert.equal((await saveCompletedHistory(loop, bridge)).ok, true); await bridge.listHistory(); assert.equal((await bridge.getHistory(loop.id)).ok, true);
  for (const saveHistory of [async () => ({ ok: false as const, code: 'encryption' as const }), async () => { throw new Error('private stack'); }]) {
    assert.equal((await saveCompletedHistory(loop, { ...bridge, saveHistory })).ok, false); assert.deepEqual(loop, before);
  }
  assert.deepEqual(await exportCompletedResult(loop, { exportMarkdown: async () => ({ status: 'saved' }) }), { status: 'saved' });
  await bridge.deleteHistory(loop.id); assert.deepEqual(loop, before);
  for (const code of ['limit', 'too_large', 'encryption', 'unavailable'] as const) assert.ok(historySaveMessage(code).length > 0);
});
test('history IPC validates owning main frame, URL, argument count and maps errors safely', async (t) => {
  const { store } = await setup(t);
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = { handle: (name, handler) => { handlers.set(name, handler); }, removeHandler: (name) => { handlers.delete(name); } };
  const frame = { url: 'file:///app/index.html' }; let destroyed = false;
  const contents = { mainFrame: frame, isDestroyed: () => destroyed } as unknown as WebContents;
  const remove = registerHistoryIpc(ipc, contents, frame.url, store);
  assert.deepEqual([...handlers.keys()], ['save', 'list', 'get', 'delete'].map((name) => `seohokim-loop:history:${name}`));
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent; const input = record();
  for (const [name, handler] of handlers) {
    const args = name.endsWith(':list') ? [] : [name.endsWith(':save') ? input : input.id];
    for (const candidate of [{ ...event, sender: {} }, { ...event, senderFrame: null }, { ...event, senderFrame: { url: frame.url } }]) {
      assert.deepEqual(await handler(candidate as IpcMainInvokeEvent, ...args), { ok: false, code: 'invalid' });
    }
    assert.deepEqual(await handler(event, ...args, 'C:/private'), { ok: false, code: 'invalid' });
    frame.url = 'https://untrusted.test'; assert.deepEqual(await handler(event, ...args), { ok: false, code: 'invalid' }); frame.url = 'file:///app/index.html';
    destroyed = true; assert.deepEqual(await handler(event, ...args), { ok: false, code: 'invalid' }); destroyed = false;
  }
  assert.deepEqual(await handlers.get('seohokim-loop:history:save')!(event, { ...input, apiKey: 'fake-secret' }), { ok: false, code: 'invalid' });
  assert.deepEqual(await handlers.get('seohokim-loop:history:save')!(event, input), { ok: true, value: historySummary(input) });
  assert.deepEqual(await handlers.get('seohokim-loop:history:get')!(event, input.id), { ok: true, value: input });
  t.mock.method(store, 'list', async () => { throw new Error('fake-key private-path stack'); });
  assert.deepEqual(await handlers.get('seohokim-loop:history:list')!(event), { ok: false, code: 'unavailable' });
  remove(); assert.equal(handlers.size, 0);
});

const searchCases: [string, string, number[]][] = [
  ['exact title', '전기차 시장 비교 2026', [0]], ['partial title', '시장 비교', [0]],
  ['original request', '물류 운영 개선', [1]], ['Korean', '배터리', [2]],
  ['English', 'Logistics', [1]], ['uppercase', 'AI', [1]], ['lowercase', 'ai', [1]],
  ['numbers', '2026', [0]], ['literal regex symbols', '.*+?[]()\\$^', [2]],
  ['trimmed whitespace', '  전기차 \t\n', [2, 0]], ['empty query', '', [2, 1, 0]],
  ['only whitespace', ' \t\n ', [2, 1, 0]], ['no result', '찾을 수 없는 단어', []],
  ['multiple matches', '전기차', [2, 0]], ['HTML text', '<script>', [2]],
];
for (const [name, query, indices] of searchCases) {
  test(`local history search: ${name}`, async (t) => {
    const { store } = await setup(t);
    const records = [
      { ...record('2026-10-13T01:00:02.000Z'), title: '전기차 시장 비교 2026', userRequest: '시장 조사' },
      { ...record('2026-10-13T01:00:03.000Z'), title: 'AI Logistics Report', userRequest: '물류 운영 개선 방안' },
      { ...record('2026-10-13T01:00:04.000Z'), title: '배터리 기술', userRequest: '전기차 .*+?[]()\\$^ <script> 요청' },
    ];
    for (const item of records) await store.save(item);
    const result = await store.list({ query });
    assert.deepEqual(result, { items: indices.map((index) => historySummary(records[index]!)), partial: false, total: 3 });
    assert.deepEqual(await store.list({ query }), result);
    assert.doesNotMatch(JSON.stringify(result), /userRequest|finalResult|"output"|"steps"|apiKey|Authorization/);
  });
}
test('search matches only title or request, never output, step title or provider identity', async (t) => {
  const { store } = await setup(t); const item = record(); await store.save(item);
  for (const query of ['alert', '첫 단계 결과', '최종 정리', 'provider-b', '다른 AI']) {
    assert.deepEqual(await store.list({ query }), { items: [], partial: false, total: 1 });
  }
});
test('search keeps deterministic ID order when completion times are equal and fields do not form a joined match', async (t) => {
  const { store } = await setup(t); const a = { ...record(), title: 'match END', userRequest: 'START match' };
  const b = { ...record(), title: 'match', userRequest: 'other request' };
  await store.save(a); await store.save(b);
  assert.deepEqual((await store.list({ query: 'match' })).items.map((item) => item.id), [a.id, b.id].sort());
  assert.equal((await store.list({ query: 'ENDSTART' })).items.length, 0);
});
test('100-record typing uses the existing main projection without disk reads or repeated decryption', async (t) => {
  let decryptions = 0; let reads = 0;
  const { store } = await setup(t, { ...encryption, decrypt: async (data) => { decryptions++; return encryption.decrypt(data); } },
    { ...fs, open: async (...args: Parameters<typeof fs.open>) => { if (args[1] === 'r') reads++; return fs.open(...args); } });
  for (let i = 0; i < HISTORY_LIMIT; i++) await store.save({ ...record(), title: `search ${i}` });
  await store.list(); const before = { reads, decryptions }; assert.equal(reads, HISTORY_LIMIT);
  for (const query of ['s', 'se', 'sea', 'sear', 'search', 'search 2', '', '한글', '[]', 'search']) await store.list({ query });
  assert.deepEqual({ reads, decryptions }, before);
  const modified = await store.list({ query: 'search' }); modified.items[0]!.title = 'poisoned'; modified.items[0]!.providers[0]!.displayName = 'poisoned';
  assert.doesNotMatch(JSON.stringify(await store.list({ query: 'search' })), /poisoned/);
});
test('search projection refreshes after save, delete, and idempotent re-save without altering other files', async (t) => {
  const { store, directory, folder } = await setup(t); const first = record(); await store.save(first);
  const original = await fs.readFile(path.join(folder, `${first.id}.loop`));
  assert.equal((await store.list({ query: '' })).total, 1);
  const second = { ...record(), title: 'new matching' }; await store.save(second);
  assert.equal((await store.list({ query: 'matching' })).items[0]!.id, second.id);
  await store.remove(second.id); assert.equal((await store.list({ query: 'matching' })).items.length, 0);
  const external = { ...record(), title: 'external matching' }; await new LoopHistoryStore(directory, encryption).save(external);
  await store.save(external); // Lost acknowledgement / another writer must also invalidate the projection.
  assert.equal((await store.list({ query: 'external' })).items[0]!.id, external.id);
  assert.deepEqual(await fs.readFile(path.join(folder, `${first.id}.loop`)), original);
});
test('explicit list refresh detects external corruption, isolates it and keeps normal search results', async (t) => {
  const { store, folder } = await setup(t); const good = record(); const bad = record();
  await store.save(good); await store.save(bad); await store.list();
  await fs.writeFile(path.join(folder, `${bad.id}.loop`), 'corrupt fixture');
  await store.list();
  assert.deepEqual(await store.list({ query: '작업' }), { items: [historySummary(good)], partial: true, total: 1 });
  assert.equal(await fs.readFile(path.join(folder, `${bad.id}.loop`), 'utf8'), 'corrupt fixture');
});
test('failed refresh clears the search projection instead of serving stale results', async (t) => {
  let broken = false;
  const files = { ...fs, readdir: (async (...args: Parameters<typeof fs.readdir>) => {
    if (broken) throw new Error('private path stack'); return fs.readdir(...args);
  }) as typeof fs.readdir };
  const { store } = await setup(t, encryption, files); await store.save(record()); await store.list(); broken = true;
  await assert.rejects(store.list(), fails('unavailable'));
  await assert.rejects(store.list({ query: '작업' }), fails('unavailable'));
});
test('search, detail and export remain local, encrypted and read-only across store restart', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { assert.fail('Search must never call AI or a search service'); });
  const { store, directory, folder } = await setup(t); const item = record(); await store.save(item);
  const credential = path.join(directory, 'openai-compatible-connection.json'); await fs.writeFile(credential, 'fake credential fixture');
  const bytes = await fs.readFile(path.join(folder, `${item.id}.loop`));
  const restarted = new LoopHistoryStore(directory, encryption);
  const match = (await restarted.list({ query: '원본 사용자' })).items[0]!;
  assert.deepEqual(await restarted.get(match.id), item);
  assert.deepEqual(await exportCompletedResult(historyLoop(await restarted.get(match.id)), { exportMarkdown: async () => ({ status: 'saved' }) }), { status: 'saved' });
  assert.deepEqual(await fs.readFile(path.join(folder, `${item.id}.loop`)), bytes);
  assert.ok(!bytes.includes(Buffer.from(item.userRequest))); assert.ok(!bytes.includes(Buffer.from(item.finalResult)));
  assert.deepEqual(await fs.readdir(folder), [`${item.id}.loop`]); assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await fs.readFile(credential, 'utf8'), 'fake credential fixture');
});
test('empty history and zero matches have distinct search totals; closed store refuses cached search', async (t) => {
  const { store } = await setup(t);
  assert.deepEqual(await store.list({ query: 'none' }), { items: [], partial: false, total: 0 });
  await store.save(record()); assert.deepEqual(await store.list({ query: 'none' }), { items: [], partial: false, total: 1 });
  await store.close(); await assert.rejects(store.list({ query: '' }), fails('unavailable'));
});
test('search IPC reuses the list channel with strict optional query shape and the existing caller boundary', async (t) => {
  const { store, directory } = await setup(t);
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = { handle: (name, handler) => { handlers.set(name, handler); }, removeHandler: (name) => { handlers.delete(name); } };
  const frame = { url: 'file:///app/index.html' }; const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
  registerHistoryIpc(ipc, contents, frame.url, store);
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
  const list = handlers.get('seohokim-loop:history:list')!;
  for (const input of [null, [], '', 'query', {}, { query: 1 }, { query: 'x'.repeat(201) }, { query: '', path: 'private' },
    { query: '', url: 'https://example.test' }, { query: '', apiKey: 'fake' }, { get query() { throw new Error('private'); } }]) {
    assert.deepEqual(await list(event, input), { ok: false, code: 'invalid' });
  }
  assert.deepEqual(await list(event, { query: '' }, {}), { ok: false, code: 'invalid' });
  assert.deepEqual(await list({ ...event, senderFrame: null } as IpcMainInvokeEvent, { query: '' }), { ok: false, code: 'invalid' });
  assert.deepEqual(await list(event, { query: '' }), { ok: true, value: { items: [], partial: false, total: 0 } });
  assert.deepEqual(await list(event), { ok: true, value: { items: [], partial: false } });
  assert.deepEqual(await fs.readdir(directory), []);
});
