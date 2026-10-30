// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoopService } from '../src/application/loop-service.ts';
import type { LoopPlanner } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { createLoop } from '../src/domain/loop.ts';
import type { Loop } from '../src/domain/loop.ts';
import type { AIProvider, ProviderRequest, ProviderResponse } from '../src/providers/ai-provider.ts';
import { MockProvider } from '../src/providers/mock-provider.ts';

const request = '전기차 시장을 조사해서 간단한 보고서를 만들어줘.';
const noDelay = async (): Promise<void> => {};
const makeService = () => new LoopService(new MockPlanner(), new MockProvider(noDelay));

test('빈 요청과 공백 요청은 Planner 실행 전에 거부한다', () => {
  let planned = false;
  const service = new LoopService({ plan() { planned = true; return []; } }, new MockProvider(noDelay));
  for (const input of ['', ' ', '\n\t　']) {
    assert.throws(() => service.create(input), /작업 내용을 입력/);
    assert.throws(() => createLoop(input, [{ title: '단계' }], { id: 'mock', displayName: 'Mock AI' }), /작업 내용을 입력/);
  }
  assert.equal(planned, false);
});

test('생성한 Loop와 모든 단계는 pending이며 실행 결과와 시각은 아직 없다', () => {
  const loop = makeService().create(`  ${request}\n`);
  assert.equal(loop.userRequest, request);
  assert.equal(loop.mode, 'auto');
  assert.equal(loop.status, 'pending');
  assert.ok(loop.id);
  assert.ok(Number.isFinite(Date.parse(loop.createdAt)));
  assert.equal(loop.startedAt, undefined);
  assert.equal(loop.completedAt, undefined);
  assert.equal(loop.finalResult, undefined);
  assert.ok(loop.steps.length > 0);
  assert.equal(new Set([loop.id, ...loop.steps.map((step) => step.id)]).size, loop.steps.length + 1);
  for (const step of loop.steps) {
    assert.equal(step.status, 'pending');
    assert.equal(step.assignedProvider.id, 'mock');
    assert.equal(step.assignedProvider.displayName, 'Mock AI');
    assert.equal(step.retryCount, 0);
    assert.equal(step.startedAt, undefined);
    assert.equal(step.completedAt, undefined);
    assert.equal(step.output, undefined);
  }
});

test('Mock Planner는 독립적인 다섯 개의 예시 단계를 생성한다', () => {
  const planner = new MockPlanner();
  const plan = planner.plan(request);
  assert.deepEqual(plan.map((step) => step.title), ['요청 이해', '작업 계획', '초안 생성', '결과 검토', '최종 정리']);
  assert.notEqual(plan, planner.plan(request));
});

test('단계가 없거나 제목이 빈 계획은 거부한다', () => {
  for (const plan of [[], [{ title: ' ' }]]) {
    assert.throws(() => new LoopService({ plan: () => plan }, new MockProvider(noDelay)).create(request), /작업 단계가 없습니다/);
  }
});

test('모든 단계는 순차적으로 pending → running → completed로 진행하며 이전 상태는 보존된다', async () => {
  const service = makeService();
  const initial = service.create(request);
  const snapshots: Loop[] = [initial];
  const result = await service.run(initial, (loop) => snapshots.push(loop));

  for (const step of initial.steps) {
    const states = snapshots.map((loop) => loop.steps.find((candidate) => candidate.id === step.id)!.status);
    const transitions = states.filter((state, index) => index === 0 || state !== states[index - 1]);
    assert.deepEqual(transitions, ['pending', 'running', 'completed']);
  }
  for (const snapshot of snapshots) {
    assert.ok(snapshot.steps.filter((step) => step.status === 'running').length <= 1);
    const running = snapshot.steps.findIndex((step) => step.status === 'running');
    if (running >= 0) {
      assert.ok(snapshot.steps.slice(0, running).every((step) => step.status === 'completed'));
      assert.ok(snapshot.steps.slice(running + 1).every((step) => step.status === 'pending'));
    }
  }
  assert.equal(initial.status, 'pending');
  assert.ok(initial.steps.every((step) => step.status === 'pending'));
  assert.equal(snapshots.at(-1), result);
});

test('완료한 Loop는 최종 결과와 단계별 output 및 실행 시각을 가진다', async () => {
  const service = makeService();
  const result = await service.run(service.create(request));
  assert.equal(result.status, 'completed');
  assert.ok(result.steps.every((step) => step.status === 'completed' && step.output));
  assert.ok(result.finalResult?.includes(request));
  assert.ok(result.finalResult?.includes('Mock AI'));
  assert.equal(result.finalResult, result.steps.at(-1)?.output);
  assert.ok(Date.parse(result.startedAt!) >= Date.parse(result.createdAt));
  assert.ok(Date.parse(result.completedAt!) >= Date.parse(result.startedAt!));
  for (const step of result.steps) {
    assert.ok(Date.parse(step.completedAt!) >= Date.parse(step.startedAt!));
  }
});

test('교체한 Planner의 단계 수와 제목을 사용하고 이전 단계 결과를 Provider에 전달한다', async () => {
  const calls: ProviderRequest[] = [];
  const planner: LoopPlanner = { plan: () => [{ title: '자료 비교' }, { title: '표로 정리' }] };
  const provider: AIProvider = {
    id: 'example', displayName: 'Example AI',
    async execute(input) { calls.push(input); return { output: `${input.stepTitle} 결과` }; },
  };
  const service = new LoopService(planner, provider);
  const result = await service.run(service.create(request));
  assert.equal(result.steps.length, 2);
  assert.equal(result.finalResult, '표로 정리 결과');
  assert.deepEqual(calls, [
    { userRequest: request, stepTitle: '자료 비교', previousOutputs: [], isFinalStep: false },
    { userRequest: request, stepTitle: '표로 정리', previousOutputs: ['자료 비교 결과'], isFinalStep: true },
  ]);
  assert.ok(result.steps.every((step) => step.assignedProvider.id === 'example'));
});

test('Mock Provider의 지연 함수를 주입하여 실제 대기 없이 실행한다', async () => {
  const requestedDelays: number[] = [];
  const mock = new MockProvider(async (milliseconds) => { requestedDelays.push(milliseconds); });
  const service = new LoopService(new MockPlanner(), mock);
  const result = await service.run(service.create(request));
  assert.equal(result.status, 'completed');
  assert.deepEqual(requestedDelays, [750, 750, 750, 750, 750]);
});

test('Mock Provider 실패 시 해당 단계와 Loop는 failed가 되고 후속 실행을 멈춘다', async () => {
  let calls = 0;
  const provider = new MockProvider(async () => {
    calls += 1;
    if (calls === 2) throw new Error('Mock Provider 연결 실패');
  });
  const service = new LoopService(new MockPlanner(), provider);
  const snapshots: Loop[] = [];
  const result = await service.run(service.create(request), (loop) => snapshots.push(loop));
  assert.equal(calls, 2);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Mock Provider 연결 실패');
  assert.equal(result.steps[0]?.status, 'completed');
  assert.ok(result.steps[0]?.output);
  assert.equal(result.steps[1]?.status, 'failed');
  assert.equal(result.steps[1]?.error, result.error);
  assert.ok(result.steps[1]?.startedAt);
  assert.ok(result.steps[1]?.completedAt);
  assert.ok(result.steps.slice(2).every((step) => step.status === 'pending' && !step.startedAt));
  assert.ok(result.completedAt);
  assert.equal(result.finalResult, undefined);
  assert.equal(snapshots.at(-1)?.status, 'failed');
  // A failed run must release the service for a subsequent request.
  assert.equal((await service.run(service.create('다음 작업'))).status, 'completed');
});

test('Error 이외의 Provider 오류도 failed로 처리한다', async () => {
  const provider = new MockProvider(async () => { throw 'failure'; });
  const service = new LoopService(new MockPlanner(), provider);
  const result = await service.run(service.create(request));
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /알 수 없는 오류/);
});

test('빈 Provider 결과를 정상 완료로 표시하지 않는다', async () => {
  const service = new LoopService(new MockPlanner(), {
    id: 'empty', displayName: 'Empty AI', execute: async () => ({ output: ' \n' }),
  });
  const result = await service.run(service.create(request));
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /비어 있는 결과/);
  assert.equal(result.finalResult, undefined);
});

test('실행 중 중복 시작은 거부하고 완료 뒤에는 새 Loop 실행을 허용한다', async () => {
  let finish!: (value: ProviderResponse) => void;
  const deferred = new Promise<ProviderResponse>((resolve) => { finish = resolve; });
  const service = new LoopService({ plan: () => [{ title: '하나의 단계' }] }, {
    id: 'deferred', displayName: 'Deferred AI', execute: () => deferred,
  });
  const loop = service.create(request);
  const active = service.run(loop);
  await assert.rejects(service.run(loop), /현재 작업이 끝난 뒤/);
  finish({ output: '완료' });
  assert.equal((await active).status, 'completed');
  assert.equal((await service.run(service.create('새 요청'))).status, 'completed');
});

test('이미 완료한 Loop와 다른 Provider의 Loop는 실행하지 않는다', async () => {
  const service = makeService();
  const completed = await service.run(service.create(request));
  await assert.rejects(service.run(completed), /유효한 Loop/);
  const foreign = createLoop(request, [{ title: '작업' }], { id: 'another', displayName: 'Another AI' });
  await assert.rejects(service.run(foreign), /유효한 Loop/);
});
