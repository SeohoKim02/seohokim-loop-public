// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { PlannedStep } from '../domain/loop.ts';
import type { LoopPlanner } from './loop-service.ts';

// This is an example plan, not the workflow definition of the execution engine.
// A future planner can return a different number and set of steps for each request.
export class MockPlanner implements LoopPlanner {
  private readonly mode: 'demo' | 'single-work';

  constructor(mode: 'demo' | 'single-work' = 'demo') {
    this.mode = mode;
  }

  plan(_userRequest: string): readonly PlannedStep[] {
    // Initial live integration: one work step, one provider execution, one final result.
    if (this.mode === 'single-work') return [{ title: '초안 생성' }];
    return [
      { title: '요청 이해' },
      { title: '작업 계획' },
      { title: '초안 생성' },
      { title: '결과 검토' },
      { title: '최종 정리' },
    ];
  }
}
