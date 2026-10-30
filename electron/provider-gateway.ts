// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { ProviderRequest, ProviderResponse } from '../src/providers/ai-provider.ts';
import type { ProviderBridge, ProviderExecution, ProviderReply } from '../src/providers/provider-ipc.ts';
import type { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { ProviderError, toProviderFailure } from '../src/providers/provider-error.ts';
import { connectionCheckFailure } from '../src/providers/connection-check.ts';
import type { ProviderRuntime } from './provider-runtime.ts';
import { abortable, throwIfCancelled } from '../src/providers/cancellation.ts';
import { MAX_CONCURRENT_STEPS } from '../src/providers/execution-limits.ts';
import { validateAttachmentInput } from '../src/providers/text-attachments.ts';
import type { TextAttachment } from '../src/providers/text-attachments.ts';
import type { OllamaBridge } from '../src/providers/ollama.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= limit;
}

export function validateExecution(value: unknown): ProviderExecution {
  if (!record(value) || !exactKeys(value, ['providerId', 'request', ...(Object.hasOwn(value, 'executionId') ? ['executionId'] : [])])
    || (Object.hasOwn(value, 'executionId') && !validExecutionId(value.executionId)) || !text(value.providerId, 100)
    || !record(value.request)) throw new ProviderError('INVALID_REQUEST');
  const request = value.request;
  if (!exactKeys(request, ['userRequest', 'stepTitle', 'previousOutputs', 'isFinalStep', ...(Object.hasOwn(request, 'objective') ? ['objective'] : []), ...(Object.hasOwn(request, 'attachments') ? ['attachments'] : [])])
    || (Object.hasOwn(request, 'objective') && !text(request.objective, 2_000))
    || !text(request.userRequest, 20_000) || !text(request.stepTitle, 200)
    || typeof request.isFinalStep !== 'boolean' || !Array.isArray(request.previousOutputs)
    || request.previousOutputs.length > 20
    || !request.previousOutputs.every((output: unknown) => text(output, 100_000))
    || request.previousOutputs.join('').length > 200_000) throw new ProviderError('INVALID_REQUEST');
  let attachments: readonly TextAttachment[] | undefined;
  if (Object.hasOwn(request, 'attachments')) {
    try { attachments = validateAttachmentInput(request.userRequest, request.attachments as readonly TextAttachment[]); }
    catch { throw new ProviderError('INVALID_REQUEST'); }
  }
  return {
    providerId: value.providerId,
    ...(Object.hasOwn(value, 'executionId') ? { executionId: value.executionId as string } : {}),
    request: {
      userRequest: request.userRequest, stepTitle: request.stepTitle,
      previousOutputs: [...request.previousOutputs] as ProviderRequest['previousOutputs'],
      isFinalStep: request.isFinalStep,
      ...(attachments ? { attachments } : {}),
      ...(Object.hasOwn(request, 'objective') ? { objective: request.objective as string } : {}),
    },
  };
}

function validExecutionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export interface ProviderGateway extends ProviderBridge, OllamaBridge { dispose(): void }

// Transport-independent handler so hostile payloads and error sanitization are testable.
export function createProviderGateway(registry: ProviderRegistry, runtime?: Pick<ProviderRuntime, 'getConfiguration' | 'saveConfiguration' | 'removeConfiguration'> & Partial<Pick<ProviderRuntime, 'refreshConnections' | 'selectOllamaModel'>>): ProviderGateway {
  const active = new Set<{ id?: string; providerId: string; controller: AbortController }>();
  let disposed = false;
  let configuring = false;
  // Health checks never acquire or change the Loop execution lock.
  const checking = new Set<string>();
  async function change<T>(action: () => Promise<T>): Promise<ProviderReply<T>> {
    if (disposed) return { ok: false, error: toProviderFailure(new ProviderError('IPC_UNAVAILABLE')) };
    if (active.size || checking.size || configuring) return { ok: false, error: toProviderFailure(new ProviderError('CONFIG_BUSY')) };
    configuring = true;
    try { return { ok: true, value: await action() }; }
    catch (cause) { return { ok: false, error: toProviderFailure(cause) }; }
    finally { configuring = false; }
  }
  function configurationRuntime() {
    if (!runtime) throw new ProviderError('IPC_UNAVAILABLE');
    return runtime;
  }
  return {
    selectOllamaModel: (model) => change(async () => {
      if (!runtime?.selectOllamaModel) throw new ProviderError('IPC_UNAVAILABLE');
      return runtime.selectOllamaModel(model);
    }),
    dispose() {
      disposed = true;
      for (const request of active) request.controller.abort();
    },
    async cancelExecution(executionId: unknown) {
      if (!validExecutionId(executionId)) return { ok: false, error: toProviderFailure(new ProviderError('INVALID_REQUEST')) };
      const matching = [...active].filter((request) => request.id === executionId);
      for (const request of matching) request.controller.abort();
      return { ok: true, value: { cancelled: matching.length > 0 } };
    },
    async getConfiguration(providerId) {
      try { return { ok: true, value: configurationRuntime().getConfiguration(providerId) }; }
      catch (cause) { return { ok: false, error: toProviderFailure(cause) }; }
    },
    saveConfiguration: (input) => change(() => configurationRuntime().saveConfiguration(input)),
    removeConfiguration: (providerId) => change(() => configurationRuntime().removeConfiguration(providerId)),
    async listProviders() {
      try { await runtime?.refreshConnections?.(); return { ok: true, value: registry.list() }; }
      catch (cause) { return { ok: false, error: toProviderFailure(cause) }; }
    },
    async testConnection(providerId: unknown) {
      let acquired: string | undefined;
      try {
        if (!text(providerId, 100) || providerId !== providerId.trim()) throw new ProviderError('INVALID_REQUEST');
        if (configuring) throw new ProviderError('BUSY');
        if (checking.has(providerId)) throw new ProviderError('BUSY');
        const provider = registry.get(providerId);
        if (!provider.testConnection) throw new ProviderError('CHECK_UNSUPPORTED');
        checking.add(providerId);
        acquired = providerId;
        await provider.testConnection();
        return { ok: true, checkedAt: new Date().toISOString() };
      } catch (cause) {
        return connectionCheckFailure(cause);
      } finally {
        if (acquired !== undefined) checking.delete(acquired);
      }
    },
    async executeProvider(value: unknown): Promise<ProviderReply<ProviderResponse>> {
      let acquired: { id?: string; providerId: string; controller: AbortController } | undefined;
      try {
        const { providerId, request, executionId } = validateExecution(value);
        if (disposed) throw new ProviderError('IPC_UNAVAILABLE');
        // Only requests in the same identified Loop may overlap. Legacy callers
        // without an ID retain exclusive execution. No new IPC capability is needed.
        if (configuring || active.size >= MAX_CONCURRENT_STEPS || [...active].some((request) =>
          !executionId || request.id !== executionId || request.providerId === providerId || request.controller.signal.aborted))
          throw new ProviderError('BUSY');
        const provider = registry.get(providerId);
        const controller = new AbortController();
        acquired = { id: executionId, providerId, controller };
        active.add(acquired);
        const response = await abortable(() => provider.execute(request, { signal: controller.signal }), controller.signal);
        throwIfCancelled(controller.signal);
        if (!response || !text(response.output, 200_000)) throw new ProviderError('EXECUTION_FAILED');
        return { ok: true, value: { output: response.output } };
      } catch (cause) {
        return { ok: false, error: toProviderFailure(cause) };
      } finally {
        if (acquired) active.delete(acquired);
      }
    },
  };
}
