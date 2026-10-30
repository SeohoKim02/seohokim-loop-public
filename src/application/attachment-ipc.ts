// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { AttachmentCode, TextAttachment } from '../providers/text-attachments.ts';
export type AttachmentReply = { status: 'selected'; files: readonly TextAttachment[] } | { status: 'cancelled' } | { status: 'failed'; code: AttachmentCode };
export interface AttachmentBridge { selectTextFiles(): Promise<AttachmentReply> }
