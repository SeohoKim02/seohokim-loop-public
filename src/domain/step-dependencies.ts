// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

interface DependencyStep {
  readonly dependsOn?: readonly number[];
  readonly usesPreviousOutputs?: boolean;
  readonly isFinal?: boolean;
}

// Missing on every step means legacy sequential execution. Mixed plans fail closed.
export function dependencyIssue(steps: readonly DependencyStep[]): string | undefined {
  if (!steps.some((step) => step.dependsOn !== undefined)) return;
  if (steps.length < 2 || steps.length > 5) return '의존성 계획은 2~5개 단계여야 합니다.';
  for (const [index, step] of steps.entries()) {
    const refs = step.dependsOn;
    if (!Array.isArray(refs)) return '모든 단계에 dependsOn 배열을 지정하세요.';
    if (refs.some((ref) => !Number.isInteger(ref) || ref < 1 || ref > index) || new Set(refs).size !== refs.length)
      return 'dependsOn에는 중복 없이 앞선 단계의 1부터 시작하는 정수 번호만 지정하세요.';
    if (step.usesPreviousOutputs !== (refs.length > 0)) return 'usesPreviousOutputs는 dependsOn이 비어 있으면 false, 아니면 true여야 합니다.';
    if (step.isFinal !== (index === steps.length - 1)) return '마지막 단계 하나만 isFinal이 true여야 합니다.';
  }
  const ancestors = new Set<number>();
  const visit = (index: number): void => {
    for (const ref of steps[index]!.dependsOn!) if (!ancestors.has(ref)) { ancestors.add(ref); visit(ref - 1); }
  };
  visit(steps.length - 1);
  if (ancestors.size !== steps.length - 1) return '모든 앞선 단계는 최종 단계의 직접 또는 간접 선행 조건이어야 합니다.';
}
