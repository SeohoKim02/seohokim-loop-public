// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationConfiguration, PlannedStep } from '../domain/loop.ts';
import type { ProviderRequest } from '../providers/ai-provider.ts';
import type { LoopPlanner } from './loop-service.ts';

// One strategy, not the engine's universal workflow. Provider IDs have no API-specific meaning.
export class DraftReviewImprove implements LoopPlanner {
  readonly collaboration: CollaborationConfiguration;

  constructor(primaryProviderId: string, reviewerProviderId: string) {
    if (!primaryProviderId.trim() || !reviewerProviderId.trim()) throw new Error('작업 AI와 검토 AI를 선택해주세요.');
    if (primaryProviderId === reviewerProviderId) throw new Error('작업 AI와 검토 AI는 서로 다르게 선택해주세요.');
    this.collaboration = Object.freeze({ strategy: 'draft-review-improve', primaryProviderId, reviewerProviderId });
  }

  plan(_userRequest: string): readonly PlannedStep[] {
    const { primaryProviderId, reviewerProviderId } = this.collaboration;
    return [
      { title: '초안 작성', role: 'primary', providerId: primaryProviderId },
      { title: '검토', role: 'reviewer', providerId: reviewerProviderId },
      { title: '개선', role: 'primary', providerId: primaryProviderId },
    ];
  }

  buildRequest(request: ProviderRequest): ProviderRequest {
    const instructions = [
      '초안 작성: 사용자 요청에 맞는 첫 결과를 작성하세요.',
      '검토: 원래 요청과 첫 결과를 비교하여 오류, 누락, 개선점만 명확히 제시하세요. 결과 전체를 다시 작성하지 마세요.',
      '개선: 첫 번째 결과는 초안이고 두 번째는 검토 의견입니다. 원래 요청에 맞게 검토 의견을 반영하여 최종 결과만 작성하세요.',
    ];
    const index = request.previousOutputs.length;
    const stepTitle = instructions[index];
    if (!stepTitle) throw new Error('협업 단계의 입력을 확인할 수 없습니다.');
    // Only the original request and completed outputs cross provider boundaries.
    return { userRequest: request.userRequest, stepTitle, previousOutputs: [...request.previousOutputs], isFinalStep: index === 2 };
  }
}
