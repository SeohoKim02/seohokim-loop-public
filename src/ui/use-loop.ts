// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { LoopService } from '../application/loop-service.ts';
import { MockPlanner } from '../application/mock-planner.ts';
import { DraftReviewImprove } from '../application/draft-review-improve.ts';
import { manualCollaborationPolicy } from '../application/manual-collaboration-policy.ts';
import { AutoLoopService } from '../application/auto-loop-service.ts';
import { ProviderRegistry } from '../providers/provider-registry.ts';
import { IpcProvider } from '../providers/ipc-provider.ts';
import { ProviderError } from '../providers/provider-error.ts';
import type { ProviderConnection } from '../providers/provider-registry.ts';
import type { Loop } from '../domain/loop.ts';
import { isTerminalLoop } from '../domain/loop.ts';
import { validateAttachmentInput, withTextAttachments } from '../providers/text-attachments.ts';
import type { TextAttachment } from '../providers/text-attachments.ts';

export function useLoop(providers: readonly ProviderConnection[]) {
  const [providerId, setProviderId] = useState('mock');
  const [executionMode, setExecutionMode] = useState<'auto' | 'single' | 'collaboration'>('auto');
  const [reviewerId, setReviewerId] = useState('');
  const [experimentalConsent, setExperimentalConsent] = useState(false);
  useEffect(() => { setExperimentalConsent(false); }, [providerId, reviewerId, executionMode]);
  const [loop, setLoop] = useState<Loop>();
  const [error, setError] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const currentLoop = useRef<Loop | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);

  function update(loop: Loop): void { currentLoop.current = loop; setLoop(loop); }

  function cancel(): void {
    if (!busy.current || !controller.current || controller.current.signal.aborted
      || (currentLoop.current && isTerminalLoop(currentLoop.current))) return;
    setIsCancelling(true);
    controller.current.abort();
  }

  async function start(userRequest: string, files: readonly TextAttachment[] = []): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    const execution = new AbortController();
    controller.current = execution;
    setIsCancelling(false);
    setError(undefined);
    try {
      if (!window.seohoKimLoop) throw new ProviderError('IPC_UNAVAILABLE');
      const attachments = validateAttachmentInput(userRequest.trim(), files);
      // This registry contains only public identities and IPC adapters, never credentials.
      const registry = new ProviderRegistry();
      for (const summary of providers) registry.register(withTextAttachments(new IpcProvider(summary, window.seohoKimLoop), attachments), summary);
      if (executionMode === 'auto') {
        setIsRunning(true);
        await new AutoLoopService(registry, { refreshRegistry: async () => {
          const reply = await window.seohoKimLoop!.listProviders();
          if (!reply.ok) throw new ProviderError(reply.error.code);
          const current = new ProviderRegistry();
          for (const summary of reply.value) current.register(withTextAttachments(new IpcProvider(summary, window.seohoKimLoop!), attachments), summary);
          return current;
        } }).run(userRequest, update, { signal: execution.signal });
        return;
      }
      const connection = providers.find((provider) => provider.id === providerId);
      if (!connection) throw new ProviderError('PROVIDER_NOT_FOUND');
      if (!connection.configured) throw new ProviderError(connection.unavailableReason ?? 'CONFIG_MISSING');
      if (executionMode === 'collaboration') {
        const policy = manualCollaborationPolicy(connection, providers.find((provider) => provider.id === reviewerId));
        if (!policy.allowed || (policy.experimental && (!experimentalConsent || attachments.length))) throw new ProviderError('INVALID_REQUEST');
        // Consent is per run, not a saved connection permission.
        if (policy.experimental) setExperimentalConsent(false);
      }
      const service = executionMode === 'collaboration'
        ? new LoopService(new DraftReviewImprove(providerId, reviewerId), registry)
        : new LoopService(new MockPlanner(connection.type === 'mock' ? 'demo' : 'single-work'), registry.get(providerId));
      const created = service.create(userRequest, 'manual');
      update(created);
      setIsRunning(true);
      await service.run(created, update, { signal: execution.signal });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Loop를 시작하지 못했습니다. 다시 시도해주세요.');
    } finally {
      busy.current = false;
      controller.current = undefined;
      setIsCancelling(false);
      setIsRunning(false);
    }
  }

  return { loop, error, isRunning, isCancelling, start, cancel, providerId, setProviderId, reviewerId, setReviewerId, executionMode, setExecutionMode, experimentalConsent, setExperimentalConsent };
}
