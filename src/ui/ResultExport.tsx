// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useLanguage } from '../i18n/react.tsx';
import { useRef, useState } from 'react';
import type { Loop } from '../domain/loop.ts';
import { canExportResult, exportCompletedResult } from '../application/result-export.ts';

export function ResultExport({ loop }: { loop: Loop }) {
  const { t, message, locale } = useLanguage();
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
      const reply = await exportCompletedResult(loop, window.seohoKimLoop, locale);
      setNotice({ loopId: loop.id, failed: reply.status === 'failed',
        text: reply.status === 'cancelled' ? '파일 저장을 취소했습니다.' : reply.status === 'saved' ? '파일이 저장되었습니다.' : '파일을 저장하지 못했습니다.' });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  if (!eligible) return null;
  return <div className="result-export">
    <button className="secondary-button" type="button" disabled={saving} onClick={() => void save()}>
      {saving ? t("저장 중…") : t("Markdown 저장")}
    </button>
    <p className="export-note">{t("일반 텍스트(.md) 파일로 저장합니다.")}</p>
    {notice?.loopId === loop.id && <p role={notice.failed ? 'alert' : 'status'}>{message(notice.text)}</p>}
  </div>;
}
