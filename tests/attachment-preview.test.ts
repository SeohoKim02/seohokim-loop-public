// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type { TextAttachment } from '../src/providers/text-attachments.ts';

// Use the existing JSX pipeline; no DOM emulator or new test dependency.
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const { AttachmentPreview } = await server.ssrLoadModule('/src/ui/AttachmentPreview.tsx') as typeof import('../src/ui/AttachmentPreview.tsx');
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const file = (type: TextAttachment['type'], text: string): TextAttachment => Object.freeze({
  id: '00000000-0000-4000-8000-000000000001', name: `report.${type}`, type, text, size: Buffer.byteLength(text),
});
const render = (attachment: TextAttachment) => renderToStaticMarkup(createElement(AttachmentPreview, { file: attachment, onClose() {} }));
for (const type of ['txt', 'md', 'csv', 'json', 'pdf'] as const) test(`preview ${type}: complete original text, metadata and safe escaping`, () => {
  const text = (type === 'pdf' ? '[Page 1]\n' : '') + '\ufeff한국 English 123 😀 & < > " \'\r\n\r\n# 제목\n지역,값\n{"x":"y"}\n'
    + (type === 'pdf' ? '\n[Page 2]\n두 번째 페이지\n' : '끝 공백  ');
  const attachment = file(type, text); const before = JSON.stringify(attachment); const html = render(attachment);
  assert.equal(html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1], escape(text));
  assert.ok(html.includes(attachment.name)); assert.ok(html.includes(`${type.toUpperCase()} · ${text.length.toLocaleString()}자 · 읽기 전용`));
  assert.match(html, /<button type="button"[^>]*>미리보기 닫기<\/button>/);
  assert.equal(html.includes('표, 수식, 이미지'), type === 'pdf');
  assert.equal(JSON.stringify(attachment), before);
});
test('preview renders all 16,000 characters including the last line without truncation', () => {
  const text = '긴 문단\r\n'.repeat(2000).padEnd(15_990, 'x') + '\n마지막 내용 끝!';
  assert.equal(text.length, 16_000);
  assert.equal(render(file('txt', text)).match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1], escape(text));
});
test('preview treats HTML, Markdown URLs, JavaScript and shell commands as inert text', () => {
  const text = '<script>globalThis.previewExecuted=true</script><img src="https://example.invalid/x" onerror="alert(1)">\n'
    + '[link](https://example.invalid/) ![image](https://example.invalid/image)\n$(whoami); powershell -Command echo secret';
  const html = render(file('md', text));
  assert.equal(html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1], escape(text));
  assert.doesNotMatch(html, /<(script|img|a|iframe|input|textarea)\b|contenteditable/i);
  assert.equal((globalThis as Record<string, unknown>).previewExecuted, undefined);
});
test('preview allows an empty file without fabricating text', () => {
  assert.equal(render(file('json', '')).match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1], '');
});
test('preview view has no IO, storage, execution or credential dependencies', async () => {
  const source = await readFile(new URL('../src/ui/AttachmentPreview.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\beval\s*\(|new Function|fetch\s*\(|seohoKimLoop|electron|node:|localStorage|sessionStorage|console\.|apiKey/i);
  assert.equal(source.match(/^import /gm)?.length, 1);
  assert.match(source, /import type \{ TextAttachment \}/);
});
