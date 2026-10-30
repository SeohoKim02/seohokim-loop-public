// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { Loop } from '../domain/loop.ts';
import { inspectWritingConstraints } from './writing-constraints.ts';

export type LengthCondition = { minimum?: number; maximum?: number; label: string };
export type LengthUnavailableReason = 'no_condition' | 'uncertain' | 'conflict' | 'invalid' | 'unavailable_result';
export type LengthExtraction = { available: true; condition: LengthCondition }
  | { available: false; reason: LengthUnavailableReason };
export type LengthDiagnostic = { available: true; condition: LengthCondition; actual: number;
  verdict: 'under' | 'over' | 'satisfied'; difference: number }
  | { available: false; reason: LengthUnavailableReason };

export const lengthUnavailableMessages: Record<LengthUnavailableReason, string> = {
  no_condition: '요청에서 글자 수 조건을 찾지 못했습니다.',
  uncertain: '글자 수 조건을 명확하게 확인할 수 없습니다.',
  conflict: '요청한 글자 수 조건이 서로 충돌합니다.',
  invalid: '글자 수 조건을 명확하게 확인할 수 없습니다.',
  unavailable_result: '완료된 단일 AI 결과에서만 분량을 확인할 수 있습니다.',
};

type LengthEvidence = 'quoted' | 'ambiguous' | 'unsupported' | 'unit' | 'number' | 'reversed_range' | 'bounds_conflict' | 'exact_conflict';
export interface LengthConstraintSource {
  kind: 'minimum' | 'maximum' | 'range' | 'exact';
  text: string;
  // JavaScript UTF-16 offsets into the unchanged request; end is exclusive.
  start: number;
  end: number;
}
export interface LengthSourceInspection {
  request: string;
  indexUnit: 'utf16';
  conditions: readonly LengthConstraintSource[];
  extraction: LengthExtraction;
}
type ExplainedExtraction = LengthExtraction & { evidence?: LengthEvidence; sources?: LengthConstraintSource[] };
export interface LengthGuidance { message: string; help?: string }
const evidenceGuidance: Record<LengthEvidence, LengthGuidance> = {
  quoted: { message: '인용·자료 표현이 있어 실제 작성 지시와 글자 수 조건을 구분할 수 없습니다.' },
  ambiguous: { message: '부정·선택 또는 모호한 표현이 있어 글자 수 조건을 확정할 수 없습니다.' },
  unsupported: { message: '현재 지원하지 않는 글자 수 표현입니다.', help: '최소 100자, 최대 200자처럼 명확한 조건으로 적어주세요.' },
  unit: { message: '현재는 자 단위의 글자 수 조건만 확인할 수 있습니다.', help: '단어나 바이트 수는 글자 수로 바꾸어 계산하지 않습니다.' },
  number: { message: '글자 수 조건의 숫자를 확인해주세요.', help: '0 이상의 정수로 적어주세요. 너무 큰 수와 음수·소수·쉼표·지수 표기는 지원하지 않습니다.' },
  reversed_range: { message: '최소 글자 수가 최대 글자 수보다 큽니다.' },
  bounds_conflict: { message: lengthUnavailableMessages.conflict, help: '결합한 최소 글자 수가 최대 글자 수보다 큽니다.' },
  exact_conflict: { message: lengthUnavailableMessages.conflict, help: '서로 다른 정확한 글자 수가 요청되었습니다.' },
};

// Evidence is attached only at an existing rejection branch. These observations
// explain a rejection; they never accept an expression or change its bounds.
function unsupportedEvidence(text: string): LengthEvidence | undefined {
  if (/(?<!\d)\d+\s*(?:글자|글|문자|단어|바이트|행|페이지|쪽|words?|bytes?|characters?|chars?|字)(?=$|\s|로|를|이상|이하|이내|미만|초과|[,.!])/iu.test(text)) return 'unit';
  if (/(?<!\d)\d+\s*자\s*(?:미만|초과)/u.test(text)) return 'unsupported';
  return undefined;
}

// Deliberately small grammar, not an NLU engine. Reject the entire request when
// source boundaries/scope are uncertain; never mine attachments or quoted text.
function explainLengthExtraction(request: string): ExplainedExtraction {
  if (!request.trim()) return { available: false, reason: 'no_condition' };
  if (request.length > 20_000) return { available: false, reason: 'invalid' };
  if (/["'`“”‘’「」『』<>\[\]{}]/u.test(request)
    || /인용|원문|자료|첨부|예시|예문|출처|본문\s*:|참고\s*:/.test(request)
    || /대략|정도|내외|전후|쯤|가량|약\s*\d|대신|아니|말고|제외|빼고|않|지\s*마|금지|취소|무시|조건부|경우|만약|가능하면|각각|각\s|마다|문단별|줄별|단어|바이트|또는|혹은|거나|중\s*하나|선택|\b(?:or|words?|bytes?|characters?)\b/i.test(request)
    || /(?:^|\s)안\s*(?:쓰|적|작성|넘|지키|맞|되|하)|필요\s*없/.test(request)) {
    let evidence: LengthEvidence | undefined;
    if (/["'`“”‘’「」『』]/u.test(request) || /인용|원문|자료|첨부|예시|예문|출처|본문\s*:|참고\s*:/.test(request)) evidence = 'quoted';
    else if (/않|지\s*마|아니|말고|또는|혹은|거나|중\s*하나|만약|가능하면|대략|약\s*\d|(?<!\d)\d+\s*자\s*(?:정도|내외|전후|쯤)|(?:^|\s)안\s*(?:쓰|적|작성|넘|지키|맞|되|하)|필요\s*없/.test(request)) evidence = 'ambiguous';
    else evidence = unsupportedEvidence(request);
    return { available: false, reason: 'uncertain', evidence };
  }
  // Reject malformed numeric notation before matching a substring of it.
  if (/[+＋−\p{Pd}]\s*\d|\d[.,]\d|\d\s*[eE]\s*\d/u.test(request)) {
    // A date/version elsewhere can trigger the conservative guard too. Only
    // identify a numeric length problem when the malformed token ends in 자.
    const malformedLength = /(?<![\d.,])(?:[+＋−\p{Pd}]\s*\d+\s*자|\d+[.,]\d+(?:[.,]\d+)*\s*자|\d+\s*[eE]\s*\d+\s*자)/u.test(request);
    return { available: false, reason: 'invalid', evidence: malformedLength ? 'number' : undefined };
  }
  // Token boundary also prevents quadratic rescanning of a long digit run.
  const pattern = /(?<![\p{L}\p{N}_.+\-])(?:(?<rangeMin>\d+)\s*[~～]\s*(?<rangeMax>\d+)\s*자|(?<prefix>최소|최대|정확히)\s*(?<prefixN>\d+)\s*자|(?<suffixN>\d+)\s*자\s*(?<suffix>이상|이하|이내))/gu;
  const matches = [...request.matchAll(pattern)];
  if (!matches.length) return { available: false, reason: 'no_condition', evidence: unsupportedEvidence(request) };
  const remainder: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    const after = request.slice(match.index! + match[0].length);
    if (!/^(?:$|\s|[,.!]|으로|로|를|만)/u.test(after)) return { available: false, reason: 'uncertain' };
    const gap = request.slice(cursor, match.index);
    // Only explicit conjunction/list separators join constraints. Do not infer
    // AND from alternatives, quoted statements, conditions or scoped clauses.
    if (cursor && !/^(?:\s|,|그리고|및)+$/.test(gap)) return { available: false, reason: 'uncertain' };
    remainder.push(gap);
    cursor = match.index! + match[0].length;
  }
  remainder.push(request.slice(cursor));
  const rest = remainder.join(' ');
  const outer = remainder[0] + ' ' + remainder.at(-1);
  // A second unsupported bound, a different unit, or a descriptive statement
  // must not become an apparently verified whole-output constraint.
  if (/[\p{N}일이삼사오육칠팔구십백천만]+\s*(?:자|글자|글|문자|행|페이지|쪽|words?|bytes?|characters?|chars?|字)|몇\s*자|[~～]|최소|최대|정확히|이상|이하|이내|미만|초과|길이|분량|글자\s*수|문자\s*수|짧게|길게|적당히|적당하게/iu.test(rest)
    || (!/^[\s.!]*$/.test(outer)
      && !/(작성(?:해\s*줘|해주세요|하세요|하라)|써\s*줘|써주세요|쓰세요|적어\s*줘|만들어\s*줘|만들어주세요|요약해\s*줘|요약해주세요|정리해\s*줘|정리해주세요)[\s.!]*$/.test(rest))
    || /라고|라는|였다|입니다|인지|분석|설명|비교|뜻|언급|제목|문구|적힌|적혀|친구|문단|단락|문장|줄|항목|부분|구간|서론|결론|본문/.test(rest)) {
    return { available: false, reason: 'uncertain', evidence: unsupportedEvidence(rest) };
  }
  let minimum: number | undefined;
  let maximum: number | undefined;
  let exactValue: number | undefined;
  let differentExactValues = false;
  const sources: LengthConstraintSource[] = [];
  for (const match of matches) {
    const g = match.groups!;
    let lower: number | undefined;
    let upper: number | undefined;
    if (g.rangeMin !== undefined) { lower = Number(g.rangeMin); upper = Number(g.rangeMax); }
    else {
      const value = Number(g.prefixN ?? g.suffixN);
      if (g.prefix === '최소' || g.suffix === '이상' || g.prefix === '정확히') lower = value;
      if (g.prefix === '최대' || g.suffix === '이하' || g.suffix === '이내' || g.prefix === '정확히') upper = value;
    }
    if ([lower, upper].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
      return { available: false, reason: 'invalid', evidence: 'number' };
    }
    if (lower !== undefined && upper !== undefined && lower > upper) return { available: false, reason: 'invalid', evidence: 'reversed_range' };
    if (g.prefix === '정확히') {
      if (exactValue !== undefined && exactValue !== lower) differentExactValues = true;
      exactValue = lower;
    }
    if (lower !== undefined) minimum = Math.max(minimum ?? 0, lower);
    if (upper !== undefined) maximum = Math.min(maximum ?? Number.MAX_SAFE_INTEGER, upper);
    sources.push({ kind: g.rangeMin !== undefined ? 'range' : g.prefix === '정확히' ? 'exact' : lower !== undefined ? 'minimum' : 'maximum',
      text: match[0], start: match.index!, end: match.index! + match[0].length });
  }
  // Validate every condition before reporting an empty inclusive intersection.
  // Missing bounds stay absent rather than becoming artificial UI limits.
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    return { available: false, reason: 'conflict', evidence: differentExactValues ? 'exact_conflict' : 'bounds_conflict', sources };
  }
  const label = minimum !== undefined && maximum !== undefined
    ? minimum === maximum ? `정확히 ${minimum}자` : `${minimum}~${maximum}자`
    : minimum !== undefined ? `최소 ${minimum}자` : `최대 ${maximum}자`;
  return { available: true, condition: { minimum, maximum, label }, sources };
}

// Keep the existing public extraction/diagnostic contract byte-for-byte stable.
export function extractLengthCondition(request: string): LengthExtraction {
  const result = explainLengthExtraction(request);
  return result.available ? { available: true, condition: result.condition } : { available: false, reason: result.reason };
}

export function inspectLengthConstraintSources(request: string): LengthSourceInspection {
  const result = explainLengthExtraction(request);
  // Only publish locations after the whole request and every numeric bound
  // were validated. Early rejection never exposes a partially matched rule.
  return { request, indexUnit: 'utf16', conditions: result.sources ?? [],
    extraction: result.available ? { available: true, condition: result.condition } : { available: false, reason: result.reason } };
}

export interface LengthSourcePart { text: string; source?: LengthConstraintSource }
export function splitLengthConstraintSource(request: string, conditions: readonly LengthConstraintSource[]): LengthSourcePart[] {
  const plain = () => [{ text: request }];
  const ordered = [...conditions].sort((a, b) => a.start - b.start || a.end - b.end);
  const boundary = (offset: number) => !(offset > 0 && offset < request.length
    && /[\uD800-\uDBFF]/.test(request[offset - 1]!) && /[\uDC00-\uDFFF]/.test(request[offset]!));
  const unique: LengthConstraintSource[] = [];
  for (const source of ordered) {
    if (!Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start < 0
      || source.end <= source.start || source.end > request.length || !boundary(source.start) || !boundary(source.end)
      || request.slice(source.start, source.end) !== source.text) return plain();
    const previous = unique.at(-1);
    if (previous && source.start < previous.end) {
      if (source.start === previous.start && source.end === previous.end && source.kind === previous.kind) continue;
      return plain(); // Ambiguous overlap: preserve the text without guessing a highlight.
    }
    unique.push(source);
  }
  const parts: LengthSourcePart[] = [];
  let cursor = 0;
  for (const source of unique) {
    if (source.start > cursor) parts.push({ text: request.slice(cursor, source.start) });
    parts.push({ text: request.slice(source.start, source.end), source });
    cursor = source.end;
  }
  if (cursor < request.length) parts.push({ text: request.slice(cursor) });
  return parts.length ? parts : plain();
}

export function getLengthDiagnosticGuidance(request: string, result: LengthDiagnostic): LengthGuidance | undefined {
  if (result.available) return undefined;
  if (result.reason === 'unavailable_result') return { message: lengthUnavailableMessages.unavailable_result };
  const explanation = explainLengthExtraction(request);
  // Match the failure class; the UI binds this request, output and result in
  // one snapshot. A class mismatch must not manufacture a specific cause.
  if (explanation.available || explanation.reason !== result.reason) return { message: lengthUnavailableMessages.uncertain };
  return explanation.evidence ? { ...evidenceGuidance[explanation.evidence] }
    : { message: lengthUnavailableMessages[result.reason] };
}

export function canDiagnoseLength(loop: Loop): boolean {
  return loop.mode === 'manual' && !loop.collaboration && !loop.auto && loop.status === 'completed'
    && typeof loop.finalResult === 'string' && !!loop.finalResult.trim()
    && loop.finalResult.length <= 200_000 && !/[\uD800-\uDFFF]/u.test(loop.finalResult);
}

export function diagnoseOutputLength(loop: Loop): LengthDiagnostic {
  if (!canDiagnoseLength(loop)) return { available: false, reason: 'unavailable_result' };
  const extraction = extractLengthCondition(loop.userRequest);
  if (!extraction.available) return extraction;
  const { condition } = extraction;
  const inspected = inspectWritingConstraints(loop.finalResult!, {
    minLength: condition.minimum ?? 0, maxLength: condition.maximum ?? Number.MAX_SAFE_INTEGER,
  });
  const issue = inspected.objectiveIssues[0];
  return { available: true, condition, actual: inspected.length,
    verdict: issue?.code === 'LENGTH_UNDER_MINIMUM' ? 'under' : issue?.code === 'LENGTH_OVER_MAXIMUM' ? 'over' : 'satisfied',
    difference: issue?.code === 'LENGTH_UNDER_MINIMUM' ? issue.shortfall : issue?.code === 'LENGTH_OVER_MAXIMUM' ? issue.excess : 0 };
}
