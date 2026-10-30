// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import electron from 'electron';

const development = process.argv.includes('--dev');
const server = development ? await (await import('vite')).createServer() : undefined;
await server?.listen();

// Some developer shells set this variable. The desktop must run as Electron.
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const desktop = spawn(electron, ['.', ...(development ? ['--dev'] : [])], {
  stdio: 'inherit',
  env: environment,
  // This process owns the interactive desktop window, so Windows must show it.
  windowsHide: false,
});

async function shutdown(code = 0) {
  await server?.close();
  process.exitCode = code;
}

desktop.once('error', async (error) => {
  console.error(error);
  await shutdown(1);
});
desktop.once('exit', (code) => void shutdown(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    desktop.kill();
    void shutdown();
  });
}
