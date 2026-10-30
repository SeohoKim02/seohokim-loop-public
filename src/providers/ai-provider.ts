// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { TextAttachment } from './text-attachments.ts';
export interface ProviderRequest {
  attachments?: readonly TextAttachment[];
  userRequest: string;
  stepTitle: string;
  objective?: string;
  previousOutputs: readonly string[];
  isFinalStep: boolean;
}

export interface ProviderResponse {
  output: string;
}

// Execution-only metadata, never part of the model prompt or serialized signal.
export interface ProviderExecutionOptions {
  signal?: AbortSignal;
  executionId?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  execute(request: ProviderRequest, options?: ProviderExecutionOptions): Promise<ProviderResponse>;
  // Optional: implementations verify their own connection without returning model output.
  testConnection?(): Promise<void>;
}
