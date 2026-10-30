// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ProviderError } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';

export interface CliCommand { file: string; prefix: readonly string[] }
export interface CliRun {
  cwd: string; env: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal;
  timeoutMs: number; stdoutLimit?: number; stderrLimit?: number;
}
export interface CliExit { stdout: string; stderr: string; code: number | null }
export type CliRunner = (command: CliCommand, args: readonly string[], options: CliRun) => Promise<CliExit>;

// Main-only primitive. Never exported through IPC; args and executable come from the adapter.
export const runCliProcess: CliRunner = (command, args, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new ProviderError('CANCELLED')); return; }
  const child = spawn(command.file, [...command.prefix, ...args], {
    cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = []; const err: Buffer[] = [];
  let outBytes = 0; let errBytes = 0; let stopped: ProviderErrorCode | undefined;
  let settled = false; let exited = false; let killing = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener('abort', cancel); };
  const fail = (code: ProviderErrorCode) => { if (!settled) { settled = true; cleanup(); reject(new ProviderError(code)); } };
  const stop = (code: ProviderErrorCode) => {
    stopped ??= code;
    if (killing || settled) return;
    killing = true;
    // Target only the PID spawned by this invocation. No image-name/global kills.
    if (child.pid && !exited && process.platform === 'win32') {
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => fail('CLI_TERMINATION_FAILED'));
      killer.once('close', (status) => { if (status !== 0 && !exited) fail('CLI_TERMINATION_FAILED'); });
    } else if (!exited) child.kill('SIGKILL');
    // Wait for close (all stdio closed), not just the kill request.
    killTimer = setTimeout(() => fail('CLI_TERMINATION_FAILED'), 5_000);
  };
  const cancel = () => stop('CANCELLED');
  const timer = setTimeout(() => stop('TIMEOUT'), options.timeoutMs);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  child.stdout.on('data', (chunk: Buffer) => {
    outBytes += chunk.length;
    if (outBytes > (options.stdoutLimit ?? 1_048_576)) stop('CLI_OUTPUT_LIMIT');
    else if (!stopped) out.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errBytes += chunk.length;
    if (errBytes > (options.stderrLimit ?? 65_536)) stop('CLI_OUTPUT_LIMIT');
    else if (!stopped) err.push(chunk);
  });
  child.once('error', () => fail('EXECUTION_FAILED'));
  child.once('exit', () => { exited = true; });
  child.once('close', (code) => {
    if (settled) return;
    settled = true; cleanup();
    if (stopped) reject(new ProviderError(stopped));
    else resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code });
  });
  child.stdin.on('error', () => { if (!settled && !exited) stop('EXECUTION_FAILED'); });
  child.stdin.end(options.input ?? '');
});

export function codexEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Do not inherit API keys, proxy/provider overrides, Node hooks, or project configuration.
  const allowed = ['SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME'];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const key = Object.keys(source).find((key) => key.toLowerCase() === name.toLowerCase());
    if (key && source[key]) env[name] = source[key];
  }
  env.PATH = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32');
  return env;
}
