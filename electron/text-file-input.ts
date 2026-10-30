// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ATTACHMENT_BYTES, PDF_BYTES, ATTACHMENT_TYPES, AttachmentError, validateAttachments } from '../src/providers/text-attachments.ts';
import type { TextAttachment } from '../src/providers/text-attachments.ts';
import type { AttachmentReply } from '../src/application/attachment-ipc.ts';
import { extractPdfText } from './pdf-text.ts';

export function createTextFileInput(select: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>, files = fs, extractPdf = extractPdfText) {
  let busy = false;
  return async (): Promise<AttachmentReply> => {
    if (busy) return { status: 'failed', code: 'busy' };
    busy = true;
    try {
      const selected = await select({ title: '파일 첨부', properties: ['openFile', 'multiSelections'],
        filters: [{ name: '텍스트 및 PDF', extensions: [...ATTACHMENT_TYPES] }] });
      if (selected.canceled) return { status: 'cancelled' };
      if (!Array.isArray(selected.filePaths) || selected.filePaths.length < 1 || selected.filePaths.length > 2) throw new AttachmentError('count');
      const attachments: TextAttachment[] = [];
      for (const file of selected.filePaths) {
        if (typeof file !== 'string' || !path.isAbsolute(file)) throw new AttachmentError('invalid');
        const type = path.extname(file).slice(1).toLowerCase() as TextAttachment['type'];
        if (!ATTACHMENT_TYPES.includes(type)) throw new AttachmentError('type');
        const limit = type === 'pdf' ? PDF_BYTES : ATTACHMENT_BYTES;
        const sizeError = type === 'pdf' ? 'pdf_size' : 'size';
        const stat = await files.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new AttachmentError('invalid');
        if (stat.size > limit) throw new AttachmentError(sizeError);
        const handle = await files.open(file, 'r');
        let offset = 0; const bytes = Buffer.alloc(limit + 1);
        try {
          if (!(await handle.stat()).isFile()) throw new AttachmentError('invalid');
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, null);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
          }
        } finally { await handle.close(); }
        if (offset > limit) throw new AttachmentError(sizeError);
        let text: string;
        if (type === 'pdf') text = await extractPdf(bytes.subarray(0, offset));
        else {
          try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset)); }
          catch { throw new AttachmentError('encoding'); }
        }
        attachments.push({ id: randomUUID(), name: path.basename(file), type, text, size: offset });
      }
      return { status: 'selected', files: validateAttachments(attachments) };
    } catch (cause) { return { status: 'failed', code: cause instanceof AttachmentError ? cause.code : 'unavailable' }; }
    finally { busy = false; }
  };
}
