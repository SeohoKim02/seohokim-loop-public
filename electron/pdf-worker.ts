// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ATTACHMENT_TEXT_LIMIT, AttachmentError } from '../src/providers/text-attachments.ts';
import { PDF_PAGE_LIMIT, PDF_MIN_PAGE_TEXT, PDF_FAILURES, validatePdfBytes } from './pdf-text.ts';

// Parse bytes only. Neither document URLs nor caller-controlled asset paths are used.
globalThis.fetch = async () => { throw new Error('PDF network access is disabled.'); };
const packageRoot = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
class LocalPdfAssets {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const folder = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : undefined;
    if (!folder || typeof filename !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(filename) || filename.includes('..')) throw new Error('Unsupported PDF asset');
    return new Uint8Array(await readFile(path.join(packageRoot, folder, filename)));
  }
}

async function parse(): Promise<string> {
  if (!(workerData instanceof Uint8Array)) throw new AttachmentError('pdf_invalid');
  validatePdfBytes(workerData);
  const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: workerData, verbosity: VerbosityLevel.ERRORS, stopAtErrors: true,
    useWorkerFetch: false, BinaryDataFactory: LocalPdfAssets, disableFontFace: true, useSystemFonts: false,
    useWasm: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 0,
    enableXfa: false, disableAutoFetch: true, disableStream: true, disableRange: true });
  try {
    const document = await task.promise;
    if (!Number.isInteger(document.numPages) || document.numPages < 1) throw new AttachmentError('pdf_invalid');
    if (document.numPages > PDF_PAGE_LIMIT) throw new AttachmentError('pdf_pages');
    const { info } = await document.getMetadata();
    if (!info || typeof info !== 'object') throw new AttachmentError('pdf_invalid');
    if ((info as Record<string, unknown>).EncryptFilterName != null || await document.getPermissions() !== null) throw new AttachmentError('pdf_password');
    const pages: string[] = []; let length = 0; let meaningful = 0; let incomplete = false;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      let text = '';
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          if (!chunk.value || !Array.isArray(chunk.value.items)) throw new AttachmentError('pdf_invalid');
          for (const item of chunk.value.items) {
            if (!item || !('str' in item) || typeof item.str !== 'string' || typeof item.hasEOL !== 'boolean') throw new AttachmentError('pdf_invalid');
            if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffd\uD800-\uDFFF]/u.test(item.str)) throw new AttachmentError('pdf_text');
            // PDF.js supplies reading order and line endings; no layout reconstruction.
            text += item.str + (item.hasEOL ? '\n' : ' ');
            if (length + text.length > ATTACHMENT_TEXT_LIMIT) throw new AttachmentError('length');
          }
        }
      } finally { await reader.cancel().catch(() => {}); page.cleanup(); }
      const visible = text.replace(/\s/g, '').length; meaningful += visible;
      if (visible < PDF_MIN_PAGE_TEXT) incomplete = true;
      const section = `[Page ${number}]\n${text.trim()}`;
      length += section.length + (pages.length ? 2 : 0);
      if (length > ATTACHMENT_TEXT_LIMIT) throw new AttachmentError('length');
      pages.push(section);
    }
    if (!meaningful) throw new AttachmentError('pdf_no_text');
    if (incomplete) throw new AttachmentError('pdf_incomplete');
    return pages.join('\n\n');
  } finally { await task.destroy(); }
}

try { parentPort?.postMessage({ ok: true, text: await parse() }); }
catch (cause) {
  const code = cause instanceof AttachmentError && PDF_FAILURES.includes(cause.code) ? cause.code
    : cause instanceof Error && cause.name === 'PasswordException' ? 'pdf_password' : 'pdf_invalid';
  parentPort?.postMessage({ ok: false, code });
}
