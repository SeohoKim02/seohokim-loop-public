// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { TextAttachment } from '../providers/text-attachments.ts';

export function AttachmentPreview({ file, onClose }: { file: TextAttachment; onClose: () => void }) {
  return <section id="attachment-preview" className="attachment-preview card" aria-labelledby="attachment-preview-title"
    data-testid="attachment-preview" data-attachment-id={file.id}>
    <div className="attachment-preview-heading">
      <div>
        <h3 id="attachment-preview-title">{file.name}</h3>
        <p>{file.type.toUpperCase()} · {file.text.length.toLocaleString()}자 · 읽기 전용</p>
      </div>
      <button type="button" className="secondary-button" onClick={onClose}>미리보기 닫기</button>
    </div>
    {file.type === 'pdf' && <p className="attachment-preview-note">PDF에서 추출된 텍스트입니다. 표, 수식, 이미지, 문단 배치는 원본과 다를 수 있습니다. 스캔 PDF의 OCR은 지원하지 않습니다.</p>}
    <pre className="attachment-preview-text" tabIndex={0} aria-label={`${file.name} 첨부 내용`}>{file.text}</pre>
  </section>;
}
