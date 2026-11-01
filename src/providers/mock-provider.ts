// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { translate } from '../i18n/messages.ts';
import type { MessageKey } from '../i18n/catalog.ts';
import type { AIProvider, ProviderExecutionOptions, ProviderRequest, ProviderResponse } from './ai-provider.ts';
import { abortable, throwIfCancelled } from './cancellation.ts';
import { ProviderError } from './provider-error.ts';

type Delay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
const delay: Delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  throwIfCancelled(signal);
  const cancel = () => { clearTimeout(timer); reject(new ProviderError('CANCELLED')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, milliseconds);
  signal?.addEventListener('abort', cancel, { once: true });
});

export class MockProvider implements AIProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock AI';
  private readonly wait: Delay;

  constructor(wait: Delay = delay) {
    this.wait = wait;
  }

  async execute(request: ProviderRequest, options?: ProviderExecutionOptions): Promise<ProviderResponse> {
    const t = (key: MessageKey, ...values: readonly unknown[]) => translate(request.locale ?? 'ko', key, ...values);
    await abortable(() => this.wait(750, options?.signal), options?.signal);

    if (request.isFinalStep) {
      return {
        output: [
          t('요청하신 작업의 예시 결과입니다.'),
          '',
          t('요청: {0}', request.userRequest),
          '',
          t('앞선 {0}개 단계에 이어 최종 정리를 마쳤습니다.', request.previousOutputs.length),
          t('작업 요청을 받아 계획하고, 초안을 만들고, 검토하는 Loop의 흐름을 확인했습니다.'),
          '',
          t('이 내용은 Mock AI가 만든 데모입니다. 실제 조사·분석이나 AI 호출은 수행하지 않았습니다.'),
        ].join('\n'),
      };
    }

    return {
      output: t('“{0}” 단계의 예시 처리를 마쳤습니다.\n요청: {1}\n앞선 {2}개 단계의 결과를 전달받았습니다.', request.stepTitle, request.userRequest, request.previousOutputs.length),
    };
  }
}
