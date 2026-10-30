// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { ProviderError } from './provider-error.ts';

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderError('CANCELLED');
}

export function isCancellation(cause: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (cause instanceof ProviderError && cause.code === 'CANCELLED');
}

export function abortCode(combined: AbortSignal, user?: AbortSignal): 'CANCELLED' | 'TIMEOUT' {
  return user?.aborted && combined.reason === user.reason ? 'CANCELLED' : 'TIMEOUT';
}

// Settle once and remove listeners on every path, even for a test/future adapter
// that ignores its signal. This does not replace passing the signal to real I/O.
export async function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  if (!signal) return operation();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new ProviderError('CANCELLED'));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    let pending: Promise<T>;
    try { pending = operation(); } catch (cause) { pending = Promise.reject(cause); }
    const result = await Promise.race([pending, cancelled]);
    throwIfCancelled(signal);
    return result;
  } finally { signal.removeEventListener('abort', cancel); }
}
