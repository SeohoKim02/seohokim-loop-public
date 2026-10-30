// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from 'react';
import { AttachmentError, attachmentMessage, validateAttachmentInput, validateAttachments } from '../providers/text-attachments.ts';
import type { TextAttachment } from '../providers/text-attachments.ts';
export function useAttachments(request: string) {
  const [files, setFiles] = useState<readonly TextAttachment[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string>();
  const [previewId, setPreviewId] = useState<string>();
  const busy = useRef(false);
  async function select() {
    if (busy.current) return;
    busy.current = true; setSelecting(true); setError(undefined);
    try {
      const reply = await window.seohoKimLoop?.selectTextFiles();
      if (reply?.status === 'selected') setFiles(validateAttachments([...files, ...reply.files]));
      else if (reply?.status === 'failed') setError(attachmentMessage(reply.code));
      else if (!reply) setError(attachmentMessage('unavailable'));
    } catch (cause) { setError(cause instanceof AttachmentError ? cause.message : attachmentMessage('unavailable')); }
    finally { busy.current = false; setSelecting(false); }
  }
  let inputError: string | undefined;
  try { validateAttachmentInput(request.trim(), files); } catch (cause) { inputError = cause instanceof AttachmentError ? cause.message : attachmentMessage('invalid'); }
  // Store only the selection, never a second copy of the attachment text.
  const preview = selecting ? undefined : files.find((file) => file.id === previewId);
  return { files, selecting, error, inputError, select, preview, pending: () => busy.current,
    openPreview: (id: string) => { if (!busy.current && files.some((file) => file.id === id)) setPreviewId(id); },
    closePreview: () => setPreviewId(undefined),
    remove: (id: string) => { if (!busy.current) {
      setFiles((current) => current.filter((item) => item.id !== id)); setError(undefined);
      setPreviewId((current) => current === id ? undefined : current);
    } },
    clear: () => { setFiles([]); setError(undefined); setPreviewId(undefined); } };
}
