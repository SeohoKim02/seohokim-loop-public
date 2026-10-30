// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { IpcMain, WebContents } from 'electron';
import { HistoryError } from '../src/domain/loop-history.ts';
import type { HistoryReply } from '../src/application/history-ipc.ts';
import type { LoopHistoryStore } from './history-store.ts';

export function registerHistoryIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, contents: WebContents,
  rendererUrl: string, store: LoopHistoryStore): () => void {
  const operations = [
    ['save', 1, (input: unknown) => store.save(input)], ['list', 0, (input: unknown) => store.list(input)],
    ['get', 1, (id: unknown) => store.get(id)], ['delete', 1, (id: unknown) => store.remove(id)],
  ] as const;
  for (const [name, count, action] of operations) {
    ipc.handle(`seohokim-loop:history:${name}`, async (event, ...args: unknown[]): Promise<HistoryReply<unknown>> => {
      if (contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame
        || event.senderFrame?.url !== rendererUrl || (args.length !== count && !(name === 'list' && args.length === 1))) return { ok: false, code: 'invalid' };
      try { return { ok: true, value: await action(args[0]) }; }
      catch (cause) { return { ok: false, code: cause instanceof HistoryError ? cause.code : 'unavailable' }; }
    });
  }
  return () => { for (const [name] of operations) ipc.removeHandler(`seohokim-loop:history:${name}`); };
}
