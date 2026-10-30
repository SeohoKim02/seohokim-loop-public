// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ProviderError } from '../src/providers/provider-error.ts';
import { codexEnvironment, runCliProcess } from './codex-process.ts';
import type { CliCommand } from './codex-process.ts';

export const CODEX_VERSION = '0.160.1';

// Deliberately narrow v0.1: official per-user npm package, native Windows x64 binary.
// Never execute PATH .cmd/.ps1 shims, a renderer path, or an arbitrary fallback executable.
export async function findCodex(environment: NodeJS.ProcessEnv = process.env): Promise<CliCommand> {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !environment.APPDATA) throw new ProviderError('CLI_NOT_INSTALLED');
  const root = path.join(environment.APPDATA, 'npm', 'node_modules', '@openai', 'codex');
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')); }
  catch { throw new ProviderError('CLI_NOT_INSTALLED'); }
  if (pkg.name !== '@openai/codex' || pkg.repository?.url !== 'git+https://github.com/openai/codex.git') throw new ProviderError('CLI_UNTRUSTED');
  if (pkg.version !== CODEX_VERSION) throw new ProviderError('CLI_UNSUPPORTED');
  const file = path.join(root, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  try {
    if ((await realpath(file)).toLowerCase() !== file.toLowerCase() || !(await stat(file)).isFile()) throw new Error();
    const platform = JSON.parse(await readFile(path.join(root, 'node_modules', '@openai', 'codex-win32-x64', 'package.json'), 'utf8'));
    if (platform.name !== '@openai/codex' || platform.version !== `${CODEX_VERSION}-win32-x64`) throw new Error();
    // A package label alone is insufficient. Verify Windows Authenticode trust and signer.
    const literal = file.replaceAll("'", "''");
    const script = `$s=Get-AuthenticodeSignature -LiteralPath '${literal}'; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match '^CN="?OpenAI OpCo, LLC"?,') { [Console]::Write('TRUSTED') } else { exit 1 }`;
    const result = await runCliProcess({ file: path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), prefix: [] },
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { cwd: root, env: codexEnvironment(environment), timeoutMs: 10_000, stdoutLimit: 1024, stderrLimit: 4096 });
    if (result.code !== 0 || result.stdout !== 'TRUSTED') throw new Error();
  } catch { throw new ProviderError('CLI_UNTRUSTED'); }
  return { file, prefix: [] };
}
