// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { ProviderConnection } from '../providers/provider-registry.ts';
import { modelRoles, validModelIdentity } from '../providers/model-capability.ts';
import type { ModelRole } from '../providers/model-capability.ts';
import { modelQualityState } from './model-quality.ts';

export function roleEligibility(connection: ProviderConnection, role: ModelRole): { eligible: boolean; reason: string } {
  const no = (reason: string) => ({ eligible: false, reason });
  if (!modelRoles.includes(role)) return no('unsupported_role');
  if (!connection.configured) return no('unavailable');
  if (connection.singleOnly) return no('single_only');
  const policy = connection.modelPolicy;
  // Legacy API providers retain their existing configured/text-only policy.
  if (policy === undefined) return { eligible: true, reason: 'existing_policy' };
  if (!policy || policy.installed !== true || policy.serverAvailable !== true) return no('unavailable');
  const model = policy.model;
  if (!model || !validModelIdentity(model.identity) || model.identity.providerId !== connection.id) return no('identity_missing');
  if (model.local !== true || !Array.isArray(model.capabilities)
    || !model.capabilities.includes('completion')) return no('capability_missing');
  const quality = modelQualityState(model, role, policy.evaluations);
  if (quality !== 'verified') return no(quality);
  if (policy.permitted !== true) return no('not_permitted');
  if (policy.costAllowed !== true || policy.concurrencyAllowed !== true) return no('execution_policy');
  return { eligible: true, reason: 'verified' };
}

export function eligibleForStep(connection: ProviderConnection, step: { role?: string; isFinal?: boolean }): boolean {
  return modelRoles.includes(step.role as ModelRole) && roleEligibility(connection, step.role as ModelRole).eligible
    && (!step.isFinal || roleEligibility(connection, 'deliver').eligible);
}
