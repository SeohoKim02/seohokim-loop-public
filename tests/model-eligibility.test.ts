// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelRoles } from '../src/providers/model-capability.ts';
import type { ModelRole, TechnicalModel, QualityEvaluation, QualityCheck } from '../src/providers/model-capability.ts';
import { checkQualityOutput, modelQualityState, recordQualityEvaluation, roleCriteria } from '../src/application/model-quality.ts';
import { eligibleForStep, roleEligibility } from '../src/application/role-eligibility.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import type { ProviderConnection } from '../src/providers/provider-registry.ts';
import { assignAutoProviders, autoProviderPool, selectAlternativeProvider } from '../src/application/auto-router.ts';
import { AutoLoopService } from '../src/application/auto-loop-service.ts';
import { ProviderError } from '../src/providers/provider-error.ts';
import { parseTaskPlan } from '../src/application/task-planner.ts';

const model = (): TechnicalModel => ({ identity: { providerId: 'local-neutral', modelId: 'model:one', digest: 'a'.repeat(64), runtimeVersion: '0.40.8' },
  local: true, capabilities: ['completion'], format: 'gguf', advertisedContextLength: 4096, licensePresent: false });
const connection = (): ProviderConnection => ({ id: 'local-neutral', displayName: 'Independent model', type: 'future-local', configured: true,
  supportsConnectionCheck: false, modelPolicy: { model: model(), installed: true, serverAvailable: true, permitted: true,
    costAllowed: true, concurrencyAllowed: true, evaluations: [] } });
// Synthetic records exercise pure policy only. They are never persisted or
// registered against the installed Ollama model, and certify no real AI.
const checks = (role: ModelRole): QualityCheck[] => roleCriteria[role].map((criterion) => ({ criterion, result: 'passed',
  method: ['review', 'synthesis', 'role_review'].includes(criterion) ? 'human' : 'automatic' }));
const evaluation = (role: ModelRole, current = model()) => recordQualityEvaluation(current, role, 'local_execution', checks(role), '2026-10-23T00:00:00Z');
function qualified(...roles: ModelRole[]) {
  const result = connection(); result.modelPolicy!.evaluations = roles.map((role) => evaluation(role)); return result;
}
const plan = () => JSON.stringify({ title: '분석과 통합', steps: [
  { title: '분석', role: 'analyze', objective: '요청 분석', usesPreviousOutputs: false, isFinal: false, dependsOn: [] },
  { title: '통합', role: 'deliver', objective: '분석 통합', usesPreviousOutputs: true, isFinal: true, dependsOn: [1] },
] });

test('objective quality fixtures validate exact text, Korean, context and production plan schema', () => {
  for (const [criterion, output] of [['text', 'LOOP_OK'], ['korean', '확인했습니다.'], ['context', '40'], ['plan', plan()]] as const) {
    assert.equal(checkQualityOutput(criterion, output).result, 'passed');
    assert.equal(checkQualityOutput(criterion, 'invalid').result, 'failed');
  }
  const invalid = JSON.parse(plan()); invalid.steps[0].dependsOn = [2];
  assert.equal(checkQualityOutput('plan', JSON.stringify(invalid)).result, 'failed');
  assert.equal(checkQualityOutput('text', 'LOOP_OK and explanation').result, 'failed');
});
test('subjective feedback and synthesis never pass automatically', () => {
  for (const criterion of ['review', 'synthesis', 'role_review'] as const) {
    assert.equal(checkQualityOutput(criterion, '완벽합니다.').result, 'not_evaluated');
  }
});
for (const role of modelRoles) test(`unreviewed or fake results cannot verify ${role}`, () => {
  assert.equal(modelQualityState(model(), role, []), 'not_evaluated');
  const unchecked = recordQualityEvaluation(model(), role, 'local_execution', checks(role).filter((check) => check.criterion !== 'role_review'), '2026-10-23');
  assert.equal(unchecked.status, 'not_evaluated');
  const fake = recordQualityEvaluation(model(), role, 'fake', checks(role), '2026-10-23');
  assert.equal(fake.status, 'not_evaluated'); assert.equal(modelQualityState(model(), role, [fake]), 'not_evaluated');
  assert.equal(modelQualityState(model(), role, [{ ...fake, status: 'verified' }]), 'not_evaluated');
});
test('failed evidence stays failed without retaining raw requests or responses', () => {
  const input = checks('review'); input[0]!.result = 'failed';
  const result = recordQualityEvaluation(model(), 'review', 'local_execution', input, '2026-10-23');
  assert.equal(result.status, 'failed'); assert.equal(modelQualityState(model(), 'review', [result]), 'failed');
  assert.deepEqual(Object.keys(result).sort(), ['identity', 'role', 'policyVersion', 'technicalSignature', 'source', 'checkedAt', 'status', 'checks'].sort());
});
test('record construction never verifies a missing digest or invalid timestamp', () => {
  const unidentified = model(); unidentified.identity.digest = '';
  assert.equal(recordQualityEvaluation(unidentified, 'write', 'local_execution', checks('write'), '2026-10-23').status, 'not_evaluated');
  assert.equal(recordQualityEvaluation(model(), 'write', 'local_execution', checks('write'), 'invalid').status, 'not_evaluated');
});
for (const field of ['providerId', 'modelId', 'digest', 'runtimeVersion'] as const) test(`identity ${field} changes invalidate evidence`, () => {
  const current = model(); current.identity[field] = field === 'digest' ? 'b'.repeat(64) : field === 'runtimeVersion' ? '0.40.9' : 'changed';
  assert.equal(modelQualityState(current, 'planning', [evaluation('planning')]), 'stale');
});
test('capability/context/quantization and policy changes invalidate evidence', () => {
  for (const current of [{ ...model(), capabilities: ['completion', 'tools'] }, { ...model(), advertisedContextLength: 2048 }, { ...model(), quantization: 'Q8' }]) {
    assert.equal(modelQualityState(current, 'review', [evaluation('review')]), 'stale');
  }
  assert.equal(modelQualityState(model(), 'review', [{ ...evaluation('review'), policyVersion: 'old' }]), 'stale');
});
for (const corrupt of [null, {}, [null], [{ role: 'planning' }]]) test(`corrupt evidence fails closed ${JSON.stringify(corrupt)}`, () => {
  assert.equal(modelQualityState(model(), 'planning', corrupt as QualityEvaluation[]), 'stale');
});
test('duplicate, forged method, missing identity/date and partial passed evidence cannot certify quality', () => {
  const good = evaluation('planning');
  for (const broken of [ { ...good, identity: undefined }, { ...good, checkedAt: 'invalid' }, { ...good, checks: [] },
    { ...good, checks: good.checks.map((check) => ({ ...check, method: 'automatic' })) } ]) {
    assert.equal(modelQualityState(model(), 'planning', [broken] as QualityEvaluation[]), 'stale');
  }
  assert.equal(modelQualityState(model(), 'planning', [good, good]), 'stale');
});
for (const role of modelRoles) test(`only verified ${role} is eligible, deterministically`, () => {
  const candidate = qualified(role);
  for (const other of modelRoles) assert.equal(roleEligibility(candidate, other).eligible, other === role);
  assert.deepEqual(roleEligibility(candidate, role), roleEligibility(candidate, role));
});
for (const field of ['installed', 'serverAvailable', 'permitted', 'costAllowed', 'concurrencyAllowed'] as const) test(`${field} is a required gate`, () => {
  const candidate = qualified('write'); candidate.modelPolicy![field] = false;
  assert.equal(roleEligibility(candidate, 'write').eligible, false);
});
test('unconfigured, singleOnly, missing identity/capability, unsupported role remain excluded', () => {
  const candidate = qualified('review');
  assert.equal(roleEligibility({ ...candidate, configured: false }, 'review').eligible, false);
  assert.equal(roleEligibility({ ...candidate, singleOnly: true }, 'review').eligible, false);
  assert.equal(roleEligibility(candidate, 'unknown' as ModelRole).eligible, false);
  candidate.modelPolicy!.model!.capabilities = [];
  assert.equal(roleEligibility(candidate, 'review').eligible, false);
  candidate.modelPolicy!.model = undefined;
  assert.equal(roleEligibility(candidate, 'review').eligible, false);
});
test('server restart disables availability without deleting matching quality evidence', () => {
  const candidate = qualified('write'); candidate.modelPolicy!.serverAvailable = false;
  assert.equal(roleEligibility(candidate, 'write').eligible, false);
  assert.equal(modelQualityState(candidate.modelPolicy!.model, 'write', candidate.modelPolicy!.evaluations), 'verified');
  candidate.modelPolicy!.serverAvailable = true;
  assert.equal(roleEligibility(candidate, 'write').eligible, true);
});
test('final write step additionally requires synthesis quality', () => {
  assert.equal(eligibleForStep(qualified('write'), { role: 'write', isFinal: true }), false);
  assert.equal(eligibleForStep(qualified('write', 'deliver'), { role: 'write', isFinal: true }), true);
});
function adapter(id: string) { return { id, displayName: id, execute: async () => ({ output: 'ok' }) }; }
test('role-filtered router retains registry order and legacy API assignments', () => {
  const registry = new ProviderRegistry(); const local = adapter('local-neutral'); const api = adapter('arbitrary-vendor');
  registry.register(local, qualified('analyze')); registry.register(api, { type: 'api', configured: true });
  const pool = autoProviderPool(registry); const parsed = parseTaskPlan(plan());
  assert.deepEqual(assignAutoProviders(parsed, pool, registry).map((step) => step.providerId), ['local-neutral', 'arbitrary-vendor']);
  assert.equal(selectAlternativeProvider(registry, api.id, { role: 'review' }), undefined);
  assert.equal(selectAlternativeProvider(registry, api.id, { role: 'analyze' })?.id, local.id);
  assert.equal(selectAlternativeProvider(registry, api.id), undefined);
});
test('unverified local-only pool fails before any planner request; Single registry access remains available', async () => {
  const registry = new ProviderRegistry(); let calls = 0;
  registry.register({ ...adapter('local-neutral'), execute: async () => { calls++; return { output: 'bad' }; } }, connection());
  assert.throws(() => autoProviderPool(registry));
  assert.equal(selectAlternativeProvider(registry, 'other', { role: 'review' }), undefined);
  assert.equal((await new AutoLoopService(registry).run('작업')).status, 'failed'); assert.equal(calls, 0);
  assert.equal(registry.get('local-neutral').id, 'local-neutral');
});
test('Auto planner never uses analyze-only model; actual work uses verified roles', async () => {
  const registry = new ProviderRegistry(); const calls: string[] = [];
  registry.register({ ...adapter('local-neutral'), execute: async () => { calls.push('local'); return { output: 'analysis' }; } }, qualified('analyze'));
  registry.register({ ...adapter('neutral-api'), execute: async (request) => { calls.push(request.stepTitle); return { output: calls.length === 1 ? plan() : 'final' }; } }, { type: 'api', configured: true });
  const result = await new AutoLoopService(registry).run('정리');
  assert.equal(result.status, 'completed'); assert.equal(result.auto?.planner?.id, 'neutral-api');
  assert.deepEqual(result.steps.map((step) => step.assignedProvider.id), ['local-neutral', 'neutral-api']);
  assert.deepEqual(calls, ['작업 계획 준비', 'local', '통합']);
});
test('Auto cannot use analyze-only model for a review fallback after one retry', async () => {
  const registry = new ProviderRegistry(); let localCalls = 0; let apiCalls = 0;
  const document = JSON.parse(plan()); document.steps[1].role = 'review';
  registry.register({ ...adapter('neutral-api'), execute: async () => {
    apiCalls++; if (apiCalls === 1) return { output: JSON.stringify(document) };
    if (apiCalls === 2) return { output: 'analysis' };
    throw new ProviderError('HTTP_ERROR', 503);
  } }, { type: 'api', configured: true });
  const result = await new AutoLoopService(registry, { retryWait: async () => {}, refreshRegistry: async () => {
    const updated = new ProviderRegistry(); updated.register({ ...adapter('local-neutral'), execute: async () => { localCalls++; return { output: 'bad' }; } }, qualified('analyze'));
    return updated;
  } }).run('검토');
  assert.equal(result.status, 'failed'); assert.equal(apiCalls, 4); assert.equal(localCalls, 0);
});
test('registry snapshots preserve eligibility and exclude extraneous private fields', () => {
  const registry = new ProviderRegistry(); const candidate = qualified('write');
  Object.assign(candidate.modelPolicy!.model!, { apiKey: 'private-secret', template: 'private-template' });
  registry.register(adapter(candidate.id), candidate);
  const snapshot = registry.list()[0]!; snapshot.modelPolicy!.model!.capabilities.length = 0;
  assert.equal(roleEligibility(registry.list()[0]!, 'write').eligible, true);
  assert.doesNotMatch(JSON.stringify(registry.list()), /private-secret|private-template/);
});
test('registry cannot convert corrupt explicit model policy into legacy unrestricted policy', () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.register(adapter('local-neutral'), { ...connection(), modelPolicy: null } as unknown as ProviderConnection));
  assert.equal(registry.list().length, 0);
});
