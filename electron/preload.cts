// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { contextBridge, ipcRenderer } from 'electron';
import type { ProviderBridge } from '../src/providers/provider-ipc.ts';
import type { ResultExportBridge } from '../src/application/result-export.ts';
import type { HistoryBridge } from '../src/application/history-ipc.ts';
import type { AttachmentBridge } from '../src/application/attachment-ipc.ts';
import type { OllamaBridge } from '../src/providers/ollama.ts';

// Sandboxed preload: fixed operations only; no generic IPC, filesystem or credential read API.
const bridge: ProviderBridge & ResultExportBridge & HistoryBridge & AttachmentBridge & OllamaBridge = {
  selectOllamaModel: (model) => ipcRenderer.invoke('seohokim-loop:ollama:select-model', model),
  selectTextFiles: () => ipcRenderer.invoke('seohokim-loop:attachments:select-text'),
  saveHistory: (input) => ipcRenderer.invoke('seohokim-loop:history:save', input),
  listHistory: (search) => search === undefined ? ipcRenderer.invoke('seohokim-loop:history:list')
    : ipcRenderer.invoke('seohokim-loop:history:list', search),
  getHistory: (id) => ipcRenderer.invoke('seohokim-loop:history:get', id),
  deleteHistory: (id) => ipcRenderer.invoke('seohokim-loop:history:delete', id),
  exportMarkdown: (input) => ipcRenderer.invoke('seohokim-loop:result:export-markdown', input),
  listProviders: () => ipcRenderer.invoke('seohokim-loop:providers:list'),
  executeProvider: (input) => ipcRenderer.invoke('seohokim-loop:providers:execute', input),
  cancelExecution: (executionId) => ipcRenderer.invoke('seohokim-loop:execution:cancel', executionId),
  testConnection: (providerId) => ipcRenderer.invoke('seohokim-loop:providers:test-connection', providerId),
  getConfiguration: (providerId) => ipcRenderer.invoke('seohokim-loop:connections:get', providerId),
  saveConfiguration: (input) => ipcRenderer.invoke('seohokim-loop:connections:save', input),
  removeConfiguration: (providerId) => ipcRenderer.invoke('seohokim-loop:connections:remove', providerId),
};
contextBridge.exposeInMainWorld('seohoKimLoop', Object.freeze(bridge));
