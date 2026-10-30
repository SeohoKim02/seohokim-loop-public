// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { ProviderError } from '../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../src/providers/provider-error.ts';

// Classification consumes bounded private diagnostics; only fixed codes leave main.
export function cliFailure(text: string): ProviderErrorCode {
  if (/reserved built-in provider IDs|(?:failed|error).*load.*config|unknown configuration (?:field|key)|unknown field|TOML parse error|invalid type.*expected/i.test(text)) return 'CLI_CONFIG_INVALID';
  if (/unexpected argument|unrecognized (?:option|subcommand)|unknown (?:option|argument)/i.test(text)) return 'CLI_OPTIONS_INVALID';
  if (/usage_limit|usage limit|rate_limit|quota.*exceed|limit.*reached/i.test(text)) return 'CLI_USAGE_LIMIT';
  if (/model_not_found|model.*not.*(supported|available)|unsupported.model/i.test(text)) return 'CLI_MODEL_UNAVAILABLE';
  if (/unauthorized|authentication|token.*expired|not logged in|401/i.test(text)) return 'CLI_AUTH_FAILED';
  return 'EXECUTION_FAILED';
}

export function parseCodexEvents(stdout: string): string {
  if (!stdout.endsWith('\n') || stdout.includes('\uFFFD')) throw new ProviderError('CLI_OUTPUT_INVALID');
  let thread = ''; let started = false; let completed = false; let final = '';
  const items = new Map<string, { type: string; completed: boolean }>();
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const invalid = (): never => { throw new ProviderError('CLI_OUTPUT_INVALID'); };
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new ProviderError('CLI_OUTPUT_INVALID'); }
    if (!object(event) || completed) invalid();
    // Exec normally identifies the thread only in thread.started. Reject an
    // explicitly conflicting identity without requiring extra protocol fields.
    if (event.type !== 'thread.started' && event.thread_id !== undefined && event.thread_id !== thread) invalid();
    if (event.type === 'error' || event.type === 'turn.failed') {
      const error = event.type === 'error' ? event : event.error;
      if (!object(error) || typeof error.message !== 'string' || !error.message.trim()) invalid();
      throw new ProviderError(cliFailure(error.message));
    }
    switch (event.type) {
      case 'thread.started':
        if (thread || typeof event.thread_id !== 'string' || !event.thread_id.trim()) invalid();
        thread = event.thread_id; break;
      case 'turn.started':
        if (!thread || started) throw new ProviderError('CLI_OUTPUT_INVALID');
        started = true; break;
      case 'item.started': case 'item.updated': case 'item.completed': {
        const item = event.item;
        if (!thread || !object(item) || typeof item.id !== 'string' || !item.id.trim()) invalid();
        // Compatibility for early completed text items: retain a candidate,
        // never infer turn success from it. Still require turn.started and
        // turn.completed below. Early partial items and tools stay rejected.
        if (!started && event.type !== 'item.completed') invalid();
        if (item.thread_id !== undefined && item.thread_id !== thread) invalid();
        const prior = items.get(item.id);
        if (prior && (prior.completed || prior.type !== item.type || event.type === 'item.started')) invalid();
        // Official ErrorItem is a non-fatal diagnostic, unlike top-level error
        // or turn.failed. 0.160.1 emits startup feature warnings this way.
        // Validate and discard the diagnostic; it can never supply final text.
        if (item.type === 'error') {
          if (event.type !== 'item.completed' || typeof item.message !== 'string'
            || !item.message.trim() || item.message.length > 100_000) invalid();
          items.set(item.id, { type: item.type, completed: true });
          break;
        }
        // Text-only slice. Unknown events and tool activity never mean success.
        if (item.type !== 'agent_message' && item.type !== 'reasoning') throw new ProviderError('CLI_OUTPUT_INVALID');
        if (typeof item.text !== 'string' || item.text.length > 100_000) invalid();
        items.set(item.id, { type: item.type, completed: event.type === 'item.completed' });
        if (item.type === 'agent_message' && item.phase !== undefined && item.phase !== 'final_answer' && item.phase !== 'commentary') invalid();
        if (event.type === 'item.completed' && item.type === 'agent_message') {
          if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 100_000) throw new ProviderError('CLI_OUTPUT_INVALID');
          if (item.phase !== undefined && item.phase !== 'final_answer' && item.phase !== 'commentary') throw new ProviderError('CLI_OUTPUT_INVALID');
          if (item.phase !== 'commentary') final = item.text;
        }
        break;
      }
      case 'turn.completed':
        if (!started || !final) throw new ProviderError('CLI_OUTPUT_INVALID');
        if (!object(event.usage)) invalid();
        for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'cache_write_input_tokens']) {
          const value = event.usage[key];
          if (value === undefined && (key === 'reasoning_output_tokens' || key === 'cache_write_input_tokens')) continue;
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
        }
        if ([...items.values()].some((item) => !item.completed)) invalid();
        completed = true; break;
      default: throw new ProviderError('CLI_OUTPUT_INVALID');
    }
  }
  if (!completed || !final) throw new ProviderError('CLI_OUTPUT_INVALID');
  return final;
}
