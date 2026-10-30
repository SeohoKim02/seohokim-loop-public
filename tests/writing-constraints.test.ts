// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectWritingConstraints, measureWritingText } from '../src/application/writing-constraints.ts';
import type { WritingConstraints } from '../src/application/writing-constraints.ts';
import { modelQualityState } from '../src/application/model-quality.ts';
import { modelRoles } from '../src/providers/model-capability.ts';
import { roleEligibility } from '../src/application/role-eligibility.ts';
import { autoProviderPool, selectAlternativeProvider } from '../src/application/auto-router.ts';
import type { ProviderConnection } from '../src/providers/provider-registry.ts';

// Public-copy fixture: invented metadata, not an actual evaluation or model qualification.
const syntheticModel = { identity: { providerId: 'ollama-local', modelId: 'synthetic-model', digest: 'a'.repeat(64), runtimeVersion: '0.1.0' },
  local: true, capabilities: ['completion'], format: 'gguf', licensePresent: false };

test('length uses Unicode code points, not UTF-16 units, graphemes or bytes', () => {
  for (const [text, count] of [['한글', 2], ['가😀', 2], ['가'.normalize('NFD'), 2], ['👨‍👩‍👧‍👦', 7]] as const) {
    assert.equal(measureWritingText(text).length, count);
  }
  assert.equal('가😀'.length, 3); // Distinguish JS string.length from this contract.
});

test('only CRLF and outer whitespace normalize; inner spaces and Markdown characters count', () => {
  const raw = ' \t\r\n가  나\r\n- 다.  \r\n\n';
  const measured = measureWritingText(raw);
  assert.equal(measured.text, '가  나\n- 다.');
  assert.equal(measured.length, 9);
  assert.equal(measureWritingText('**가**').length, 5);
  assert.equal(measureWritingText('가  \n나').length, 5);
  assert.equal(measureWritingText('\t \r\n').length, 0);
  assert.equal(measureWritingText('가\r나').length, 3); // Lone CR is not silently rewritten.
  assert.equal(measureWritingText('가\n\n나').length, 4);
});

test('literal absence is a proxy: a synonym can preserve meaning while missing the required string', () => {
  const result = inspectWritingConstraints('자료를 살펴보고 의견을 보내주세요.', { minLength: 1, maxLength: 100, requiredLiterals: ['검토'] });
  assert.equal(result.objectiveIssues[0]!.code, 'REQUIRED_CONTENT_MISSING');
  assert.equal(result.humanReview, 'pending');
  // Conversely, keyword presence cannot detect a negated factual claim.
  const negated = inspectWritingConstraints('만족도 조사는 하지 않은 것이 아닙니다.', { minLength: 1, maxLength: 100, requiredLiterals: ['만족도', '조사'] });
  assert.deepEqual(negated.objectiveIssues, []);
  assert.equal(negated.humanReview, 'pending');
});

test('diagnostic messages never echo raw output, required text or arbitrary error content', () => {
  const secret = 'fake-credential-for-test';
  const result = inspectWritingConstraints(secret, { minLength: 50, maxLength: 80, requiredLiterals: [`${secret}-missing`],
    format: { paragraphs: 2, sentencePeriods: 2, title: secret, ending: secret } });
  assert.doesNotMatch(JSON.stringify(result), /fake-credential/);
  assert.throws(() => inspectWritingConstraints(secret, { minLength: 100, maxLength: 0 }), /^Error: INVALID_WRITING_CONSTRAINTS$/);
});

test('boundary counts and format constraints report issues without changing the output', () => {
  assert.deepEqual(inspectWritingConstraints('가나', { minLength: 2, maxLength: 2 }).objectiveIssues, []);
  assert.equal(inspectWritingConstraints('가나다', { minLength: 2, maxLength: 2 }).objectiveIssues[0]!.code, 'LENGTH_OVER_MAXIMUM');
  const c: WritingConstraints = { minLength: 0, maxLength: 100, format: { paragraphs: 2, sentencePeriods: 2,
    title: '제목', ending: '드립니다.', bulletLines: 3, periodsPerParagraph: 2 } };
  const before = JSON.stringify(c);
  const result = inspectWritingConstraints('다른 제목\n\n한 문장.', c);
  assert.deepEqual(result.objectiveIssues.filter(issue => issue.code === 'FORMAT_VIOLATION').map(issue => issue.rule),
    ['sentence_periods', 'title', 'ending', 'bullet_lines', 'periods_per_paragraph']);
  assert.equal(JSON.stringify(c), before);
  assert.ok(inspectWritingConstraints('한 문장.', c).objectiveIssues.some(issue => issue.code === 'FORMAT_VIOLATION' && issue.rule === 'paragraphs'));
});

test('invalid numeric conditions fail closed rather than relaxing the request', () => {
  for (const value of [NaN, Infinity, -1, 1.5]) {
    assert.throws(() => inspectWritingConstraints('가', { minLength: value, maxLength: 10 }), /INVALID_WRITING_CONSTRAINTS/);
  }
  assert.throws(() => inspectWritingConstraints('가', { minLength: 1, maxLength: 10, requiredLiterals: [''] }), /INVALID_WRITING_CONSTRAINTS/);
  assert.throws(() => inspectWritingConstraints('가', { minLength: 1, maxLength: 10, format: { paragraphs: 0, sentencePeriods: 1 } }), /INVALID_WRITING_CONSTRAINTS/);
});

test('synthetic model remains unverified and excluded from Auto and fallback after diagnostics', () => {
  const connection: ProviderConnection = { id: 'ollama-local', displayName: 'Local model', type: 'ollama', configured: true,
    singleOnly: true, supportsConnectionCheck: false,
    modelPolicy: { model: syntheticModel, installed: true, serverAvailable: true, permitted: false, costAllowed: true,
      concurrencyAllowed: true, evaluations: [] } };
  const registry = { list: () => [connection], get: () => { throw Error('Must not resolve a provider'); } };
  for (const role of modelRoles) {
    assert.equal(modelQualityState(syntheticModel, role, []), 'not_evaluated');
    assert.deepEqual(roleEligibility(connection, role), { eligible: false, reason: 'single_only' });
  }
  assert.throws(() => autoProviderPool(registry));
  assert.equal(selectAlternativeProvider(registry, 'other', { role: 'write' }), undefined);
  assert.deepEqual(connection.modelPolicy!.evaluations, []);
});
