// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { cancelLoop, normalizeRequest } from '../domain/loop.ts';
import { abortable, isCancellation, throwIfCancelled } from '../providers/cancellation.ts';
import type { Loop } from '../domain/loop.ts';
import { ProviderError } from '../providers/provider-error.ts';
import { LoopService } from './loop-service.ts';
import type { LoopObserver } from './loop-service.ts';
import { TaskPlanner } from './task-planner.ts';
import { autoProviderPool, assignAutoProviders, selectAlternativeProvider } from './auto-router.ts';
import type { AutoRegistry } from './auto-router.ts';
import type { RetryWait } from './auto-step-retry.ts';
import { eligibleForStep, roleEligibility } from './role-eligibility.ts';

export const AUTO_OUTPUT_LIMIT = 20_000;
export const AUTO_CONTEXT_LIMIT = 40_000;

// Keep newest complete results first in priority, then restore chronological order.
// An oversized individual result fails at its source; it is never silently clipped.
export function autoContext(outputs: readonly string[]): string[] {
  const selected: string[] = [];
  let length = 0;
  for (let index = outputs.length - 1; index >= 0; index--) {
    const output = outputs[index]!;
    if (length + output.length > AUTO_CONTEXT_LIMIT) break;
    selected.unshift(output); length += output.length;
  }
  return selected;
}

export class AutoLoopService {
  private readonly registry: AutoRegistry;
  private readonly allowTestMock: boolean;
  private active = false;
  private readonly retryWait?: RetryWait;
  private readonly refreshRegistry: () => Promise<AutoRegistry>;
  constructor(registry: AutoRegistry, options: { allowTestMock?: boolean; retryWait?: RetryWait;
    refreshRegistry?: () => Promise<AutoRegistry> } = {}) {
    this.registry = registry;
    // Explicit injection for offline tests only; ordinary UI never enables this.
    this.allowTestMock = options.allowTestMock ?? false;
    this.retryWait = options.retryWait;
    this.refreshRegistry = options.refreshRegistry ?? (async () => this.registry);
  }

  async run(userRequest: string, onUpdate: LoopObserver = () => {}, options: { signal?: AbortSignal } = {}): Promise<Loop> {
    if (this.active) throw new Error('현재 작업이 끝난 뒤 새 Loop를 시작해주세요.');
    const request = normalizeRequest(userRequest);
    if (request.length > 20_000) throw new Error('작업 요청은 20,000자 이하로 입력해주세요.');
    this.active = true;
    const now = new Date().toISOString();
    let loop: Loop = { id: crypto.randomUUID(), userRequest: request, mode: 'auto', status: 'running',
      createdAt: now, startedAt: now, steps: [], auto: { phase: 'planning' } };
    let failure = '먼저 사용할 AI를 연결해주세요.';
    try {
      onUpdate(loop);
      throwIfCancelled(options.signal);
      const pool = autoProviderPool(this.registry, this.allowTestMock);
      const planner = pool.find((provider) => {
        const summary = this.registry.list().find((entry) => entry.id === provider.id);
        return summary && roleEligibility(summary, 'planning').eligible;
      });
      if (!planner) throw new Error('작업 계획 역할을 수행할 AI가 없습니다.');
      loop = { ...loop, auto: { phase: 'planning', planner: { id: planner.id, displayName: planner.displayName } } };
      onUpdate(loop);
      throwIfCancelled(options.signal);
      failure = '작업 계획을 만들지 못했습니다.';
      const plan = await new TaskPlanner(planner).plan(request, { signal: options.signal, executionId: loop.id }, () => {
        loop = { ...loop, auto: { ...loop.auto!, phase: 'recovering' } };
        onUpdate(loop);
      });
      throwIfCancelled(options.signal);
      failure = '작업을 맡을 AI를 배정하지 못했습니다.';
      const assigned = assignAutoProviders(plan, pool, this.registry);
      // Recheck availability after planning before any work request is spent.
      for (const step of assigned) {
        this.registry.get(step.providerId!);
        const summary = this.registry.list().find((entry) => entry.id === step.providerId);
        if (!summary || !eligibleForStep(summary, step)) throw new ProviderError('CONFIG_MISSING');
      }
      const stable = new Map(pool.map((provider) => [provider.id, provider]));
      const service = new LoopService({
        plan: () => assigned,
        buildRequest: (input, index) => {
          const step = plan.steps[index]!;
          return { ...input, objective: step.objective, isFinalStep: step.isFinal,
            previousOutputs: step.usesPreviousOutputs ? autoContext(input.previousOutputs) : [] };
        },
        validateOutput: (output) => {
          if (typeof output !== 'string' || !output.trim() || output.length > AUTO_OUTPUT_LIMIT) throw new ProviderError('EXECUTION_FAILED');
        },
      }, { get: (id) => {
        const provider = stable.get(id);
        if (!provider) throw new ProviderError('PROVIDER_NOT_FOUND');
        return provider;
      } }, { autoTextRetry: { wait: this.retryWait }, autoTextFallback: {
        select: async (excludedId, signal, step) => {
          const current = await abortable(this.refreshRegistry, signal);
          throwIfCancelled(signal);
          const selected = selectAlternativeProvider(current, excludedId, step);
          throwIfCancelled(signal);
          return selected;
        },
      } });
      const created = service.create(request, 'auto');
      loop = { ...created, id: loop.id, createdAt: loop.createdAt, startedAt: loop.startedAt,
        auto: { ...loop.auto!, phase: 'executing', title: plan.title } };
      return await service.run(loop, onUpdate, options);
    } catch (cause) {
      loop = isCancellation(cause, options.signal) ? cancelLoop(loop)
        : { ...loop, status: 'failed', completedAt: new Date().toISOString(), error: failure };
      onUpdate(loop); return loop;
    } finally { this.active = false; }
  }
}
