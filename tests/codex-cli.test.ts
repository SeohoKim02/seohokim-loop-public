// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexCliProvider, codexExecArgs, codexConfigCheckArgs } from '../electron/providers/codex-cli.ts';
import { codexEnvironment, runCliProcess } from '../electron/codex-process.ts';
import { findCodex } from '../electron/codex-installation.ts';
import { cliFailure, parseCodexEvents } from '../electron/codex-events.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { ProviderRuntime } from '../electron/provider-runtime.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { autoProviderPool, selectAlternativeProvider } from '../src/application/auto-router.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';

const fixture = fileURLToPath(new URL('./fixtures/codex-cli.mjs', import.meta.url));
const request = { userRequest: '공개 테스트 $(whoami) & echo unsafe', stepTitle: '작성', previousOutputs: ['이전 텍스트'], isFinalStep: true };
const command = (scenario = 'success', marker = '-') => ({ file: process.execPath, prefix: [fixture, scenario, marker] });
function adapter(scenario = 'success', marker = '-', timeoutMs = 3_000) {
  return new CodexCliProvider(true, { discover: async () => command(scenario, marker), timeoutMs,
    environment: { ...process.env, OPENAI_API_KEY: 'private-credential', CODEX_API_KEY: 'private-credential', NODE_OPTIONS: '--invalid',
      SEOHOKIM_LOOP_OPENAI_API_KEY: 'private-credential' } });
}
const isCode = (code: ProviderErrorCode) => (error: unknown) => {
  assert.ok(error instanceof ProviderError); assert.equal(error.code, code);
  assert.doesNotMatch(String(error), /private-credential|Error:.*at |unexpected failure/); return true;
};
async function waitMarker(marker: string): Promise<{ pid: number; child?: number; cwd: string }> {
  for (let n = 0; n < 200; n++) {
    try { return JSON.parse(await readFile(marker, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 25)); }
  }
  throw new Error('Fixture did not start');
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Codex disabled gate never discovers or launches a process', async () => {
  const provider = new CodexCliProvider(false, { discover: async () => { assert.fail(); } });
  await provider.refresh(); assert.equal(provider.status.state, 'disabled');
  await assert.rejects(provider.execute(request), isCode('CLI_DISABLED'));
});
for (const [scenario, state, code] of [
  ['success', 'ready', undefined], ['version', 'unsupported', 'CLI_UNSUPPORTED'], ['options', 'failed', 'CLI_OPTIONS_INVALID'],
  ['logged-out', 'login_required', 'CLI_LOGIN_REQUIRED'], ['api', 'login_required', 'CLI_API_AUTH'], ['auth-error', 'failed', 'CLI_AUTH_FAILED'],
  ['bad-config', 'failed', 'CLI_CONFIG_INVALID'], ['bad-option', 'failed', 'CLI_OPTIONS_INVALID'], ['probe-exit', 'failed', 'EXECUTION_FAILED'],
] as const) test(`Codex metadata: ${scenario}`, async () => {
  const provider = adapter(scenario); await provider.refresh();
  assert.equal(provider.status.state, state); assert.equal(provider.unavailableReason, code);
  assert.equal(provider.configured, scenario === 'success'); assert.doesNotMatch(JSON.stringify(provider.status), /private-credential|file:|token|account/);
});
test('Codex missing install and unexpected discovery errors are safe', async () => {
  const provider = new CodexCliProvider(true, { discover: async () => { throw new ProviderError('CLI_NOT_INSTALLED'); } });
  await provider.refresh(); assert.equal(provider.status.state, 'not_installed');
  const broken = new CodexCliProvider(true, { discover: async () => { throw new Error('private-credential'); } });
  await assert.rejects(broken.execute(request), isCode('EXECUTION_FAILED'));
});
test('Codex discovery rejects missing, mislabeled, unsupported and unsigned packages without executing them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-install-test-'));
  const packageRoot = path.join(root, 'npm/node_modules/@openai/codex');
  try {
    await assert.rejects(findCodex({ ...process.env, APPDATA: root }), isCode('CLI_NOT_INSTALLED'));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'evil' }));
    await assert.rejects(findCodex({ ...process.env, APPDATA: root }), isCode('CLI_UNTRUSTED'));
    const pkg = { name: '@openai/codex', version: '0.1.0', repository: { url: 'git+https://github.com/openai/codex.git' } };
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(pkg));
    await assert.rejects(findCodex({ ...process.env, APPDATA: root }), isCode('CLI_UNSUPPORTED'));
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ ...pkg, version: '0.160.1' }));
    const platform = path.join(packageRoot, 'node_modules/@openai/codex-win32-x64');
    const bin = path.join(platform, 'vendor/x86_64-pc-windows-msvc/bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(platform, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.160.1-win32-x64' }));
    await writeFile(path.join(bin, 'codex.exe'), 'MZ-fake-never-execute');
    await assert.rejects(findCodex({ ...process.env, APPDATA: root }), isCode('CLI_UNTRUSTED'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Codex fixed execution flags cannot contain the prompt or grant shell/write permissions', () => {
  assert.ok(codexExecArgs.includes('read-only')); assert.ok(codexExecArgs.includes('--ignore-user-config'));
  assert.ok(codexExecArgs.includes('features.shell_tool=false')); assert.ok(codexExecArgs.includes('forced_login_method="chatgpt"'));
  assert.equal(codexExecArgs.at(-1), '-');
  assert.doesNotMatch(codexExecArgs.join(' '), /danger-full-access|workspace-write|yolo|bypass|approve-for-me/);
  // Installed 0.160.1 rejects model_providers.openai before inference.
  assert.doesNotMatch(codexExecArgs.join(' '), /model_providers\.openai/);
  assert.ok(codexExecArgs.includes('features.view_image=false'));
  assert.doesNotMatch(codexExecArgs.join(' '), /tools\.view_image/);
});

test('Codex bootstrap configuration failures expose only an unsupported code', () => {
  assert.equal(cliFailure('Error: failed to load bootstrap configuration: private-credential'), 'CLI_CONFIG_INVALID');
  assert.equal(cliFailure('model_providers contains reserved built-in provider IDs: openai'), 'CLI_CONFIG_INVALID');
  assert.equal(cliFailure('unknown configuration field `tools.view_image` in -c/--config override'), 'CLI_CONFIG_INVALID');
  assert.equal(cliFailure(''), 'EXECUTION_FAILED');
  assert.throws(() => parseCodexEvents(''), isCode('CLI_OUTPUT_INVALID'));
});
test('Codex native process receives stdin literally, isolated cwd and no API/Node environment', async () => {
  const response = JSON.parse((await adapter('inspect').execute(request)).output);
  assert.ok(response.input.includes(request.userRequest));
  assert.ok(response.input.includes(request.previousOutputs[0]));
  assert.deepEqual(response.args, codexExecArgs);
  assert.notEqual(response.cwd, process.cwd()); assert.match(path.basename(response.cwd), /^seohokim-codex-run-/);
  await assert.rejects(access(response.cwd));
  assert.ok(!response.envKeys.some((key: string) => /API_KEY|NODE_OPTIONS|SEOHOKIM/.test(key)));
});
test('Codex environment allowlist excludes inherited hooks, proxy credentials and provider overrides', () => {
  const env = codexEnvironment({ SystemRoot: 'C:\\Windows', CODEX_HOME: 'official-home', OPENAI_BASE_URL: 'evil',
    HTTP_PROXY: 'private-credential', ACCESS_TOKEN: 'private-credential', NODE_OPTIONS: 'evil', PATH: 'untrusted' });
  assert.equal(env.CODEX_HOME, 'official-home'); assert.equal(env.PATH, 'C:\\Windows\\System32');
  assert.doesNotMatch(JSON.stringify(env), /private-credential|evil|untrusted/);
});
test('Codex refresh is deduplicated and performs metadata only', async () => {
  let launches = 0;
  const provider = new CodexCliProvider(true, { discover: async () => command(), run: async (cmd, args, options) => {
    launches++; assert.ok(args.includes('--help') || args.includes('--version') || args[0] === 'login' || args[0] === 'app-server');
    return runCliProcess(cmd, args, options);
  } });
  await Promise.all([provider.refresh(), provider.refresh()]); assert.equal(launches, 6);
});

test('Codex configuration probe sends no RPC or prompt and preserves the original config/home', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-config-preserve-'));
  const originalConfig = 'model="unchanged-model"\nmodel_reasoning_effort="high"\n';
  const config = path.join(root, 'config.toml'); await writeFile(config, originalConfig);
  let probeHome = ''; let generations = 0;
  const provider = new CodexCliProvider(true, { environment: { ...process.env, CODEX_HOME: root }, discover: async () => command(),
    run: async (cmd, args, options) => {
      if (args[0] === 'exec' && !args.includes('--help')) generations++;
      if (args[0] === 'app-server' && !args.includes('--help')) {
        probeHome = options.env.CODEX_HOME!;
        assert.notEqual(probeHome, root); assert.equal(options.input, '');
        assert.deepEqual(args, codexConfigCheckArgs);
        await assert.rejects(access(path.join(probeHome, 'config.toml')));
        await assert.rejects(access(path.join(probeHome, 'auth.json')));
      }
      if (args[0] === 'login') assert.equal(options.env.CODEX_HOME, root);
      return runCliProcess(cmd, args, options);
    } });
  try {
    await provider.refresh(); assert.equal(provider.configured, true); assert.equal(generations, 0);
    assert.equal(await readFile(config, 'utf8'), originalConfig); await assert.rejects(access(probeHome));
  } finally { await provider.close(); await rm(root, { recursive: true, force: true }); }
});

test('Strict fake configuration parser reproduces old override and accepts the corrected settings without JSONL', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-config-regression-'));
  try {
    const options = { cwd: root, env: codexEnvironment(process.env), input: '', timeoutMs: 3000 };
    const before = await runCliProcess(command(), [...codexConfigCheckArgs, '-c', 'tools.view_image=false'], options);
    assert.equal(before.code, 1); assert.equal(before.stdout, ''); assert.equal(cliFailure(before.stderr), 'CLI_CONFIG_INVALID');
    const after = await runCliProcess(command(), codexConfigCheckArgs, options);
    assert.equal(after.code, 0); assert.equal(after.stdout, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Login-required execution never launches a generating CLI process', async () => {
  let generations = 0;
  const provider = new CodexCliProvider(true, { discover: async () => command('logged-out'), run: (cmd, args, options) => {
    if (args[0] === 'exec' && !args.includes('--help')) generations++;
    return runCliProcess(cmd, args, options);
  } });
  await assert.rejects(provider.execute(request), isCode('CLI_LOGIN_REQUIRED'));
  assert.equal(generations, 0);
});

test('Corrected configuration returns ready on metadata refresh while retaining failed execution history', async () => {
  let scenario = 'bad-config';
  const provider = new CodexCliProvider(true, { discover: async () => command(scenario) });
  await assert.rejects(provider.execute(request), isCode('CLI_CONFIG_INVALID'));
  assert.equal(provider.configured, false);
  scenario = 'success'; await provider.refresh();
  assert.equal(provider.status.state, 'ready'); assert.equal(provider.configured, true);
  assert.equal(provider.status.lastExecution, 'failed');
});
for (const [scenario, code] of [
  ['success', undefined], ['early', undefined], ['early-chunks', undefined], ['startup-warning', undefined],
  ['success-exit-one', 'EXECUTION_FAILED'], ['turn-failed-zero', 'EXECUTION_FAILED'], ['error-zero', 'EXECUTION_FAILED'],
  ['exit', 'EXECUTION_FAILED'], ['usage', 'CLI_USAGE_LIMIT'], ['model', 'CLI_MODEL_UNAVAILABLE'],
  ['auth', 'CLI_AUTH_FAILED'], ['empty', 'CLI_OUTPUT_INVALID'], ['truncated', 'CLI_OUTPUT_INVALID'],
  ['incomplete', 'CLI_OUTPUT_INVALID'], ['unknown', 'CLI_OUTPUT_INVALID'], ['tool', 'CLI_OUTPUT_INVALID'],
  ['stdout-limit', 'CLI_OUTPUT_LIMIT'], ['stderr-limit', 'CLI_OUTPUT_LIMIT'],
] as const) test(`Codex real fake-process execution: ${scenario}`, async () => {
  const provider = adapter(scenario);
  if (code) await assert.rejects(provider.execute(request), isCode(code));
  else assert.equal((await provider.execute(request)).output, 'LOOP_OK');
  assert.equal(provider.status.lastExecution, code ? 'failed' : 'completed');
  await provider.close();
});
test('Codex parser rejects reordered completion, missing thread and malformed JSON', () => {
  for (const text of ['{}\n', '{\n', '{"type":"turn.completed"}\n', '{"type":"turn.started"}\n']) {
    assert.throws(() => parseCodexEvents(text), isCode('CLI_OUTPUT_INVALID'));
  }
});

// Synthetic fixtures: the live run retained counts, not item contents or full order.
const threadEvent = { type: 'thread.started', thread_id: 'synthetic-thread' };
const startEvent = { type: 'turn.started' };
const finalEvent = { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: 'LOOP_OK' } };
const completeEvent = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

test('Codex synthetic startup ErrorItem is a diagnostic, not a fatal event or final response', async () => {
  const stream = await readFile(new URL('./fixtures/codex-startup-synthetic.jsonl', import.meta.url), 'utf8');
  assert.equal(parseCodexEvents(stream), 'LOOP_OK');
});
const warningEvent = { type: 'item.completed', item: { id: 'warning', type: 'error', message: 'private-credential diagnostic' } };
test('Codex non-fatal ErrorItem during the turn never replaces the final answer', () => {
  assert.equal(parseCodexEvents(jsonl([threadEvent, startEvent, finalEvent, warningEvent, completeEvent])), 'LOOP_OK');
});
for (const [name, events] of Object.entries({
  'warning-only': [threadEvent, warningEvent, startEvent, completeEvent],
  'warning-without-turn-completion': [threadEvent, warningEvent, startEvent, finalEvent],
  'warning-before-thread': [warningEvent, threadEvent, startEvent, finalEvent, completeEvent],
  'partial-warning': [threadEvent, startEvent, { ...warningEvent, type: 'item.started' }, finalEvent, completeEvent],
  'malformed-warning': [threadEvent, { ...warningEvent, item: { ...warningEvent.item, message: 42 } }, startEvent, finalEvent, completeEvent],
  'empty-warning': [threadEvent, { ...warningEvent, item: { ...warningEvent.item, message: '' } }, startEvent, finalEvent, completeEvent],
  'duplicate-warning': [threadEvent, warningEvent, warningEvent, startEvent, finalEvent, completeEvent],
  'warning-then-fatal-error': [threadEvent, warningEvent, startEvent, finalEvent, { type: 'error', message: 'private-credential failure' }, completeEvent],
  'warning-then-failed-turn': [threadEvent, warningEvent, startEvent, finalEvent, { type: 'turn.failed', error: { message: 'private-credential failure' } }, completeEvent],
})) test(`Codex diagnostics still reject ${name}`, () => {
  assert.throws(() => parseCodexEvents(jsonl(events)), (error: unknown) => {
    assert.ok(error instanceof ProviderError); assert.doesNotMatch(String(error), /private-credential/); return true;
  });
});

test('Codex synthetic early completed message waits for explicit turn start and completion', async () => {
  const stream = await readFile(new URL('./fixtures/codex-early-message.jsonl', import.meta.url), 'utf8');
  assert.equal(parseCodexEvents(stream), 'LOOP_OK');
  assert.throws(() => parseCodexEvents(jsonl([threadEvent, finalEvent])), isCode('CLI_OUTPUT_INVALID'));
});
test('Codex completed agent message needs no separate item.started', () => {
  assert.equal(parseCodexEvents(jsonl([threadEvent, startEvent, finalEvent, completeEvent])), 'LOOP_OK');
});
test('Codex reasoning/commentary never replaces final text; later final supersedes early text', () => {
  assert.equal(parseCodexEvents(jsonl([threadEvent,
    { ...finalEvent, item: { ...finalEvent.item, id: 'early', text: 'earlier candidate' } }, startEvent,
    { type: 'item.completed', item: { id: 'reason', type: 'reasoning', text: 'reasoning summary' } }, finalEvent,
    { type: 'item.completed', item: { id: 'comment', type: 'agent_message', phase: 'commentary', text: 'not final' } }, completeEvent])), 'LOOP_OK');
});
test('Codex typed text item lifecycle is supported after turn start', () => {
  assert.equal(parseCodexEvents(jsonl([threadEvent, startEvent,
    { ...finalEvent, type: 'item.started' }, { ...finalEvent, type: 'item.updated' }, finalEvent, completeEvent])), 'LOOP_OK');
});
for (const [name, events] of Object.entries({
  'missing-turn-start': [threadEvent, finalEvent, completeEvent],
  'missing-turn-completion': [threadEvent, finalEvent, startEvent],
  'early-partial-item': [threadEvent, { ...finalEvent, type: 'item.started' }, startEvent, finalEvent, completeEvent],
  'item-before-thread': [finalEvent, threadEvent, startEvent, completeEvent],
  'thread-id-mismatch': [threadEvent, finalEvent, { ...startEvent, thread_id: 'other' }, completeEvent],
  'item-thread-id-mismatch': [threadEvent, { ...finalEvent, item: { ...finalEvent.item, thread_id: 'other' } }, startEvent, completeEvent],
  'second-thread': [threadEvent, { ...threadEvent, thread_id: 'other' }, startEvent, finalEvent, completeEvent],
  'duplicate-turn': [threadEvent, startEvent, finalEvent, startEvent, completeEvent],
  'duplicate-item-completion': [threadEvent, finalEvent, startEvent, finalEvent, completeEvent],
  'item-type-change': [threadEvent, startEvent, { type: 'item.started', item: { id: 'final', type: 'reasoning', text: '' } }, finalEvent, completeEvent],
  'unfinished-item': [threadEvent, startEvent, { type: 'item.started', item: { id: 'partial', type: 'reasoning', text: '' } }, finalEvent, completeEvent],
  'reasoning-only': [threadEvent, { ...finalEvent, item: { ...finalEvent.item, type: 'reasoning' } }, startEvent, completeEvent],
  'commentary-only': [threadEvent, { ...finalEvent, item: { ...finalEvent.item, phase: 'commentary' } }, startEvent, completeEvent],
  'empty-text': [threadEvent, { ...finalEvent, item: { ...finalEvent.item, text: ' ' } }, startEvent, completeEvent],
  'wrong-text-type': [threadEvent, { ...finalEvent, item: { ...finalEvent.item, text: 42 } }, startEvent, completeEvent],
  'empty-item-id': [threadEvent, { ...finalEvent, item: { ...finalEvent.item, id: '' } }, startEvent, completeEvent],
  'early-tool': [threadEvent, { ...finalEvent, item: { ...finalEvent.item, type: 'command_execution' } }, startEvent, completeEvent],
  'unknown-phase': [threadEvent, { ...finalEvent, item: { ...finalEvent.item, phase: 'unknown' } }, startEvent, completeEvent],
  'missing-usage': [threadEvent, finalEvent, startEvent, { type: 'turn.completed' }],
  'invalid-usage': [threadEvent, finalEvent, startEvent, { ...completeEvent, usage: { ...completeEvent.usage, output_tokens: -1 } }],
  'error-before-completion': [threadEvent, finalEvent, startEvent, { type: 'error', message: 'private-credential' }, completeEvent],
  'failed-before-completion': [threadEvent, finalEvent, startEvent, { type: 'turn.failed', error: { message: 'private-credential' } }, completeEvent],
  'malformed-error': [threadEvent, { type: 'error', message: 3 }],
  'error-after-completion': [threadEvent, finalEvent, startEvent, completeEvent, { type: 'error', message: 'private-credential' }],
  'events-after-completion': [threadEvent, startEvent, finalEvent, completeEvent, startEvent],
  'array-event': [[], threadEvent, startEvent, finalEvent, completeEvent],
})) test(`Codex compatibility still rejects ${name}`, () => {
  assert.throws(() => parseCodexEvents(jsonl(events)), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.doesNotMatch(String(error), /private-credential/);
    return true;
  });
});
test('Codex complete-looking final line without newline still fails', () => {
  assert.throws(() => parseCodexEvents(jsonl([threadEvent, finalEvent, startEvent, completeEvent]).trimEnd()), isCode('CLI_OUTPUT_INVALID'));
});
test('Codex cancellation wins over a late otherwise valid runner response', async () => {
  const controller = new AbortController();
  const provider = new CodexCliProvider(true, { discover: async () => command(), run: async (cmd, args, options) => {
    if (args[0] === 'exec' && !args.includes('--help')) {
      controller.abort();
      return { code: 0, stderr: '', stdout: jsonl([threadEvent, finalEvent, startEvent, completeEvent]) };
    }
    return runCliProcess(cmd, args, options);
  } });
  const service = new LoopService(new MockPlanner('single-work'), provider);
  const loop = await service.run(service.create('synthetic late result'), () => {}, { signal: controller.signal });
  assert.equal(loop.status, 'cancelled'); assert.equal(loop.finalResult, undefined);
  assert.equal(provider.status.lastExecution, 'cancelled');
  await provider.close();
});
test('Codex timeout fails and the actual owned process is gone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-timeout-test-')); const marker = path.join(root, 'pid.json');
  try {
    const provider = adapter('hang', marker, 500);
    await assert.rejects(provider.execute(request), isCode('TIMEOUT'));
    const data = await waitMarker(marker); assert.equal(alive(data.pid), false);
    await assert.rejects(access(data.cwd)); assert.equal(provider.status.lastExecution, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Codex cancellation kills owned Windows tree, keeps another session alive and holds one slot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-cancel-test-'));
  const marker = path.join(root, 'pid.json'); const otherMarker = path.join(root, 'other.json');
  const controller = new AbortController(); const otherController = new AbortController();
  const other = runCliProcess(command('hang', otherMarker), ['exec', '-'], { cwd: root, env: codexEnvironment(process.env), signal: otherController.signal, timeoutMs: 10_000 }).catch((e) => e);
  try {
    const otherData = await waitMarker(otherMarker);
    const provider = adapter('tree', marker, 10_000);
    const pending = provider.execute(request, { signal: controller.signal });
    const rejection = assert.rejects(pending, isCode('CANCELLED'));
    const data = await waitMarker(marker); assert.equal(provider.status.state, 'running');
    await assert.rejects(provider.execute(request), isCode('BUSY'));
    controller.abort(); await rejection;
    assert.equal(alive(data.pid), false); assert.equal(alive(data.child!), false);
    assert.equal(alive(otherData.pid), true); assert.equal(provider.status.lastExecution, 'cancelled');
    await assert.rejects(access(data.cwd));
  } finally { otherController.abort(); await other; await rm(root, { recursive: true, force: true }); }
});
test('Codex pre-cancelled request and attachments never launch', () => {
  const provider = adapter();
  assert.throws(() => provider.execute(request, { signal: AbortSignal.abort() }), isCode('CANCELLED'));
  return assert.rejects(provider.execute({ ...request, attachments: [{ id: 'fixture', name: 'test.txt', type: 'txt', text: 'test', size: 4 }] }), isCode('INVALID_REQUEST'));
});

test('Codex close aborts an owned metadata process and waits for its exit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-close-test-')); const marker = path.join(root, 'pid.json');
  const provider = new CodexCliProvider(true, { discover: async () => command('hang', marker),
    run: (cmd, _args, options) => runCliProcess(cmd, ['exec', '-'], options) });
  try {
    const checking = provider.refresh(); const data = await waitMarker(marker);
    assert.equal(provider.pending, true);
    await provider.close(); await checking;
    assert.equal(provider.pending, false); assert.equal(alive(data.pid), false);
    await assert.rejects(access(data.cwd));
  } finally { await provider.close(); await rm(root, { recursive: true, force: true }); }
});

test('Codex termination failure prevents another process launch until app restart', async () => {
  let launches = 0;
  const provider = new CodexCliProvider(true, { discover: async () => command(), run: async () => {
    launches++; throw new ProviderError('CLI_TERMINATION_FAILED');
  } });
  await assert.rejects(provider.execute(request), isCode('CLI_TERMINATION_FAILED'));
  await assert.rejects(provider.execute(request), isCode('CLI_TERMINATION_FAILED'));
  await provider.refresh(); assert.equal(launches, 1); assert.equal(provider.configured, false);
});
test('Codex runtime and IPC integrate early text with neutral Single Loop while Auto/Fallback exclude it', async () => {
  const provider = adapter('early');
  const store = { read: async () => undefined, save: async () => {}, remove: async () => {} };
  const runtime = new ProviderRuntime({}, store, store, provider); await runtime.initialize();
  const gateway = createProviderGateway(runtime.registry, runtime);
  const listed = await gateway.listProviders(); assert.ok(listed.ok);
  const summary = listed.value.find((item) => item.id === provider.id)!;
  assert.equal(summary.singleOnly, true); assert.equal(summary.supportsConnectionCheck, false);
  assert.throws(() => autoProviderPool(runtime.registry)); assert.equal(selectAlternativeProvider(runtime.registry, 'missing'), undefined);
  const service = new LoopService(new MockPlanner('single-work'), new IpcProvider(summary, gateway));
  const loop = await service.run(service.create('공개 테스트')); assert.equal(loop.status, 'completed'); assert.equal(loop.finalResult, 'LOOP_OK');
  assert.equal(runtime.registry.list().length, 4);
  assert.doesNotMatch(JSON.stringify(await gateway.listProviders()), /private-credential|\.exe|auth.json/);
  gateway.dispose(); await provider.close();
});
test('Codex failure becomes failed Step/Loop with no final output', async () => {
  const service = new LoopService(new MockPlanner('single-work'), adapter('usage'));
  const loop = await service.run(service.create('공개 테스트'));
  assert.equal(loop.status, 'failed'); assert.equal(loop.steps[0]?.status, 'failed'); assert.equal(loop.finalResult, undefined);
});
test('Registry copies only public CLI fields and isolates nested summary mutations', () => {
  const registry = new ProviderRegistry(); const provider = adapter();
  const localCli = { state: 'ready' as const, token: 'private-credential' };
  registry.register(provider, { type: 'local-cli', configured: true, singleOnly: true, localCli });
  const summary = registry.list()[0]!; summary.localCli!.state = 'failed';
  assert.equal(registry.list()[0]!.localCli!.state, 'ready'); assert.doesNotMatch(JSON.stringify(registry.list()), /private-credential/);
});
