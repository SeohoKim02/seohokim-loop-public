// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { PlannedStep } from '../domain/loop.ts';
import type { LoopPlanner } from './loop-service.ts';
import { translate } from '../i18n/messages.ts';
import type { Locale } from '../i18n/messages.ts';

// This is an example plan, not the workflow definition of the execution engine.
// A future planner can return a different number and set of steps for each request.
export class MockPlanner implements LoopPlanner {
  private readonly mode: 'demo' | 'single-work';
  private readonly locale: Locale;

  constructor(mode: 'demo' | 'single-work' = 'demo', locale: Locale = 'ko') {
    this.mode = mode;
    this.locale = locale;
  }

  plan(_userRequest: string): readonly PlannedStep[] {
    // Initial live integration: one work step, one provider execution, one final result.
    if (this.mode === 'single-work') return [{ title: '초안 생성' }];
    return (['요청 이해', '작업 계획', '초안 생성', '결과 검토', '최종 정리'] as const)
      .map(title => ({ title: translate(this.locale, title) }));
  }
}
