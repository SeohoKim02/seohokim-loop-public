// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

// Fake executable only: no model, auth files, networking or user workspace access.
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
const [scenarioFile, trace, ...args] = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.160.1'); process.exit(0); }
if (args.includes('--help')) { console.log('--json --ephemeral --ignore-user-config --ignore-rules --strict-config --sandbox --skip-git-repo-check --stdio'); process.exit(0); }
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
if (args[0] === 'app-server') { assert.equal(input, ''); process.exit(0); }
assert.equal(args[0], 'exec'); assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
assert.ok(args.includes('forced_login_method="chatgpt"')); assert.ok(args.includes('features.shell_tool=false'));
assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--ignore-rules'));
assert.equal(Object.keys(process.env).some(key => /API_KEY|TOKEN/i.test(key)), false);
const data = JSON.parse(input.slice(input.indexOf('\n') + 1));
assert.ok(input.startsWith('Provide a text answer')); assert.match(input, /untrusted data/);
const scenario = (await readFile(scenarioFile, 'utf8')).trim();
await appendFile(trace, JSON.stringify({ provider: 'codex-cli-local', data, pid: process.pid, cwd: process.cwd() }) + '\n');
if (scenario === 'review-hang') { setInterval(() => {}, 1000); }
else if (scenario === 'review-failure') { console.error('private-fixture-secret'); process.exitCode = 2; }
else {
  const output = `FAKE 검토: ${data.request} — 누락된 날짜를 확인하세요. 검토 의견은 오류가 있을 수 있습니다.`;
  for (const event of [{ type: 'thread.started', thread_id: 'fake-review-thread' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'review', type: 'agent_message', text: output, phase: 'final_answer' } },
    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }]) console.log(JSON.stringify(event));
}
