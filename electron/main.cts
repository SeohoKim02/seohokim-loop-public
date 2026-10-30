// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProviderRuntime, localManualExperimentEnabled } from './provider-runtime.ts';
import { ConnectionStore } from './connection-store.ts';
import type { SecretEncryption } from './connection-store.ts';
import { createProviderGateway } from './provider-gateway.ts';
import { registerProviderIpc } from './provider-ipc.ts';
import { createResultExporter } from './result-export.ts';
import { registerResultExportIpc } from './result-export-ipc.ts';
import { LoopHistoryStore } from './history-store.ts';
import { registerHistoryIpc } from './history-ipc.ts';
import { createTextFileInput } from './text-file-input.ts';
import { registerAttachmentIpc } from './attachment-ipc.ts';
import { CodexCliProvider } from './providers/codex-cli.ts';
import { OllamaProvider } from './providers/ollama.ts';
import { OllamaStore } from './ollama-store.ts';

const isDevelopment = process.argv.includes('--dev') && !app.isPackaged;
app.setName('SeohoKim Loop');

async function createWindow(): Promise<void> {
  const encryption: SecretEncryption = {
    // v0.1 targets Windows. Never permit an unprotected fallback on other platforms.
    isAvailable: async () => process.platform === 'win32' && await safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result,
  };
  const store = new ConnectionStore(app.getPath('userData'), encryption);
  const anthropicStore = new ConnectionStore(app.getPath('userData'), encryption, undefined, 'anthropic');
  const localCli = new CodexCliProvider(!app.isPackaged && process.env.SEOHOKIM_LOOP_CODEX_LOCAL === '1');
  const ollama = new OllamaProvider(new OllamaStore(app.getPath('userData')));
  const runtime = new ProviderRuntime(process.env, store, anthropicStore, localCli, ollama,
    localManualExperimentEnabled(app.isPackaged, process.env));
  // Keep the credential in the main adapter, not the environment inherited by renderers.
  delete process.env.SEOHOKIM_LOOP_OPENAI_API_KEY;
  delete process.env.SEOHOKIM_LOOP_ANTHROPIC_API_KEY;
  await runtime.initialize();
  const rendererFile = path.join(__dirname, '../../dist/index.html');
  const rendererUrl = isDevelopment ? 'http://127.0.0.1:5173/' : pathToFileURL(rendererFile).href;
  const window = new BrowserWindow({
    title: 'SeohoKim Loop',
    width: 1180,
    height: 900,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: '#f4f6f9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const gateway = createProviderGateway(runtime.registry, runtime);
  const removeAttachmentIpc = registerAttachmentIpc(ipcMain, window.webContents, rendererUrl,
    createTextFileInput((options) => dialog.showOpenDialog(window, options)));
  const history = new LoopHistoryStore(app.getPath('userData'), encryption);
  const removeHistoryIpc = registerHistoryIpc(ipcMain, window.webContents, rendererUrl, history);
  let drainingHistory = false;
  app.on('before-quit', (event) => {
    if (!history.pending && !localCli.pending) return;
    event.preventDefault();
    if (drainingHistory) return;
    drainingHistory = true;
    void Promise.allSettled([history.close(), localCli.close()]).finally(() => app.quit());
  });
  const removeProviderIpc = registerProviderIpc(ipcMain, window.webContents, rendererUrl, gateway);
  const removeResultExportIpc = registerResultExportIpc(ipcMain, window.webContents, rendererUrl,
    createResultExporter((options) => dialog.showSaveDialog(window, options)));
  const disposeExecution = () => { gateway.dispose(); ollama.close(); };
  app.once('before-quit', disposeExecution);
  window.once('closed', () => {
    ollama.close();
    gateway.dispose();
    removeProviderIpc();
    removeResultExportIpc();
    removeHistoryIpc();
    removeAttachmentIpc();
    app.removeListener('before-quit', disposeExecution);
  });

  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('render-process-gone', (_event, details) => {
    gateway.dispose();
    console.error('[desktop] Renderer stopped:', details.reason);
  });
  window.webContents.on('did-fail-load', (_event, code, description) => {
    console.error('[desktop] Page failed to load:', code, description);
  });
  window.once('ready-to-show', () => window.show());

  if (isDevelopment) {
    await window.loadURL(rendererUrl);
  } else {
    await window.loadFile(rendererFile);
  }
  console.info('[desktop] SeohoKim Loop is ready.');
}

app.whenReady().then(createWindow).catch((error: unknown) => {
  console.error('[desktop] Failed to start:', error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
