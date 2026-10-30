// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

// Pure, opt-in diagnostics. No provider, persistence, rewriting or quality approval.
// Keep v1 counting semantics: Unicode code points, CRLF -> LF, outer trim only.
export function measureWritingText(output: string) {
  const text = output.replace(/\r\n/g, '\n').trim();
  return { text, length: [...text].length, rawLength: [...output].length, paragraphs: text.split(/\n\s*\n/) };
}

export interface WritingConstraints {
  minLength: number;
  maxLength: number;
  // Literal presence only; callers must not treat this as semantic fact checking.
  requiredLiterals?: readonly string[];
  forbiddenLiterals?: readonly string[];
  requiredNumbers?: readonly string[];
  allowedNumbers?: readonly string[];
  format?: {
    paragraphs: number;
    sentencePeriods: number;
    title?: string;
    ending?: string;
    bulletLines?: number;
    periodsPerParagraph?: number;
    // Each prescribed line is one period-terminated sentence with this exact label.
    sentenceLinePrefixes?: readonly string[];
    exactParagraphBreaks?: boolean;
  };
}

export type WritingConstraintIssue =
  | { code: 'LENGTH_UNDER_MINIMUM'; actual: number; minimum: number; shortfall: number; message: string }
  | { code: 'LENGTH_OVER_MAXIMUM'; actual: number; maximum: number; excess: number; message: string }
  | { code: 'REQUIRED_CONTENT_MISSING'; missingLiteralCount: number; message: string }
  | { code: 'FORBIDDEN_EXPRESSION'; count: number; message: string }
  | { code: 'REQUIRED_NUMBER_MISSING'; count: number; message: string }
  | { code: 'UNSUPPORTED_NUMBER'; count: number; message: string }
  | { code: 'FORMAT_VIOLATION'; rule: 'paragraphs' | 'sentence_periods' | 'title' | 'ending' | 'bullet_lines' | 'periods_per_paragraph' | 'sentence_lines' | 'paragraph_breaks'; message: string };

export interface WritingConstraintResult {
  length: number;
  rawLength: number;
  objectiveIssues: WritingConstraintIssue[];
  // No semantic, style or role-quality verdict can be produced by this function.
  humanReview: 'pending';
}

export function inspectWritingConstraints(output: string, constraints: WritingConstraints): WritingConstraintResult {
  const { minLength, maxLength, requiredLiterals, forbiddenLiterals, requiredNumbers, allowedNumbers, format } = constraints;
  const count = (value: number, minimum: number) => Number.isSafeInteger(value) && value >= minimum;
  const literals = (values: readonly string[] | undefined) => values === undefined
    || (Array.isArray(values) && values.every(value => typeof value === 'string' && !!value.trim()));
  const numbers = (values: readonly string[] | undefined) => literals(values)
    && (values === undefined || values.every(value => /^\d+(?:[.,]\d+)*$/.test(value)));
  if (!count(minLength, 0) || !count(maxLength, 0) || minLength > maxLength
    || !literals(requiredLiterals) || !literals(forbiddenLiterals) || !numbers(requiredNumbers) || !numbers(allowedNumbers)
    || (allowedNumbers && requiredNumbers?.some(value => !allowedNumbers.includes(value)))
    || requiredLiterals?.some(value => forbiddenLiterals?.some(banned => value.includes(banned)))
    || (format && (!count(format.paragraphs, 1) || !count(format.sentencePeriods, 1)
      || (format.bulletLines !== undefined && !count(format.bulletLines, 1))
      || (format.periodsPerParagraph !== undefined && !count(format.periodsPerParagraph, 1))
      || !literals(format.sentenceLinePrefixes) || format.sentenceLinePrefixes?.length === 0
      || (format.exactParagraphBreaks !== undefined && typeof format.exactParagraphBreaks !== 'boolean')
      || [format.title, format.ending].some(value => value !== undefined && (typeof value !== 'string' || !value.trim()))))) {
    throw new Error('INVALID_WRITING_CONSTRAINTS');
  }
  const { text, length, rawLength, paragraphs } = measureWritingText(output);
  const objectiveIssues: WritingConstraintIssue[] = [];
  if (length < minLength) objectiveIssues.push({ code: 'LENGTH_UNDER_MINIMUM', actual: length, minimum: minLength,
    shortfall: minLength - length, message: `분량은 ${length}자로 최소 ${minLength}자보다 ${minLength - length}자 부족합니다. 원문을 확인해주세요.` });
  if (length > maxLength) objectiveIssues.push({ code: 'LENGTH_OVER_MAXIMUM', actual: length, maximum: maxLength,
    excess: length - maxLength, message: `분량은 ${length}자로 최대 ${maxLength}자를 ${length - maxLength}자 초과합니다. 원문을 확인해주세요.` });
  const missingLiteralCount = new Set(requiredLiterals?.filter(value => !text.includes(value))).size;
  if (missingLiteralCount) objectiveIssues.push({ code: 'REQUIRED_CONTENT_MISSING', missingLiteralCount,
    message: `필수 문자열 ${missingLiteralCount}개를 찾지 못했습니다. 같은 의미의 다른 표현인지는 사람 검토가 필요합니다.` });
  const forbiddenCount = new Set(forbiddenLiterals?.filter(value => text.includes(value))).size;
  if (forbiddenCount) objectiveIssues.push({ code: 'FORBIDDEN_EXPRESSION', count: forbiddenCount, message: '명시적으로 금지한 문자열이 포함돼 있습니다.' });
  const foundNumbers = new Set(text.match(/\d+(?:[.,]\d+)*/g) ?? []);
  const missingNumbers = new Set(requiredNumbers?.filter(value => !foundNumbers.has(value))).size;
  if (missingNumbers) objectiveIssues.push({ code: 'REQUIRED_NUMBER_MISSING', count: missingNumbers, message: '요청한 아라비아 숫자가 누락됐습니다. 사실과 수치의 연결은 별도 검토가 필요합니다.' });
  const unsupportedNumbers = allowedNumbers === undefined ? 0 : [...foundNumbers].filter(value => !allowedNumbers.includes(value)).length;
  if (unsupportedNumbers) objectiveIssues.push({ code: 'UNSUPPORTED_NUMBER', count: unsupportedNumbers, message: '허용 목록에 없는 아라비아 숫자가 있습니다.' });
  const violation = (rule: Extract<WritingConstraintIssue, { code: 'FORMAT_VIOLATION' }>['rule'], message: string) => {
    objectiveIssues.push({ code: 'FORMAT_VIOLATION', rule, message });
  };
  if (format) {
    const body = format.title === undefined ? text : paragraphs.slice(1).join('\n\n');
    if (paragraphs.length !== format.paragraphs) violation('paragraphs', '요청한 문단 수와 다릅니다.');
    if ((body.match(/\./g) ?? []).length !== format.sentencePeriods || /[!?]/.test(body) || !body.endsWith('.')) {
      violation('sentence_periods', '요청한 마침표 개수 또는 문장 종료 형식과 다릅니다.');
    }
    if (format.title !== undefined && paragraphs[0] !== format.title) violation('title', '요청한 제목 형식과 다릅니다.');
    if (format.ending !== undefined && !text.endsWith(format.ending)) violation('ending', '요청한 끝 문자열과 다릅니다.');
    if (format.bulletLines !== undefined && (text.split('\n').length !== format.bulletLines
      || !text.split('\n').every(line => line.startsWith('- ') && (line.match(/\./g) ?? []).length === 1))) {
      violation('bullet_lines', '요청한 목록 줄 수 또는 줄별 형식과 다릅니다.');
    }
    if (format.periodsPerParagraph !== undefined
      && !paragraphs.every(paragraph => (paragraph.match(/\./g) ?? []).length === format.periodsPerParagraph)) {
      violation('periods_per_paragraph', '문단별 마침표 개수가 요청과 다릅니다.');
    }
    if (format.sentenceLinePrefixes) {
      const lines = text.split('\n');
      if (lines.length !== format.sentenceLinePrefixes.length || !lines.every((line, index) =>
        line.startsWith(format.sentenceLinePrefixes![index]!) && (line.match(/\./g) ?? []).length === 1 && line.endsWith('.'))) {
        violation('sentence_lines', '지정한 줄별 표기 또는 한 문장 형식과 다릅니다.');
      }
    }
    if (format.exactParagraphBreaks && (paragraphs.length !== format.paragraphs
      || paragraphs.some(paragraph => /[\r\n]/.test(paragraph)) || text !== paragraphs.join('\n\n'))) {
      violation('paragraph_breaks', '문단 사이는 빈 줄 하나로 구분하고 문단 안에서는 줄을 바꾸지 않아야 합니다.');
    }
  }
  // Return counts and fixed messages only. Never echo user output or constraint text.
  return { length, rawLength, objectiveIssues, humanReview: 'pending' };
}
