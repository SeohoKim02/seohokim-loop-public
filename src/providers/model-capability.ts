// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { AutoRole } from '../domain/loop.ts';

export type ModelRole = 'planning' | AutoRole;
export const modelRoles: readonly ModelRole[] = ['planning', 'analyze', 'write', 'review', 'improve', 'deliver'];
export interface ModelIdentity {
  providerId: string;
  modelId: string;
  digest: string;
  runtimeVersion: string;
}

export function validModelIdentity(value: ModelIdentity | undefined): value is ModelIdentity {
  return !!value && [value.providerId, value.modelId].every((part) => typeof part === 'string' && !!part.trim() && part.length <= 200)
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
    && typeof value.runtimeVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value.runtimeVersion);
}

// Server declarations describe possible features, never measured answer quality.
export interface TechnicalModel {
  identity: ModelIdentity;
  local: boolean;
  capabilities: string[];
  format: string;
  parameterSize?: string;
  quantization?: string;
  advertisedContextLength?: number;
  licensePresent: boolean;
}

export type QualityState = 'not_evaluated' | 'verified' | 'failed' | 'stale';
export type QualityCriterion = 'text' | 'korean' | 'plan' | 'context' | 'review' | 'synthesis' | 'role_review';
export interface QualityCheck {
  criterion: QualityCriterion;
  result: 'passed' | 'failed' | 'not_evaluated';
  method: 'automatic' | 'human';
}
export interface QualityEvaluation {
  identity: ModelIdentity;
  role: ModelRole;
  policyVersion: string;
  technicalSignature: string;
  source: 'local_execution' | 'fake';
  checkedAt: string;
  status: Exclude<QualityState, 'stale'>;
  checks: QualityCheck[];
}

// Optional opt-in model qualification. Existing API policies remain unchanged.
// These flags do not reserve runtime slots or override the gateway's limits.
export interface ModelAutoPolicy {
  model?: TechnicalModel;
  installed: boolean;
  serverAvailable: boolean;
  permitted: boolean;
  costAllowed: boolean;
  concurrencyAllowed: boolean;
  evaluations: readonly QualityEvaluation[];
}

export function copyTechnicalModel(model: TechnicalModel): TechnicalModel {
  const identity = model.identity;
  return { identity: { providerId: identity.providerId, modelId: identity.modelId, digest: identity.digest, runtimeVersion: identity.runtimeVersion },
    local: model.local, capabilities: [...model.capabilities], format: model.format, parameterSize: model.parameterSize,
    quantization: model.quantization, advertisedContextLength: model.advertisedContextLength, licensePresent: model.licensePresent };
}

export function copyModelPolicy(policy: ModelAutoPolicy): ModelAutoPolicy {
  return { model: policy.model && copyTechnicalModel(policy.model), installed: policy.installed, serverAvailable: policy.serverAvailable,
    permitted: policy.permitted, costAllowed: policy.costAllowed, concurrencyAllowed: policy.concurrencyAllowed,
    evaluations: policy.evaluations.map((entry) => ({ identity: { providerId: entry.identity.providerId, modelId: entry.identity.modelId,
      digest: entry.identity.digest, runtimeVersion: entry.identity.runtimeVersion }, role: entry.role, policyVersion: entry.policyVersion,
      technicalSignature: entry.technicalSignature, source: entry.source, checkedAt: entry.checkedAt, status: entry.status,
      checks: entry.checks.map((check) => ({ criterion: check.criterion, result: check.result, method: check.method })) })) };
}
