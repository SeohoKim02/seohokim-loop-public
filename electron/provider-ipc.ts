// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import type { ProviderBridge } from '../src/providers/provider-ipc.ts';
import type { OllamaBridge } from '../src/providers/ollama.ts';
import { ProviderError, toProviderFailure } from '../src/providers/provider-error.ts';
import { connectionCheckFailure } from '../src/providers/connection-check.ts';

export function registerProviderIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  contents: WebContents,
  rendererUrl: string,
  gateway: ProviderBridge & Partial<OllamaBridge>,
): () => void {
  function trusted(event: IpcMainInvokeEvent): boolean {
    return !contents.isDestroyed() && event.sender === contents
      && event.senderFrame === contents.mainFrame && event.senderFrame?.url === rendererUrl;
  }
  const forbidden = () => ({ ok: false, error: toProviderFailure(new ProviderError('IPC_FORBIDDEN')) });
  ipc.handle('seohokim-loop:ollama:select-model', (event, model) => trusted(event) && gateway.selectOllamaModel
    ? gateway.selectOllamaModel(model) : forbidden());
  ipc.handle('seohokim-loop:providers:list', (event) => trusted(event) ? gateway.listProviders() : forbidden());
  ipc.handle('seohokim-loop:providers:execute', (event, input) => trusted(event) ? gateway.executeProvider(input) : forbidden());
  ipc.handle('seohokim-loop:execution:cancel', (event, executionId) => trusted(event) ? gateway.cancelExecution(executionId) : forbidden());
  ipc.handle('seohokim-loop:providers:test-connection', (event, providerId) => trusted(event)
    ? gateway.testConnection(providerId) : connectionCheckFailure(new ProviderError('IPC_FORBIDDEN')));
  ipc.handle('seohokim-loop:connections:get', (event, providerId) => trusted(event) ? gateway.getConfiguration(providerId) : forbidden());
  ipc.handle('seohokim-loop:connections:save', (event, input) => trusted(event) ? gateway.saveConfiguration(input) : forbidden());
  ipc.handle('seohokim-loop:connections:remove', (event, providerId) => trusted(event) ? gateway.removeConfiguration(providerId) : forbidden());
  return () => {
    ipc.removeHandler('seohokim-loop:ollama:select-model');
    ipc.removeHandler('seohokim-loop:providers:list');
    ipc.removeHandler('seohokim-loop:providers:execute');
    ipc.removeHandler('seohokim-loop:execution:cancel');
    ipc.removeHandler('seohokim-loop:providers:test-connection');
    ipc.removeHandler('seohokim-loop:connections:get');
    ipc.removeHandler('seohokim-loop:connections:save');
    ipc.removeHandler('seohokim-loop:connections:remove');
  };
}
