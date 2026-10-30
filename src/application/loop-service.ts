// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { cancelLoop, createLoop, normalizeRequest } from '../domain/loop.ts';
import type { CollaborationConfiguration, Loop, LoopMode, LoopStep, PlannedStep } from '../domain/loop.ts';
import type { AIProvider } from '../providers/ai-provider.ts';
import type { ProviderRequest, ProviderResponse } from '../providers/ai-provider.ts';
import type { ProviderRegistry } from '../providers/provider-registry.ts';
import { ProviderError, toProviderFailure } from '../providers/provider-error.ts';
import { abortable, isCancellation, throwIfCancelled } from '../providers/cancellation.ts';
import { canRetryAutoTextStep, waitForAutoStepRetry } from './auto-step-retry.ts';
import type { RetryWait } from './auto-step-retry.ts';
import { dependencyIssue } from '../domain/step-dependencies.ts';
import { MAX_CONCURRENT_STEPS } from '../providers/execution-limits.ts';
import { ProviderSlots } from './provider-slots.ts';

export interface LoopPlanner {
  plan(userRequest: string): readonly PlannedStep[];
  readonly collaboration?: CollaborationConfiguration;
  buildRequest?(request: ProviderRequest, index: number): ProviderRequest;
  validateOutput?(output: string): void;
}

export type LoopObserver = (loop: Loop) => void;

interface AutoTextFallback {
  select(excludedId: string, signal?: AbortSignal, step?: Pick<LoopStep, 'role' | 'isFinal'>): Promise<AIProvider | undefined>;
}

export class LoopService {
  private readonly planner: LoopPlanner;
  private readonly providers: AIProvider | Pick<ProviderRegistry, 'get'>;
  private active = false;
  private readonly autoTextRetry?: { wait?: RetryWait };
  private readonly autoTextFallback?: AutoTextFallback;

  constructor(planner: LoopPlanner, provider: AIProvider | Pick<ProviderRegistry, 'get'>,
    options: { autoTextRetry?: { wait?: RetryWait }; autoTextFallback?: AutoTextFallback } = {}) {
    this.planner = planner;
    this.providers = provider;
    // Explicitly enabled only by today's text-only Auto orchestration.
    // Future tools with side effects must not inherit this policy implicitly.
    this.autoTextRetry = options.autoTextRetry;
    this.autoTextFallback = options.autoTextFallback;
  }

  private provider(id?: string): AIProvider {
    if ('get' in this.providers) {
      if (!id) throw new Error('작업을 맡을 AI를 선택해주세요.');
      return this.providers.get(id);
    }
    if (id && id !== this.providers.id) throw new Error('대기 중인 유효한 Loop만 시작할 수 있습니다.');
    return this.providers;
  }

  create(userRequest: string, mode: LoopMode = this.planner.collaboration ? 'manual' : 'auto'): Loop {
    const request = normalizeRequest(userRequest);
    return createLoop(request, this.planner.plan(request), (id) => this.provider(id), { mode, collaboration: this.planner.collaboration });
  }

  async run(initial: Loop, onUpdate: LoopObserver = () => {}, options: { signal?: AbortSignal } = {}): Promise<Loop> {
    if (this.active) throw new Error('현재 작업이 끝난 뒤 새 Loop를 시작해주세요.');
    if (initial.status !== 'pending' || initial.steps.length === 0
      || initial.steps.some((step) => step.status !== 'pending')) {
      throw new Error('대기 중인 유효한 Loop만 시작할 수 있습니다.');
    }
    if (this.planner.collaboration) {
      const expected = this.planner.plan(initial.userRequest);
      const configuration = this.planner.collaboration;
      if (initial.collaboration?.strategy !== configuration.strategy
        || initial.collaboration.primaryProviderId !== configuration.primaryProviderId
        || initial.collaboration.reviewerProviderId !== configuration.reviewerProviderId
        || initial.steps.length !== expected.length || initial.steps.some((step, index) =>
          step.title !== expected[index]?.title || step.role !== expected[index]?.role
          || step.assignedProvider.id !== expected[index]?.providerId)) {
        throw new Error('대기 중인 유효한 Loop만 시작할 수 있습니다.');
      }
    } else if (initial.collaboration) throw new Error('대기 중인 유효한 Loop만 시작할 수 있습니다.');
    // Resolve all assignments before spending on the first step. Keep this run's adapters stable.
    const providers = initial.steps.map((step) => this.provider(step.assignedProvider.id));
    const automatic = initial.mode === 'auto' && !!initial.auto && !initial.collaboration;
    if (automatic && dependencyIssue(initial.steps)) throw new ProviderError('INVALID_REQUEST');
    const parallel = automatic && initial.steps.every((step) => step.dependsOn !== undefined);

    this.active = true;
    let loop: Loop = { ...initial, status: 'running', startedAt: initial.startedAt ?? new Date().toISOString() };
    const previousOutputs: string[] = [];
    let retryAvailable = !!this.autoTextRetry && initial.mode === 'auto' && !!initial.auto && !initial.collaboration;
    let fallbackAvailable = automatic && !!this.autoTextFallback;
    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
    const slots = new ProviderSlots();
    let failure: string | undefined;
    const updateStep = (id: string, changes: Partial<LoopStep>): void => {
      loop = { ...loop, steps: loop.steps.map((step) => step.id === id ? { ...step, ...changes } : step) };
    };
    const cancelled = (): Loop => { loop = cancelLoop(loop); onUpdate(loop); return loop; };

    const executeStep = async (index: number): Promise<void> => {
      const step = initial.steps[index]!;
      if (signal.aborted) return;
      updateStep(step.id, { status: 'running', startedAt: new Date().toISOString() });
      onUpdate(loop);

      let output: string;
      try {
        throwIfCancelled(signal);
        let provider = providers[index]!;
        const previous = loop.steps[parallel ? (step.dependsOn!.at(-1) ?? 0) - 1 : index - 1];
        // Adjust only a conflicting review after an actual assignment change.
        // Keep all other planned assignments and completed steps untouched.
        if (automatic && this.autoTextFallback && step.role === 'review' && previous?.originalProvider
          && previous.assignedProvider.id === provider.id) {
          const reviewer = await this.autoTextFallback.select(previous.assignedProvider.id, signal, step);
          throwIfCancelled(signal);
          if (reviewer && reviewer.id !== previous.assignedProvider.id) {
            provider = reviewer;
            updateStep(step.id, { originalProvider: step.assignedProvider,
              assignedProvider: { id: provider.id, displayName: provider.displayName } });
            onUpdate(loop);
            throwIfCancelled(signal);
          }
        }
        const request: ProviderRequest = {
          userRequest: loop.userRequest,
          stepTitle: step.title,
          previousOutputs: parallel ? step.dependsOn!.map((ref) => loop.steps[ref - 1]!.output!) : [...previousOutputs],
          isFinalStep: step.isFinal ?? index === initial.steps.length - 1,
        };
        const builtRequest = this.planner.buildRequest?.(request, index) ?? request;
        // Preserve the exact input across attempts, even with an injected adapter.
        const executionRequest = Object.freeze({ ...builtRequest, previousOutputs: Object.freeze([...builtRequest.previousOutputs]) });
        throwIfCancelled(signal);
        const execute = (target: AIProvider, changes?: Partial<LoopStep>): Promise<ProviderResponse> =>
          slots.run(target.id, signal, async () => {
            throwIfCancelled(signal);
            if (changes) updateStep(step.id, changes);
            const pending = target.execute(executionRequest, { signal, executionId: loop.id });
            if (changes) onUpdate(loop);
            return pending;
          });
        let response: ProviderResponse;
        try {
          try {
            response = await execute(provider);
          } catch (cause) {
            throwIfCancelled(signal);
            if (!retryAvailable || !canRetryAutoTextStep(cause)) throw cause;
            // Reserve synchronously before waiting so parallel failures cannot both retry.
            retryAvailable = false;
            updateStep(step.id, { retryPending: true });
            onUpdate(loop);
            throwIfCancelled(signal);
            await abortable(() => (this.autoTextRetry?.wait ?? waitForAutoStepRetry)(signal), signal);
            response = await execute(provider, { retryPending: false, retryCount: 1 });
          }
        } catch (cause) {
          throwIfCancelled(signal);
          if (!fallbackAvailable || !canRetryAutoTextStep(cause)) throw cause;
          // Reserve before asynchronous lookup or provider-slot waiting.
          fallbackAvailable = false;
          const alternative = await this.autoTextFallback!.select(provider.id, signal, step);
          throwIfCancelled(signal);
          if (!alternative || alternative.id === provider.id) throw new ProviderError('FALLBACK_UNAVAILABLE');
          // Deliberately outside the retry/fallback catches: exactly one alternative call.
          response = await execute(alternative, { originalProvider: loop.steps[index]!.originalProvider ?? step.assignedProvider,
            assignedProvider: { id: alternative.id, displayName: alternative.displayName }, fallbackCount: 1 });
        }
        throwIfCancelled(signal);
        output = response.output;
        this.planner.validateOutput?.(output);
        if (!output.trim()) throw new Error('AI가 비어 있는 결과를 반환했습니다.');
      } catch (cause: unknown) {
        if (signal.aborted) return;
        if (isCancellation(cause, options.signal)) { stop.abort(); return; }
        const error = initial.collaboration || initial.auto
          ? `${loop.steps[index]!.assignedProvider.displayName} ${step.title} 단계에서 작업을 완료하지 못했습니다. ${toProviderFailure(cause).message}`
          : cause instanceof Error ? cause.message : '작업 중 알 수 없는 오류가 발생했습니다.';
        const completedAt = new Date().toISOString();
        updateStep(step.id, { status: 'failed', completedAt, error, retryPending: false });
        failure = error;
        // Internal sibling abort must not turn the failing Loop into user cancellation.
        stop.abort();
        onUpdate(loop);
        return;
      }

      previousOutputs[index] = output;
      updateStep(step.id, { status: 'completed', completedAt: new Date().toISOString(), output });
      onUpdate(loop);
    };

    try {
      onUpdate(loop);
      if (parallel) {
        const active = new Map<number, Promise<void>>();
        while (!signal.aborted) {
          for (const [index, step] of loop.steps.entries()) {
            if (signal.aborted || active.size >= MAX_CONCURRENT_STEPS) break;
            if (step.status !== 'pending' || active.has(index) || slots.has(step.assignedProvider.id)
              || !step.dependsOn!.every((ref) => loop.steps[ref - 1]!.status === 'completed')) continue;
            const pending = executeStep(index).finally(() => active.delete(index));
            active.set(index, pending);
          }
          if (!active.size) break;
          await Promise.race(active.values());
        }
        // Wait for every IPC response/cancellation acknowledgement before allowing Start.
        await Promise.allSettled(active.values());
      } else {
        for (const index of initial.steps.keys()) { if (signal.aborted) break; await executeStep(index); }
      }

      if (failure) {
        const completedAt = new Date().toISOString();
        loop = { ...loop, status: 'failed', completedAt, error: failure,
          steps: loop.steps.map((step) => step.status === 'running'
            ? { ...step, status: 'cancelled', completedAt, retryPending: false } : step) };
        onUpdate(loop); return loop;
      }
      if (signal.aborted) return cancelled();

      loop = {
        ...loop,
        status: 'completed',
        completedAt: new Date().toISOString(),
        finalResult: initial.auto ? previousOutputs[initial.steps.findIndex((step) => step.isFinal)] : previousOutputs.at(-1),
      };
      onUpdate(loop);
      return loop;
    } finally {
      this.active = false;
    }
  }
}
