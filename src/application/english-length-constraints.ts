// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { LengthExtraction, LengthConstraintSource } from './output-length-diagnostics.ts';

type EnglishExtraction = LengthExtraction & { sources?: LengthConstraintSource[] };

/** Conservative English counterpart of the existing Korean whole-output grammar. */
export function extractEnglishLength(request: string): EnglishExtraction {
  const uncertain = (): EnglishExtraction => ({ available: false, reason: 'uncertain' });
  if (/["'`“”‘’<>\[\]{}]/u.test(request)
    || /\b(?:or|not|never|ignore|except|unless|if|about|around|approximately|roughly|each|per|paragraph|sentence|line|title|heading|quote|quoted|source|example|attachment|words?|bytes?)\b/i.test(request)) return uncertain();
  const pattern = /(?<![\p{L}\p{N}_.+\-])(?:(?<prefix>at least|minimum(?: of)?|at most|maximum(?: of)?|no more than|exactly)\s+(?<n>\d+)\s+(?:characters?|chars?)|between\s+(?<betweenMin>\d+)\s+and\s+(?<betweenMax>\d+)\s+(?:characters?|chars?)|(?<rangeMin>\d+)\s*[-–~]\s*(?<rangeMax>\d+)\s+(?:characters?|chars?))\b/giu;
  const matches = [...request.matchAll(pattern)];
  if (!matches.length) return uncertain();
  let cursor = 0;
  const rest: string[] = [];
  for (const match of matches) {
    const gap = request.slice(cursor, match.index);
    if (cursor && !/^(?:\s|,|and)+$/i.test(gap)) return uncertain();
    rest.push(gap); cursor = match.index + match[0].length;
  }
  rest.push(request.slice(cursor));
  // Only an instruction followed by whole-output constraints is accepted.
  // Numbers, unknown bounds or descriptive prose outside matches are rejected.
  const before = rest[0]!.trim();
  const after = rest.at(-1)!.trim();
  if ((before && !/^(?:please\s+)?(?:write|create|draft|summarize|compose|generate)\b[\p{L}\s,]*?(?:\bin|\busing|\bwith|\bof)?\s*$/iu.test(before))
    || !/^[.!]*$/.test(after)
    || /\d|\b(?:least|most|minimum|maximum|exactly|characters?|chars?|between|length|short|long|less|more|under|over)\b/i.test(rest.join(' '))) return uncertain();
  let minimum: number | undefined;
  let maximum: number | undefined;
  const sources: LengthConstraintSource[] = [];
  for (const match of matches) {
    const g = match.groups!;
    const prefix = g.prefix?.toLowerCase();
    const range = g.rangeMin !== undefined || g.betweenMin !== undefined;
    const n = Number(g.n);
    const lower = range ? Number(g.rangeMin ?? g.betweenMin) : /^(?:at least|minimum|exactly)/.test(prefix ?? '') ? n : undefined;
    const upper = range ? Number(g.rangeMax ?? g.betweenMax) : /^(?:at most|maximum|no more than|exactly)/.test(prefix ?? '') ? n : undefined;
    if ([lower, upper].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      || (lower !== undefined && upper !== undefined && lower > upper)) return { available: false, reason: 'invalid' };
    if (lower !== undefined) minimum = Math.max(minimum ?? 0, lower);
    if (upper !== undefined) maximum = Math.min(maximum ?? Number.MAX_SAFE_INTEGER, upper);
    sources.push({ kind: range ? 'range' : prefix === 'exactly' ? 'exact' : lower !== undefined ? 'minimum' : 'maximum',
      text: match[0], start: match.index, end: match.index + match[0].length });
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) return { available: false, reason: 'conflict', sources };
  const label = minimum !== undefined && maximum !== undefined
    ? minimum === maximum ? `정확히 ${minimum}자` : `${minimum}~${maximum}자`
    : minimum !== undefined ? `최소 ${minimum}자` : `최대 ${maximum}자`;
  return { available: true, condition: { minimum, maximum, label }, sources };
}
