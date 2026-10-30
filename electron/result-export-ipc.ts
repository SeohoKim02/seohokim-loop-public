// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { IpcMain, WebContents } from 'electron';
import type { ResultExportReply } from '../src/application/result-export.ts';

export function registerResultExportIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, contents: WebContents, rendererUrl: string,
  exportMarkdown: (input: unknown) => Promise<ResultExportReply>,
): () => void {
  const channel = 'seohokim-loop:result:export-markdown';
  ipc.handle(channel, async (event, ...args: unknown[]): Promise<ResultExportReply> => {
    if (contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame
      || event.senderFrame?.url !== rendererUrl || args.length !== 1) return { status: 'failed' };
    try {
      return await exportMarkdown(args[0]);
    } catch {
      return { status: 'failed' };
    }
  });
  return () => ipc.removeHandler(channel);
}
