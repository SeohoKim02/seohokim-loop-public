// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

export type LocalCliState = 'disabled' | 'not_installed' | 'installed' | 'login_required' | 'authenticated'
  | 'ready' | 'running' | 'usage_limit' | 'failed' | 'unsupported';

// Safe display metadata only. No path, account, command, logs or authentication payload.
export interface LocalCliStatus {
  state: LocalCliState;
  version?: string;
  checkedAt?: string;
  lastExecution?: 'completed' | 'failed' | 'cancelled';
}
