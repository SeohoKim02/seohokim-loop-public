// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { Loop, LoopStep } from './loop.ts';

export const HISTORY_LIMIT = 100;
export const HISTORY_BYTES = 2 * 1024 * 1024;
export type HistoryMode = 'auto' | 'single' | 'manual';
export type HistoryStep = Pick<LoopStep, 'id' | 'title' | 'role' | 'assignedProvider' | 'originalProvider'
  | 'startedAt' | 'completedAt' | 'output' | 'retryCount' | 'fallbackCount'> & { status: 'completed' };
export interface LoopHistory {
  schemaVersion: 1;
  id: string;
  title: string;
  userRequest: string;
  executionMode: HistoryMode;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  status: 'completed';
  finalResult: string;
  steps: HistoryStep[];
}
export type HistorySummary = Pick<LoopHistory, 'id' | 'title' | 'executionMode' | 'completedAt' | 'status'>
  & { stepCount: number; providers: { id: string; displayName: string }[] };
export type HistoryCode = 'invalid' | 'too_large' | 'limit' | 'encryption' | 'unavailable' | 'corrupt' | 'version' | 'missing' | 'conflict';
export class HistoryError extends Error {
  readonly code: HistoryCode;
  constructor(code: HistoryCode) { super('History operation failed.'); this.code = code; }
}
export function isHistoryId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HistoryError('invalid');
  const data = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(data, key)) || Object.keys(data).some((key) => !required.includes(key) && !optional.includes(key))) throw new HistoryError('invalid');
  return data;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\uD800-\uDFFF]/u.test(value)) throw new HistoryError('invalid');
  return value;
}
function id(value: unknown): string { if (!isHistoryId(value)) throw new HistoryError('invalid'); return value; }
function date(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new HistoryError('invalid');
  return value;
}
function provider(value: unknown): { id: string; displayName: string } {
  const data = object(value, ['id', 'displayName']);
  const providerId = text(data.id, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(providerId)) throw new HistoryError('invalid');
  return { id: providerId, displayName: text(data.displayName, 200) };
}

// Reconstruct every permitted field at both the IPC and decrypted-file boundaries.
export function validateHistory(value: unknown): LoopHistory {
  const data = object(value, ['schemaVersion', 'id', 'title', 'userRequest', 'executionMode', 'createdAt', 'startedAt', 'completedAt', 'status', 'finalResult', 'steps']);
  if (data.schemaVersion !== 1) throw new HistoryError('version');
  if (data.status !== 'completed' || !['auto', 'single', 'manual'].includes(data.executionMode as string)
    || !Array.isArray(data.steps) || data.steps.length < 1 || data.steps.length > 5) throw new HistoryError('invalid');
  const steps: HistoryStep[] = data.steps.map((value) => {
    const step = object(value, ['id', 'title', 'assignedProvider', 'startedAt', 'completedAt', 'status', 'output', 'retryCount'], ['role', 'originalProvider', 'fallbackCount']);
    if (step.status !== 'completed' || (step.retryCount !== 0 && step.retryCount !== 1)
      || (step.fallbackCount !== undefined && step.fallbackCount !== 0 && step.fallbackCount !== 1)
      || (step.role !== undefined && !['primary', 'reviewer', 'analyze', 'write', 'review', 'improve', 'deliver'].includes(step.role as string))) throw new HistoryError('invalid');
    const result: HistoryStep = { id: id(step.id), title: text(step.title, 200), assignedProvider: provider(step.assignedProvider),
      startedAt: date(step.startedAt), completedAt: date(step.completedAt), status: 'completed', output: text(step.output, 200_000), retryCount: step.retryCount,
      ...(step.role !== undefined ? { role: step.role as HistoryStep['role'] } : {}),
      ...(step.originalProvider !== undefined ? { originalProvider: provider(step.originalProvider) } : {}),
      ...(step.fallbackCount !== undefined ? { fallbackCount: step.fallbackCount as 0 | 1 } : {}) };
    if (result.startedAt! > result.completedAt!) throw new HistoryError('invalid');
    return result;
  });
  const result: LoopHistory = { schemaVersion: 1, id: id(data.id), title: text(data.title, 120), userRequest: text(data.userRequest, 20_000),
    executionMode: data.executionMode as HistoryMode, createdAt: date(data.createdAt), startedAt: date(data.startedAt), completedAt: date(data.completedAt),
    status: 'completed', finalResult: text(data.finalResult, 200_000), steps };
  if (new Set(steps.map((step) => step.id)).size !== steps.length || result.createdAt > result.startedAt || result.startedAt > result.completedAt
    || steps.some((step) => step.startedAt! < result.startedAt || step.completedAt! > result.completedAt)
    || steps.at(-1)!.output !== result.finalResult) throw new HistoryError('invalid');
  if (new TextEncoder().encode(JSON.stringify(result)).length > HISTORY_BYTES) throw new HistoryError('too_large');
  return result;
}

export function historySnapshot(loop: Loop): LoopHistory {
  if (loop.status !== 'completed') throw new HistoryError('invalid');
  return validateHistory({ schemaVersion: 1, id: loop.id,
    title: loop.auto?.title ?? Array.from(loop.userRequest.replace(/\s+/g, ' ').trim()).slice(0, 60).join(''),
    userRequest: loop.userRequest, executionMode: loop.mode === 'auto' ? 'auto' : loop.collaboration ? 'manual' : 'single',
    createdAt: loop.createdAt, startedAt: loop.startedAt, completedAt: loop.completedAt, status: loop.status, finalResult: loop.finalResult,
    steps: loop.steps.map((step) => ({ id: step.id, title: step.title, status: step.status,
      assignedProvider: { id: step.assignedProvider.id, displayName: step.assignedProvider.displayName },
      ...(step.originalProvider ? { originalProvider: { id: step.originalProvider.id, displayName: step.originalProvider.displayName } } : {}),
      ...(step.role !== undefined ? { role: step.role } : {}), ...(step.fallbackCount !== undefined ? { fallbackCount: step.fallbackCount } : {}),
      startedAt: step.startedAt, completedAt: step.completedAt, output: step.output, retryCount: step.retryCount })) });
}
export function historySummary(record: LoopHistory): HistorySummary {
  const providers = [...new Map(record.steps.map((step) => [step.assignedProvider.id, { ...step.assignedProvider }])).values()];
  return { id: record.id, title: record.title, executionMode: record.executionMode, completedAt: record.completedAt,
    status: 'completed', stepCount: record.steps.length, providers };
}
export function historyLoop(record: LoopHistory): Loop {
  return { id: record.id, userRequest: record.userRequest, mode: record.executionMode === 'auto' ? 'auto' : 'manual',
    createdAt: record.createdAt, startedAt: record.startedAt, completedAt: record.completedAt,
    status: 'completed', finalResult: record.finalResult, steps: record.steps };
}
