// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { canExportResult } from '../src/application/result-export.ts';
import type { ResultExportReply, ResultExportRequest } from '../src/application/result-export.ts';

export const DEFAULT_RESULT_FILENAME = 'SeohoKim-Loop-Result.md';

// Only main calls this writer, with the path returned by the native save dialog.
// Commit a complete UTF-8 file in one rename; never truncate/delete the destination on error.
export async function writeMarkdown(filePath: string, text: string): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.seohokim-export-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function validRequest(input: unknown): input is ResultExportRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const data = input as Record<string, unknown>;
  return Object.keys(data).length === 2 && Object.hasOwn(data, 'status') && Object.hasOwn(data, 'finalResult')
    && data.status === 'completed' && typeof data.finalResult === 'string'
    && canExportResult({ status: data.status, finalResult: data.finalResult });
}

export function createResultExporter(
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>,
  write: (filePath: string, text: string) => Promise<void> = writeMarkdown,
) {
  let saving = false;
  return async (input: unknown): Promise<ResultExportReply> => {
    if (saving || !validRequest(input)) return { status: 'failed' };
    // Snapshot before awaiting the dialog; no Loop object or mutable metadata is retained.
    const text = input.finalResult;
    saving = true;
    try {
      const selection = await showSaveDialog({
        title: '최종 결과 Markdown 저장',
        defaultPath: DEFAULT_RESULT_FILENAME,
        buttonLabel: '저장',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
      });
      if (selection.canceled) return { status: 'cancelled' };
      // Do not append an extension after confirmation: that could overwrite a different file.
      if (!selection.filePath || !path.isAbsolute(selection.filePath)
        || path.extname(selection.filePath).toLowerCase() !== '.md') return { status: 'failed' };
      await write(selection.filePath, text);
      return { status: 'saved' };
    } catch {
      return { status: 'failed' };
    } finally {
      saving = false;
    }
  };
}
