// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CodexCliProvider } from '../electron/providers/codex-cli.ts';

test('public application entry point cannot inherit the private CLI enable flag', async () => {
  const source = await readFile(new URL('../electron/main.cts', import.meta.url), 'utf8');
  assert.match(source, /const localCli = new CodexCliProvider\(false\);/);
  assert.doesNotMatch(source, /SEOHOKIM_LOOP_CODEX_LOCAL/);
  // Disabled construction must not discover an executable, inspect login or spawn a process.
  const provider = new CodexCliProvider(false, { environment: { SEOHOKIM_LOOP_CODEX_LOCAL: '1' },
    discover: async () => assert.fail('Public entry must not discover Codex'),
    run: async () => assert.fail('Public entry must not execute Codex') });
  await provider.refresh(); assert.equal(provider.configured, false); assert.equal(provider.status.state, 'disabled');
  await assert.rejects(provider.execute({ userRequest: 'synthetic request', stepTitle: 'synthetic step', previousOutputs: [], isFinalStep: true }), /\[CLI_DISABLED\]/);
  await provider.close();
});
