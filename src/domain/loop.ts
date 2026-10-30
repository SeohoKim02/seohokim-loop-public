// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

export type LoopMode = 'auto' | 'manual';
export type LoopStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = LoopStatus;
export type CollaborationRole = 'primary' | 'reviewer';
export type AutoRole = 'analyze' | 'write' | 'review' | 'improve' | 'deliver';

export interface CollaborationConfiguration {
  readonly strategy: string;
  readonly primaryProviderId: string;
  readonly reviewerProviderId: string;
}

export interface PlannedStep {
  title: string;
  providerId?: string;
  role?: CollaborationRole | AutoRole;
  objective?: string;
  usesPreviousOutputs?: boolean;
  dependsOn?: readonly number[];
  isFinal?: boolean;
}

export interface LoopStep {
  readonly id: string;
  readonly title: string;
  readonly status: StepStatus;
  readonly assignedProvider: { readonly id: string; readonly displayName: string };
  readonly originalProvider?: { readonly id: string; readonly displayName: string };
  readonly fallbackCount?: 0 | 1;
  readonly role?: CollaborationRole | AutoRole;
  readonly objective?: string;
  readonly usesPreviousOutputs?: boolean;
  readonly dependsOn?: readonly number[];
  readonly isFinal?: boolean;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly output?: string;
  readonly error?: string;
  readonly retryCount: number;
  readonly retryPending?: boolean;
}

export interface Loop {
  readonly id: string;
  readonly userRequest: string;
  readonly mode: LoopMode;
  readonly collaboration?: CollaborationConfiguration;
  readonly auto?: { readonly phase: 'planning' | 'recovering' | 'executing'; readonly title?: string;
    readonly planner?: { readonly id: string; readonly displayName: string } };
  readonly status: LoopStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly steps: readonly LoopStep[];
  readonly finalResult?: string;
  readonly error?: string;
}

export function normalizeRequest(userRequest: string): string {
  const trimmed = userRequest.trim();
  if (!trimmed) throw new Error('작업 내용을 입력해주세요.');
  return trimmed;
}

export function isTerminalLoop(loop: Loop): boolean {
  return loop.status === 'completed' || loop.status === 'failed' || loop.status === 'cancelled';
}

export function cancelLoop(loop: Loop): Loop {
  if (isTerminalLoop(loop)) return loop;
  const completedAt = new Date().toISOString();
  return { ...loop, status: 'cancelled', completedAt, finalResult: undefined, error: undefined,
    steps: loop.steps.map((step) => step.status === 'running'
      ? { ...step, status: 'cancelled', completedAt, retryPending: false } : step) };
}

export function createLoop(
  userRequest: string,
  plan: readonly PlannedStep[],
  provider: LoopStep['assignedProvider'] | ((id?: string) => LoopStep['assignedProvider']),
  options: { mode?: LoopMode; collaboration?: CollaborationConfiguration } = {},
): Loop {
  const request = normalizeRequest(userRequest);
  if (plan.length === 0 || plan.some((step) => !step.title.trim())) {
    throw new Error('실행할 작업 단계가 없습니다.');
  }

  return {
    id: crypto.randomUUID(),
    userRequest: request,
    mode: options.mode ?? 'auto',
    ...(options.collaboration ? { collaboration: { ...options.collaboration } } : {}),
    status: 'pending',
    createdAt: new Date().toISOString(),
    steps: plan.map((step) => {
      const assigned = typeof provider === 'function' ? provider(step.providerId) : provider;
      return {
        id: crypto.randomUUID(),
        title: step.title.trim(),
        status: 'pending',
        assignedProvider: { id: assigned.id, displayName: assigned.displayName },
        ...(step.role ? { role: step.role } : {}),
        ...(step.dependsOn !== undefined ? { dependsOn: Object.freeze([...step.dependsOn]) } : {}),
        ...(step.objective !== undefined ? { objective: step.objective, usesPreviousOutputs: step.usesPreviousOutputs, isFinal: step.isFinal } : {}),
        retryCount: 0,
        fallbackCount: 0,
      };
    }),
  };
}
