// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { Worker } from 'node:worker_threads';
import { PDF_BYTES, ATTACHMENT_TEXT_LIMIT, AttachmentError } from '../src/providers/text-attachments.ts';
import type { AttachmentCode } from '../src/providers/text-attachments.ts';

export const PDF_PAGE_LIMIT = 30;
export const PDF_TIMEOUT_MS = 15_000;
export const PDF_MIN_PAGE_TEXT = 20;
export const PDF_FAILURES: readonly AttachmentCode[] = ['pdf_size', 'pdf_signature', 'pdf_invalid', 'pdf_password',
  'pdf_pages', 'pdf_no_text', 'pdf_incomplete', 'pdf_timeout', 'pdf_text', 'length'];

export function validatePdfBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > PDF_BYTES) throw new AttachmentError('pdf_size');
  if (!/^%PDF-[12]\.\d/.test(new TextDecoder('ascii').decode(bytes.subarray(0, 8)))) throw new AttachmentError('pdf_signature');
}

const workerFor = (bytes: Uint8Array) => {
  // Fixed application-owned entry point; source path supports Node's TypeScript tests.
  const entry = new URL(import.meta.url.endsWith('.ts') ? './pdf-worker.ts' : './pdf-worker.js', import.meta.url);
  const copy = Uint8Array.from(bytes);
  return new Worker(entry, { workerData: copy, transferList: [copy.buffer], env: {}, execArgv: [],
    stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
};

// Main/test-only injection. No path, worker option or parser option crosses renderer IPC.
export async function extractPdfText(bytes: Uint8Array, createWorker = workerFor, timeoutMs = PDF_TIMEOUT_MS): Promise<string> {
  validatePdfBytes(bytes);
  let worker: Worker;
  try { worker = createWorker(bytes); } catch { throw new AttachmentError('pdf_invalid'); }
  // PDF.js diagnostics may contain document text. Drain without forwarding or storing.
  worker.stdout?.resume(); worker.stderr?.resume();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (text?: string, code: AttachmentCode = 'pdf_invalid') => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate().catch(() => {}).finally(() => text === undefined ? reject(new AttachmentError(code)) : resolve(text));
    };
    const timer = setTimeout(() => finish(undefined, 'pdf_timeout'), timeoutMs);
    worker.once('error', () => finish()); worker.once('exit', () => finish());
    worker.once('message', (reply: unknown) => {
      if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return finish();
      const value = reply as Record<string, unknown>;
      if (Object.keys(value).length !== 2) return finish();
      if (value.ok === false && PDF_FAILURES.includes(value.code as AttachmentCode)) return finish(undefined, value.code as AttachmentCode);
      if (value.ok !== true || typeof value.text !== 'string' || !value.text.trim()) return finish();
      if (value.text.length > ATTACHMENT_TEXT_LIMIT) return finish(undefined, 'length');
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffd\uD800-\uDFFF]/u.test(value.text)) return finish(undefined, 'pdf_text');
      finish(value.text);
    });
  });
}
