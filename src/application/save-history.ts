// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { Loop } from '../domain/loop.ts';
import { HistoryError, historySnapshot } from '../domain/loop-history.ts';
import type { HistorySummary } from '../domain/loop-history.ts';
import type { HistoryBridge, HistoryReply } from './history-ipc.ts';

export async function saveCompletedHistory(loop: Loop, bridge?: HistoryBridge): Promise<HistoryReply<HistorySummary>> {
  try {
    const snapshot = historySnapshot(loop);
    if (!bridge) return { ok: false, code: 'unavailable' };
    const reply = await bridge.saveHistory(snapshot);
    return reply?.ok ? reply : { ok: false, code: reply?.code ?? 'unavailable' };
  } catch (cause) { return { ok: false, code: cause instanceof HistoryError ? cause.code : 'unavailable' }; }
}
