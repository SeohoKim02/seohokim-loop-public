// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react';
import type { Loop } from '../domain/loop.ts';
import { canExportResult, exportCompletedResult } from '../application/result-export.ts';

export function ResultExport({ loop }: { loop: Loop }) {
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ loopId: string; failed: boolean; text: string }>();
  const eligible = canExportResult(loop);

  async function save() {
    if (busy.current || !eligible) return;
    busy.current = true;
    setSaving(true);
    setNotice(undefined);
    try {
      const reply = await exportCompletedResult(loop, window.seohoKimLoop);
      if (reply.status !== 'cancelled') setNotice({ loopId: loop.id, failed: reply.status === 'failed',
        text: reply.status === 'saved' ? '파일이 저장되었습니다.' : '파일을 저장하지 못했습니다.' });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  if (!eligible) return null;
  return <div className="result-export">
    <button className="secondary-button" type="button" disabled={saving} onClick={() => void save()}>
      {saving ? '저장 중…' : 'Markdown 저장'}
    </button>
    <p className="export-note">일반 텍스트(.md) 파일로 저장합니다.</p>
    {notice?.loopId === loop.id && <p role={notice.failed ? 'alert' : 'status'}>{notice.text}</p>}
  </div>;
}
