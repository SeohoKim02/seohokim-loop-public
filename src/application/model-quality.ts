// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { parseTaskPlan } from './task-planner.ts';
import { validModelIdentity } from '../providers/model-capability.ts';
import type { ModelRole, TechnicalModel, QualityCriterion, QualityCheck, QualityEvaluation, QualityState } from '../providers/model-capability.ts';

export const MODEL_QUALITY_POLICY = 'local-text-roles-v1';
export const roleCriteria: Readonly<Record<ModelRole, readonly QualityCriterion[]>> = {
  planning: ['text', 'korean', 'plan', 'role_review'],
  analyze: ['text', 'korean', 'context', 'role_review'],
  write: ['text', 'korean', 'context', 'role_review'],
  review: ['text', 'korean', 'context', 'review', 'role_review'],
  improve: ['text', 'korean', 'context', 'role_review'],
  deliver: ['text', 'korean', 'context', 'synthesis', 'role_review'],
};

// Fixed, tiny future evaluation fixtures; no runner, network or automatic approval.
export const qualityFixtures = {
  text: '다음 문자열만 정확히 출력하세요: LOOP_OK',
  korean: '다음 한국어 문장만 정확히 출력하세요: 확인했습니다.',
  context: '이전 결과에 있는 가와 나의 값을 더해 합계 숫자만 출력하세요.',
  contextInputs: ['가=17', '나=23'],
} as const;

// Envelope completion must already have passed the provider adapter validation.
// This checks only objective output shape; it never certifies subjective quality.
export function checkQualityOutput(criterion: QualityCriterion, output: string): QualityCheck {
  if (['review', 'synthesis', 'role_review'].includes(criterion)) return { criterion, result: 'not_evaluated', method: 'human' };
  let passed = false;
  if (typeof output === 'string') {
    if (criterion === 'text') passed = output.trim() === 'LOOP_OK';
    if (criterion === 'korean') passed = output.trim() === '확인했습니다.';
    if (criterion === 'context') passed = output.trim() === '40';
    if (criterion === 'plan') { try { parseTaskPlan(output); passed = true; } catch { /* Same production validator. */ } }
  }
  return { criterion, result: passed ? 'passed' : 'failed', method: 'automatic' };
}

export function technicalSignature(model: TechnicalModel): string {
  // Conservative invalidation, including declared context. No timestamps: a
  // server restart with identical metadata must not erase evaluation evidence.
  return JSON.stringify([model.local, model.format, [...model.capabilities].sort(),
    model.advertisedContextLength ?? null, model.parameterSize ?? null, model.quantization ?? null]);
}
function checkState(role: ModelRole, checks: readonly QualityCheck[]): QualityState {
  const required = roleCriteria[role];
  if (!required || !Array.isArray(checks) || checks.length > 7) return 'stale';
  if (new Set(checks.map((check) => check?.criterion)).size !== checks.length
    || checks.some((check) => !check || !['text', 'korean', 'plan', 'context', 'review', 'synthesis', 'role_review'].includes(check.criterion)
      || !['passed', 'failed', 'not_evaluated'].includes(check.result)
      || check.method !== (['review', 'synthesis', 'role_review'].includes(check.criterion) ? 'human' : 'automatic'))) return 'stale';
  const relevant = required.map((criterion) => checks.find((check) => check.criterion === criterion));
  if (relevant.some((check) => check?.result === 'failed')) return 'failed';
  return relevant.every((check) => check?.result === 'passed') ? 'verified' : 'not_evaluated';
}

// Trusted evaluation harness only. No IPC setter and no automatic ingestion of
// History, model names, old smoke reports or fake executions. No prompt/output stored.
export function recordQualityEvaluation(model: TechnicalModel, role: ModelRole,
  source: QualityEvaluation['source'], checks: readonly QualityCheck[], checkedAt: string): QualityEvaluation {
  const state = checkState(role, checks);
  const identified = validModelIdentity(model.identity) && Number.isFinite(Date.parse(checkedAt));
  return { identity: { ...model.identity }, role, policyVersion: MODEL_QUALITY_POLICY,
    technicalSignature: technicalSignature(model), source, checkedAt,
    status: !identified || source !== 'local_execution' || state === 'stale' ? 'not_evaluated' : state,
    checks: checks.map((check) => ({ ...check })) };
}

export function modelQualityState(model: TechnicalModel | undefined, role: ModelRole, evaluations: readonly QualityEvaluation[]): QualityState {
  if (!Array.isArray(evaluations) || evaluations.length > 6 || evaluations.some((entry) => !entry || typeof entry !== 'object')) return 'stale';
  const matches = evaluations.filter((entry) => entry.role === role);
  if (!matches.length) return 'not_evaluated';
  if (matches.length !== 1 || !model || !validModelIdentity(model.identity) || !Array.isArray(model.capabilities)) return 'stale';
  const entry = matches[0]!;
  if (!entry.identity || Object.keys(model.identity).some((key) => entry.identity[key as keyof typeof entry.identity] !== model.identity[key as keyof typeof model.identity])
    || entry.policyVersion !== MODEL_QUALITY_POLICY || entry.technicalSignature !== technicalSignature(model)
    || typeof entry.checkedAt !== 'string' || !Number.isFinite(Date.parse(entry.checkedAt))
    || !['verified', 'failed', 'not_evaluated'].includes(entry.status)) return 'stale';
  const state = checkState(role, entry.checks);
  if (state === 'stale') return state;
  if (entry.source === 'fake') return 'not_evaluated';
  if (entry.source !== 'local_execution' || entry.status !== state) return 'stale';
  return state;
}
