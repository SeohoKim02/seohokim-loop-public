// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { ProviderError } from '../providers/provider-error.ts';
import { throwIfCancelled } from '../providers/cancellation.ts';

// A received gateway/service error only. In particular, an ambiguous 429,
// network failure or timeout must not imply that another request is safe.
export function canRetryAutoTextStep(cause: unknown): boolean {
  return cause instanceof ProviderError && cause.code === 'HTTP_ERROR'
    && (cause.httpStatus === 502 || cause.httpStatus === 503 || cause.httpStatus === 504);
}

export type RetryWait = (signal?: AbortSignal) => Promise<void>;
export const AUTO_STEP_RETRY_DELAY_MS = 1000;

export const waitForAutoStepRetry: RetryWait = async (signal) => {
  throwIfCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new ProviderError('CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, AUTO_STEP_RETRY_DELAY_MS);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  throwIfCancelled(signal);
};
