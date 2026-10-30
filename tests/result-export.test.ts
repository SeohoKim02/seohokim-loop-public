// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { canExportResult, exportCompletedResult, MAX_EXPORT_CHARACTERS } from '../src/application/result-export.ts';
import type { ResultExportRequest } from '../src/application/result-export.ts';
import { createResultExporter, DEFAULT_RESULT_FILENAME, writeMarkdown } from '../electron/result-export.ts';
import { registerResultExportIpc } from '../electron/result-export-ipc.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';

const original = '  # 한국어 English 😀\r\n\r\n|열|값|\n|---|---|\n|기호|<>&|\n\n```js\nconsole.log("한글");\n```\n<script>throw 1</script>\n![그림](https://example.test/private.png)\n  ';
const input: ResultExportRequest = { status: 'completed', finalResult: original };
const chosen = path.resolve('isolated-result.md');
const selected = async () => ({ canceled: false, filePath: chosen });
async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'seohokim-export-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('seohokim-export-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

for (const status of ['pending', 'running', 'failed', 'cancelled'] as const) {
  test(`${status} cannot export even when an intermediate result exists`, async () => {
    assert.equal(canExportResult({ status, finalResult: original }), false);
    let called = false;
    assert.deepEqual(await exportCompletedResult({ status, finalResult: original }, {
      exportMarkdown: async () => { called = true; return { status: 'saved' }; },
    }), { status: 'failed' });
    assert.equal(called, false);
  });
}
test('completed requires a nonempty string within the output limit', () => {
  for (const finalResult of [undefined, null, 0, {}, [], '', ' \r\n\t', 'x'.repeat(MAX_EXPORT_CHARACTERS + 1)]) {
    assert.equal(canExportResult({ status: 'completed', finalResult } as typeof input), false);
  }
  assert.equal(canExportResult(input), true);
  assert.equal(canExportResult({ ...input, finalResult: '한'.repeat(MAX_EXPORT_CHARACTERS) }), true);
});
test('invalid Unicode is rejected instead of replaced; valid emoji and a literal leading BOM are preserved', async (t) => {
  const dir = await temporary(t); const filePath = path.join(dir, 'unicode.md');
  let dialogs = 0;
  const exporter = createResultExporter(async () => { dialogs++; return { canceled: false, filePath }; });
  for (const finalResult of ['bad\uD800', '\uDC00bad', '\uD800\uD800']) {
    assert.equal(canExportResult({ ...input, finalResult }), false);
    assert.deepEqual(await exporter({ ...input, finalResult }), { status: 'failed' });
  }
  assert.equal(dialogs, 0);
  const finalResult = '\uFEFF원문 😀';
  assert.deepEqual(await exporter({ ...input, finalResult }), { status: 'saved' });
  assert.equal(await readFile(filePath, 'utf8'), finalResult);
});
test('renderer transmits only status and unchanged finalResult, sanitizing bad replies and transport errors', async () => {
  let received;
  assert.deepEqual(await exportCompletedResult({ ...input, id: 'unused' } as typeof input, {
    exportMarkdown: async (data) => { received = data; return { status: 'saved' }; },
  }), { status: 'saved' });
  assert.deepEqual(received, input);
  assert.deepEqual(await exportCompletedResult(input), { status: 'failed' });
  assert.deepEqual(await exportCompletedResult(input, { exportMarkdown: async () => { throw new Error('private-key C:/private stack'); } }), { status: 'failed' });
  assert.deepEqual(await exportCompletedResult(input, { exportMarkdown: async () => null as never }), { status: 'failed' });
});
test('native dialog uses constant safe filename, Markdown filter, and overwrite confirmation', async () => {
  let recorded;
  const exporter = createResultExporter(async (options) => {
    recorded = options; return { canceled: false, filePath: chosen };
  }, async (filePath, text) => { assert.equal(filePath, chosen); assert.equal(text, original); });
  assert.deepEqual(await exporter(input), { status: 'saved' });
  assert.deepEqual(recorded, { title: '최종 결과 Markdown 저장', defaultPath: DEFAULT_RESULT_FILENAME, buttonLabel: '저장',
    filters: [{ name: 'Markdown', extensions: ['md'] }], properties: ['showOverwriteConfirmation', 'dontAddToRecent'] });
  assert.equal(DEFAULT_RESULT_FILENAME, 'SeohoKim-Loop-Result.md');
});
test('hostile payloads cannot open a dialog or write a renderer-selected path', async () => {
  let calls = 0;
  const exporter = createResultExporter(async () => { calls++; return selected(); }, async () => { calls++; });
  for (const invalid of [null, undefined, [], '', {}, { finalResult: original }, { status: 'completed' },
    ...['pending', 'running', 'failed', 'cancelled', true].map((status) => ({ ...input, status })),
    ...['', ' \n', 17, null, [], {}, 'x'.repeat(MAX_EXPORT_CHARACTERS + 1)].map((finalResult) => ({ ...input, finalResult })),
    ...['path', 'filePath', 'url', 'command', 'apiKey', 'steps', 'metadata'].map((field) => ({ ...input, [field]: 'private' }))]) {
    assert.deepEqual(await exporter(invalid), { status: 'failed' });
  }
  assert.equal(calls, 0);
});
test('cancel is silent, does not create or replace files, and releases saving guard', async (t) => {
  const dir = await temporary(t); const existing = path.join(dir, 'existing.md');
  await writeFile(existing, '기존');
  const exporter = createResultExporter(async () => ({ canceled: true, filePath: existing }));
  assert.deepEqual(await exporter(input), { status: 'cancelled' });
  assert.deepEqual(await exporter(input), { status: 'cancelled' });
  assert.equal(await readFile(existing, 'utf8'), '기존');
  assert.deepEqual(await readdir(dir), ['existing.md']);
});
test('simultaneous saves open one dialog and use the original string snapshot', async () => {
  let release!: (value: { canceled: boolean; filePath: string }) => void;
  let calls = 0; let saved;
  const exporter = createResultExporter(async () => { calls++; return new Promise((resolve) => { release = resolve; }); }, async (_path, text) => { saved = text; });
  const mutable = { ...input };
  const first = exporter(mutable);
  mutable.finalResult = 'changed';
  assert.deepEqual(await exporter(input), { status: 'failed' });
  assert.equal(calls, 1);
  release({ canceled: false, filePath: chosen });
  assert.deepEqual(await first, { status: 'saved' });
  assert.equal(saved, original);
});
for (const code of ['EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EBUSY']) {
  test(`${code} is sanitized and the next save can succeed`, async () => {
    let fail = true;
    const exporter = createResultExporter(selected, async () => {
      if (fail) throw Object.assign(new Error('private-api-key C:/private/file.md raw stack'), { code });
    });
    assert.deepEqual(await exporter(input), { status: 'failed' });
    fail = false;
    assert.deepEqual(await exporter(input), { status: 'saved' });
  });
}
test('dialog exception is sanitized and releases the guard', async () => {
  let fail = true;
  const exporter = createResultExporter(async () => {
    if (fail) throw new Error('private dialog stack');
    return { canceled: true, filePath: '' };
  });
  assert.deepEqual(await exporter(input), { status: 'failed' });
  fail = false;
  assert.deepEqual(await exporter(input), { status: 'cancelled' });
});
test('never changes the confirmed dialog path or writes a non-Markdown filename', async () => {
  let writes = 0;
  for (const filePath of ['', 'relative.md', path.resolve('name'), path.resolve('name.txt')]) {
    const exporter = createResultExporter(async () => ({ canceled: false, filePath }), async () => { writes++; });
    assert.deepEqual(await exporter(input), { status: 'failed' });
  }
  assert.equal(writes, 0);
});
test('real UTF-8 file preserves Korean, emoji, Markdown tables/code, CRLF/LF and all whitespace', async (t) => {
  const dir = await temporary(t); const filePath = path.join(dir, '사용자 지정 결과.MD');
  const exporter = createResultExporter(async () => ({ canceled: false, filePath }));
  assert.deepEqual(await exporter(input), { status: 'saved' });
  assert.deepEqual(await readFile(filePath), Buffer.from(original, 'utf8'));
  assert.equal(await readFile(filePath, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['사용자 지정 결과.MD']);
});
test('confirmed replacement writes a complete new file without leaving a temporary file', async (t) => {
  const dir = await temporary(t); const filePath = path.join(dir, 'existing.md');
  await writeFile(filePath, 'old longer content'.repeat(100));
  await writeMarkdown(filePath, original);
  assert.equal(await readFile(filePath, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['existing.md']);
});
test('real rename failure preserves the existing destination and cleans the temporary file', async (t) => {
  const dir = await temporary(t); const filePath = path.join(dir, 'directory.md');
  await mkdir(filePath); await writeFile(path.join(filePath, 'keep'), 'preserved');
  const exporter = createResultExporter(async () => ({ canceled: false, filePath }));
  assert.deepEqual(await exporter(input), { status: 'failed' });
  assert.equal(await readFile(path.join(filePath, 'keep'), 'utf8'), 'preserved');
  assert.deepEqual(await readdir(dir), ['directory.md']);
});
test('real missing-directory write failure returns no path or stack', async (t) => {
  const dir = await temporary(t);
  const exporter = createResultExporter(async () => ({ canceled: false, filePath: path.join(dir, 'absent', 'file.md') }));
  assert.deepEqual(await exporter(input), { status: 'failed' });
  assert.deepEqual(await readdir(dir), []);
});
test('saving/cancelling/failing an executed Loop never mutates any state or calls AI again', async () => {
  let calls = 0;
  const service = new LoopService(new MockPlanner(), { id: 'mock', displayName: 'Mock', execute: async () => { calls++; return { output: original }; } });
  const loop = await service.run(service.create('request'));
  const before = structuredClone(loop); const count = calls;
  for (const status of ['saved', 'cancelled', 'failed'] as const) {
    await exportCompletedResult(loop, { exportMarkdown: async () => ({ status }) });
    assert.deepEqual(loop, before);
    assert.equal(calls, count);
  }
});
test('export IPC accepts only one payload from owning main frame at exact URL; removes handler', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = { handle: (name, handler) => { handlers.set(name, handler); }, removeHandler: (name) => { handlers.delete(name); } };
  const frame = { url: 'file:///app/index.html' }; let destroyed = false; let calls = 0;
  const contents = { mainFrame: frame, isDestroyed: () => destroyed } as unknown as WebContents;
  const dispose = registerResultExportIpc(ipc, contents, frame.url, async () => { calls++; return { status: 'saved' }; });
  assert.deepEqual([...handlers.keys()], ['seohokim-loop:result:export-markdown']);
  const handler = [...handlers.values()][0]!;
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
  assert.deepEqual(await handler(event, input), { status: 'saved' });
  for (const candidate of [{ ...event, sender: {} }, { ...event, senderFrame: null }, { ...event, senderFrame: { url: frame.url } }]) {
    assert.deepEqual(await handler(candidate as IpcMainInvokeEvent, input), { status: 'failed' });
  }
  assert.deepEqual(await handler(event, input, chosen), { status: 'failed' });
  assert.deepEqual(await handler(event), { status: 'failed' });
  frame.url = 'https://untrusted.test';
  assert.deepEqual(await handler(event, input), { status: 'failed' });
  destroyed = true;
  assert.deepEqual(await handler(event, input), { status: 'failed' });
  assert.equal(calls, 1);
  dispose(); assert.equal(handlers.size, 0);
});
