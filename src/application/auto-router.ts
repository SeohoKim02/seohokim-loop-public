// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { AIProvider } from '../providers/ai-provider.ts';
import type { ProviderRegistry } from '../providers/provider-registry.ts';
import type { PlannedStep } from '../domain/loop.ts';
import type { TaskPlan } from './task-planner.ts';
import { eligibleForStep, roleEligibility } from './role-eligibility.ts';
import { modelRoles } from '../providers/model-capability.ts';

export type AutoRegistry = Pick<ProviderRegistry, 'list' | 'get'>;

// Today's AIProvider contract is text generation. Never substitute demo output.
export function selectAlternativeProvider(registry: AutoRegistry, excludedId: string, step?: Pick<PlannedStep, 'role' | 'isFinal'>): AIProvider | undefined {
  for (const summary of registry.list()) {
    if (summary.singleOnly || summary.id === excludedId || summary.type === 'mock' || !summary.configured) continue;
    if (step ? !eligibleForStep(summary, step) : summary.modelPolicy !== undefined) continue;
    try { return registry.get(summary.id); }
    catch { /* A stale/unavailable runtime entry is not an executable candidate. */ }
  }
  return undefined;
}

// Stable registry order. Model-qualified connections need at least one verified role.
export function autoProviderPool(registry: AutoRegistry, allowTestMock = false): readonly AIProvider[] {
  const real: AIProvider[] = [];
  const mock: AIProvider[] = [];
  for (const summary of registry.list()) {
    if (summary.singleOnly || !summary.configured) continue;
    if (!modelRoles.some((role) => roleEligibility(summary, role).eligible)) continue;
    try { (summary.type === 'mock' ? mock : real).push(registry.get(summary.id)); }
    catch { /* An unavailable runtime adapter cannot be assigned. */ }
  }
  const pool = real.length ? real : allowTestMock ? mock : [];
  if (!pool.length) throw new Error('먼저 사용할 AI를 연결해주세요.');
  return pool;
}

export function assignAutoProviders(plan: TaskPlan, pool: readonly AIProvider[], registry?: AutoRegistry): readonly PlannedStep[] {
  if (!pool.length) throw new Error('작업을 맡을 AI를 배정하지 못했습니다.');
  const counts = new Map(pool.map((provider) => [provider.id, 0]));
  const assigned: string[] = [];
  let previous: string | undefined;
  return plan.steps.map((step) => {
    const eligible = registry ? pool.filter((provider) => {
      const summary = registry.list().find((entry) => entry.id === provider.id);
      return summary && eligibleForStep(summary, step);
    }) : pool;
    if (!eligible.length) throw new Error('이 단계의 역할 검증을 마친 AI가 없습니다.');
    const producer = step.dependsOn ? assigned[(step.dependsOn.at(-1) ?? 0) - 1] : previous;
    const candidates = step.role === 'review' && eligible.length > 1
      ? eligible.filter((provider) => provider.id !== producer) : eligible;
    // Least used within this plan; ties keep registry order. No vendor ranking.
    const selected = candidates.reduce((best, candidate) => counts.get(candidate.id)! < counts.get(best.id)! ? candidate : best);
    counts.set(selected.id, counts.get(selected.id)! + 1);
    previous = selected.id;
    assigned.push(selected.id);
    return { ...step, providerId: selected.id };
  });
}
