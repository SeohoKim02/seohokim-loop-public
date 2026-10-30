// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { ProviderConnection } from '../providers/provider-registry.ts';

// A narrow explicit-selection exception, never an Auto/quality eligibility grant.
export function localManualCandidate(connection: ProviderConnection | undefined, role: 'primary' | 'reviewer'): boolean {
  return !!connection?.configured && connection.singleOnly === true && connection.experimentalManual === true
    && (role === 'primary' ? connection.id === 'ollama-local' && connection.type === 'local-ollama'
      : connection.id === 'codex-cli-local' && connection.type === 'local-cli');
}

export function manualCollaborationPolicy(primary?: ProviderConnection, reviewer?: ProviderConnection): { allowed: boolean; experimental: boolean } {
  if (!primary?.configured || !reviewer?.configured || primary.id === reviewer.id) return { allowed: false, experimental: false };
  if (!primary.singleOnly && !reviewer.singleOnly) return { allowed: true, experimental: false };
  const experimental = localManualCandidate(primary, 'primary') && localManualCandidate(reviewer, 'reviewer');
  return { allowed: experimental, experimental };
}
