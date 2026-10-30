// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { Loop } from '../domain/loop.ts';

// Matches the largest output accepted by the existing Provider IPC boundary.
export const MAX_EXPORT_CHARACTERS = 200_000;
export interface ResultExportRequest {
  status: 'completed';
  finalResult: string;
}
export type ResultExportReply = { status: 'saved' | 'cancelled' | 'failed' };
export interface ResultExportBridge {
  exportMarkdown(input: ResultExportRequest): Promise<ResultExportReply>;
}

export function canExportResult(loop: Pick<Loop, 'status' | 'finalResult'>): boolean {
  return loop.status === 'completed' && typeof loop.finalResult === 'string'
    && loop.finalResult.length <= MAX_EXPORT_CHARACTERS && !!loop.finalResult.trim()
    // In Unicode mode this matches only unpaired surrogates, not valid emoji pairs.
    // Reject invalid strings instead of silently replacing them during UTF-8 encoding.
    && !/[\uD800-\uDFFF]/u.test(loop.finalResult);
}

export async function exportCompletedResult(
  loop: Pick<Loop, 'status' | 'finalResult'>, bridge?: ResultExportBridge,
): Promise<ResultExportReply> {
  if (!canExportResult(loop) || !bridge) return { status: 'failed' };
  try {
    const reply = await bridge.exportMarkdown({ status: 'completed', finalResult: loop.finalResult! });
    return { status: reply?.status === 'saved' || reply?.status === 'cancelled' ? reply.status : 'failed' };
  } catch {
    return { status: 'failed' };
  }
}
