// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import type { Loop } from '../domain/loop.ts';
import { saveCompletedHistory } from '../application/save-history.ts';
import { historySaveMessage } from '../application/history-ipc.ts';
import type { HistoryCode } from '../domain/loop-history.ts';

type SaveNotice = { id: string; phase: 'saving' | 'saved' | 'failed' | 'resaving'; message: string; code?: HistoryCode };

export function useHistorySave(loop?: Loop) {
  const attempted = useRef<string | undefined>(undefined);
  const [notice, setNotice] = useState<SaveNotice>();
  const currentNotice = useRef<SaveNotice | undefined>(undefined);
  function update(next: SaveNotice) {
    // Lock synchronously, before React renders a disabled button.
    currentNotice.current = next;
    setNotice(next);
  }
  async function save(completed: Loop, manual: boolean) {
    update({ id: completed.id, phase: manual ? 'resaving' : 'saving',
      message: manual ? '기록을 다시 저장하는 중…' : '기록을 보관하는 중…' });
    const reply = await saveCompletedHistory(completed, window.seohoKimLoop);
    if (attempted.current !== completed.id) return;
    update({ id: completed.id, phase: reply.ok ? 'saved' : 'failed',
      code: reply.ok ? undefined : reply.code,
      message: reply.ok ? manual ? '기록이 저장되었습니다.' : '기록에 보관되었습니다.'
        : manual ? '기록을 저장하지 못했습니다. 다시 시도할 수 있습니다.' : historySaveMessage(reply.code) });
  }
  useEffect(() => {
    if (!loop || loop.status !== 'completed' || attempted.current === loop.id) return;
    attempted.current = loop.id;
    void save(loop, false);
  }, [loop]);
  function retry() {
    if (!loop || loop.status !== 'completed' || currentNotice.current?.id !== loop.id
      || currentNotice.current.phase !== 'failed') return;
    void save(loop, true);
  }
  function startProtection() {
    if (loop?.status !== 'completed') return undefined;
    const current = currentNotice.current;
    // Include the gap before the completion effect sends the first save.
    if (current?.id !== loop.id || current.phase === 'saving' || current.phase === 'resaving') return 'saving';
    return current.phase === 'failed' ? 'unsaved' : undefined;
  }
  const visible = notice?.id === loop?.id ? notice : undefined;
  return { notice: visible, retry, startProtection, saving: loop?.status === 'completed'
    && (!visible || visible.phase === 'saving' || visible.phase === 'resaving') };
}
