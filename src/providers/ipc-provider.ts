// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { AIProvider, ProviderExecutionOptions, ProviderRequest, ProviderResponse } from './ai-provider.ts';
import { throwIfCancelled } from './cancellation.ts';
import type { ProviderBridge } from './provider-ipc.ts';
import type { ProviderConnection } from './provider-registry.ts';
import { ProviderError } from './provider-error.ts';

// Renderer-side adapter contains public identity and a narrow bridge, never credentials.
export class IpcProvider implements AIProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly bridge: ProviderBridge;

  constructor(connection: ProviderConnection, bridge: ProviderBridge) {
    this.id = connection.id;
    this.displayName = connection.displayName;
    this.bridge = bridge;
  }

  async execute(request: ProviderRequest, options?: ProviderExecutionOptions): Promise<ProviderResponse> {
    const signal = options?.signal;
    throwIfCancelled(signal);
    const executionId = options?.executionId ?? crypto.randomUUID();
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => {
      cancellation ??= this.bridge.cancelExecution(executionId).catch(() => undefined);
    };
    try {
      // Queue execution before its cancellation. No signal/controller crosses IPC.
      const pending = this.bridge.executeProvider({ providerId: this.id, request, executionId });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const reply = await pending;
      await cancellation;
      throwIfCancelled(signal);
      if (!reply.ok) throw new ProviderError(reply.error.code, reply.error.httpStatus);
      return reply.value;
    } catch (cause) {
      throwIfCancelled(signal);
      if (cause instanceof ProviderError) throw cause;
      throw new ProviderError('IPC_UNAVAILABLE');
    } finally { signal?.removeEventListener('abort', cancel); }
  }
}
