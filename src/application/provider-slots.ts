// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { abortable, throwIfCancelled } from '../providers/cancellation.ts';

// Per Loop, one active text request per provider, including retries and fallback.
export class ProviderSlots {
  private readonly occupied = new Set<string>();
  private readonly waiters = new Set<() => void>();
  has(id: string): boolean { return this.occupied.has(id); }
  async run<T>(id: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    while (this.occupied.has(id)) {
      let wake!: () => void;
      const available = new Promise<void>((resolve) => { wake = resolve; this.waiters.add(wake); });
      try { await abortable(() => available, signal); }
      finally { this.waiters.delete(wake); }
    }
    throwIfCancelled(signal);
    this.occupied.add(id);
    try { return await operation(); }
    finally { this.occupied.delete(id); for (const wake of this.waiters) wake(); }
  }
}
