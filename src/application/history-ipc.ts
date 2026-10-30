// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { HistoryCode, HistorySummary, LoopHistory } from '../domain/loop-history.ts';

export type HistoryReply<T> = { ok: true; value: T } | { ok: false; code: HistoryCode };
export const HISTORY_SEARCH_LENGTH = 200;
export interface HistorySearch { query: string }
export interface HistoryList { items: HistorySummary[]; partial: boolean; total?: number }
export interface HistoryBridge {
  saveHistory(snapshot: LoopHistory): Promise<HistoryReply<HistorySummary>>;
  listHistory(search?: HistorySearch): Promise<HistoryReply<HistoryList>>;
  getHistory(id: string): Promise<HistoryReply<LoopHistory>>;
  deleteHistory(id: string): Promise<HistoryReply<null>>;
}
export function historySaveMessage(code?: HistoryCode): string {
  if (code === 'limit') return '기록 보관 한도에 도달했습니다. 필요 없는 기록을 삭제해주세요.';
  if (code === 'too_large') return '기록이 너무 커서 보관하지 못했습니다. 최종 결과는 Markdown으로 저장할 수 있습니다.';
  if (code === 'encryption') return '기록을 안전하게 암호화할 수 없어 보관하지 못했습니다.';
  if (code === 'invalid') return '기록 형식을 확인할 수 없습니다. 최종 결과를 Markdown으로 저장해주세요.';
  if (code === 'conflict') return '같은 ID의 다른 기록이 있어 덮어쓰지 않았습니다. 최종 결과를 Markdown으로 저장해주세요.';
  if (code === 'corrupt' || code === 'version') return '기존 기록을 안전하게 확인할 수 없어 변경하지 않았습니다. 최종 결과를 Markdown으로 저장해주세요.';
  return '기록을 저장하지 못했습니다. 최종 결과는 Markdown으로 저장할 수 있습니다.';
}
