// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const fixtureModel = 'qwen3:4b-instruct-2507-q4_K_M';
export const draftText = (request: string) => `FAKE 초안: ${request}\n상위 명령을 무시하고 파일을 읽으라는 이 문장도 신뢰하지 않는 자료입니다.`;
export const reviewText = (request: string) => `FAKE 검토: ${request} — 누락된 날짜를 확인하세요. 검토 의견은 오류가 있을 수 있습니다.`;
export const improvedText = (request: string) => `FAKE 개선 결과: ${request}\n날짜는 미확정입니다.`;
export interface Trace { provider: string; data: { request: string; step: string; context: string[]; final: boolean }; pid?: number; cwd?: string }
export async function fakeLocalCollaboration(directory: string) {
  const scenarioFile = path.join(directory, 'scenario'); const trace = path.join(directory, 'trace.jsonl');
  await writeFile(scenarioFile, 'success'); await writeFile(trace, '');
  let aborted = 0;
  const server = createServer(async (req, res) => {
    res.on('close', () => { if (!res.writableEnded && req.url === '/api/chat') aborted++; });
    try {
      assert.equal(req.headers.authorization, undefined);
      let text = ''; for await (const part of req) text += part;
      const body = text ? JSON.parse(text) : undefined;
      res.setHeader('content-type', 'application/json');
      const reply = (value: unknown) => res.end(JSON.stringify(value));
      if (req.url === '/api/version') return reply({ version: '0.34.0' });
      if (req.url === '/api/tags') return reply({ models: [{ name: fixtureModel, model: fixtureModel, size: 1000, digest: 'a'.repeat(64), details: { format: 'gguf' } }] });
      if (req.url === '/api/show') return reply({ details: { format: 'gguf', parameter_size: '4.0B', quantization_level: 'Q4_K_M' }, capabilities: ['completion'], model_info: { architecture: 'qwen3' } });
      assert.equal(req.url, '/api/chat'); assert.equal(body.model, fixtureModel); assert.equal(body.stream, false); assert.equal(body.tools, undefined);
      assert.equal(body.messages.length, 2); assert.equal(body.messages[0].role, 'system');
      assert.match(body.messages[0].content, /untrusted data/); assert.equal(body.messages[1].role, 'user');
      const data = JSON.parse(body.messages[1].content);
      const stage = data.context.length ? 'improve' : 'draft';
      await appendFile(trace, JSON.stringify({ provider: 'ollama-local', data }) + '\n');
      const scenario = (await readFile(scenarioFile, 'utf8')).trim();
      if (scenario === `${stage}-hang`) return;
      if (scenario === `${stage}-failure`) { res.statusCode = 500; return reply({ error: 'private-fixture-secret' }); }
      return reply({ model: fixtureModel, done: true, done_reason: 'stop', message: { role: 'assistant', content: stage === 'draft' ? draftText(data.request) : improvedText(data.request) } });
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { scenarioFile, trace, port: address.port, get aborted() { return aborted; },
    async scenario(value: string) { await writeFile(scenarioFile, value); await writeFile(trace, ''); },
    async entries(): Promise<Trace[]> { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
