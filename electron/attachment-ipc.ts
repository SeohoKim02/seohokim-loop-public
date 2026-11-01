// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { IpcMain, WebContents } from 'electron';
import type { AttachmentReply } from '../src/application/attachment-ipc.ts';
import { isLocale } from '../src/i18n/messages.ts';
import type { Locale } from '../src/i18n/messages.ts';
export function registerAttachmentIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, contents: WebContents, url: string,
  select: (locale?: Locale) => Promise<AttachmentReply>): () => void {
  const channel = 'seohokim-loop:attachments:select-text';
  ipc.handle(channel, async (event, ...args: unknown[]): Promise<AttachmentReply> => {
    if (contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame
      || event.senderFrame?.url !== url || args.length > 1 || (args.length === 1 && !isLocale(args[0]))) return { status: 'failed', code: 'invalid' };
    try { return await select(args[0] as Locale | undefined); } catch { return { status: 'failed', code: 'unavailable' }; }
  });
  return () => ipc.removeHandler(channel);
}
