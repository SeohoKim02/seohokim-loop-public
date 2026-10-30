// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

// Deterministic test process. Never calls an AI or reads authentication files.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const [scenario, marker, ...args] = process.argv.slice(2);
if (args.includes('--version')) { console.log(scenario === 'version' ? 'codex-cli 0.1.0' : 'codex-cli 0.160.1'); process.exit(0); }
if (args.includes('--help')) {
  console.log(scenario === 'options' ? '--json' : '--json --ephemeral --ignore-user-config --ignore-rules --strict-config --sandbox --skip-git-repo-check --stdio');
  process.exit(0);
}
if (args[0] === 'login') {
  console.error(scenario === 'logged-out' ? 'Not logged in' : scenario === 'api' ? 'Logged in using an API key: private-credential'
    : scenario === 'auth-error' ? 'private-credential login diagnostic' : 'Logged in using ChatGPT');
  process.exit(scenario === 'auth-error' || scenario === 'logged-out' ? 1 : 0);
}
let input = ''; for await (const chunk of process.stdin) input += chunk;
if (args[0] === 'app-server') {
  if (input !== '') throw new Error('Configuration check must not send any RPC or prompt');
  if (scenario === 'bad-config' || args.includes('tools.view_image=false')) {
    console.error('Error: unknown configuration field `tools.view_image` in -c/--config override private-credential'); process.exit(1);
  }
  if (scenario === 'bad-option') { console.error("error: unexpected argument '--invalid' private-credential"); process.exit(1); }
  if (scenario === 'probe-exit') { console.error('private-credential unexpected failure'); process.exit(1); }
  process.exit(0);
}
if (scenario === 'hang' || scenario === 'tree') {
  const nested = scenario === 'tree' ? spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'inherit' }) : undefined;
  if (marker !== '-') await writeFile(marker, JSON.stringify({ pid: process.pid, child: nested?.pid, cwd: process.cwd() }));
  setInterval(() => {}, 1000);
} else if (scenario === 'startup-warning') {
  // Synthetic public-copy events; no captured CLI output.
  process.stdout.write(await readFile(new URL('./codex-startup-synthetic.jsonl', import.meta.url)));
} else if (scenario === 'early' || scenario === 'early-chunks') {
  // Synthetic reproduction of the reported ordering, NOT a captured live stream.
  const output = await readFile(new URL('./codex-early-message.jsonl', import.meta.url));
  if (scenario === 'early') process.stdout.write(output);
  else {
    // Split inside JSON tokens and a multi-byte UTF-8 character; stderr is separate.
    const chunks = Buffer.from(output.toString().replace('synthetic-message', '가-item'));
    const unicodeOffset = chunks.indexOf(Buffer.from('가'));
    for (let offset = 0; offset < chunks.length; offset++) {
      process.stdout.write(chunks.subarray(offset, offset + 1));
      if (offset === unicodeOffset || offset === unicodeOffset + 1) await new Promise((resolve) => setTimeout(resolve, 20));
      else if (offset % 7 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    process.stderr.write('not JSONL: private-credential diagnostic\n');
  }
} else if (scenario === 'stdout-limit') process.stdout.write('x'.repeat(1_100_000));
else if (scenario === 'stderr-limit') process.stderr.write('x'.repeat(70_000));
else if (scenario === 'exit') { console.error('private-credential unexpected failure'); process.exitCode = 2; }
else if (scenario === 'usage' || scenario === 'model' || scenario === 'auth') {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: scenario === 'usage' ? 'usage_limit_reached private-credential'
    : scenario === 'model' ? 'model_not_found private-credential' : 'authentication failed private-credential' } }));
  process.exitCode = 1;
} else {
  const events = [{ type: 'thread.started', thread_id: 'fake-thread' }, { type: 'turn.started' }];
  if (scenario !== 'empty') events.push({ type: 'item.completed', item: { id: 'a', type: scenario === 'tool' ? 'command_execution' : 'agent_message',
    text: scenario === 'inspect' ? JSON.stringify({ input, cwd: process.cwd(), args, envKeys: Object.keys(process.env) }) : 'LOOP_OK', phase: 'final_answer' } });
  if (scenario === 'turn-failed-zero') events.push({ type: 'turn.failed', error: { message: 'private-credential failure' } });
  else if (scenario === 'error-zero') events.push({ type: 'error', message: 'private-credential failure' });
  else if (scenario !== 'incomplete') events.push({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
  let output = events.map(JSON.stringify).join('\n') + '\n';
  if (scenario === 'truncated') output = output.slice(0, -2);
  if (scenario === 'unknown') output += '{"type":"unknown"}\n';
  process.stdout.write(output);
  if (scenario === 'success-exit-one') process.exitCode = 1;
}
