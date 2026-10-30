// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { AIProvider, ProviderExecutionOptions, ProviderRequest, ProviderResponse } from '../../src/providers/ai-provider.ts';
import { abortCode, throwIfCancelled } from '../../src/providers/cancellation.ts';
import { ProviderError } from '../../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../../src/providers/provider-error.ts';
import { attachmentContext, ATTACHMENT_POLICY } from '../../src/providers/text-attachments.ts';

export interface AnthropicConfig { model?: string; apiKey?: string }

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Claude';
  readonly #config: AnthropicConfig | undefined;
  readonly #fetch: typeof fetch;

  // Transport injection is main/test-only. The endpoint is never supplied by renderer.
  constructor(config?: AnthropicConfig, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.#config = config ? { ...config } : undefined;
    this.#fetch = fetcher;
  }

  private settings(): { model: string; apiKey: string } {
    if (!this.#config) throw new ProviderError('CONFIG_MISSING');
    if (!this.#config.apiKey?.trim()) throw new ProviderError('API_KEY_MISSING');
    if (!this.#config.model?.trim()) throw new ProviderError('CONFIG_MISSING');
    if (/[\x00-\x1f\x7f]/.test(this.#config.apiKey + this.#config.model)) throw new ProviderError('CONFIG_INVALID');
    return { model: this.#config.model.trim(), apiKey: this.#config.apiKey.trim() };
  }

  get configurationError(): ProviderErrorCode | undefined {
    try { this.settings(); return undefined; }
    catch (cause) { return cause instanceof ProviderError ? cause.code : 'CONFIG_MISSING'; }
  }

  async execute(request: ProviderRequest, options?: ProviderExecutionOptions): Promise<ProviderResponse> {
    return this.message([
      request.userRequest, `현재 작업: ${request.stepTitle}`,
      ...(request.attachments?.length ? [attachmentContext(request.attachments)] : []),
      ...(request.objective ? [`작업 목표: ${request.objective}`] : []),
      ...(request.previousOutputs.length ? [`이전 결과:\n${request.previousOutputs.join('\n\n')}`] : []),
      request.isFinalStep ? '요청에 대한 최종 결과를 작성해주세요.' : '현재 작업의 결과를 작성해주세요.',
    ].join('\n\n'), false, options?.signal, !!request.attachments?.length);
  }

  async testConnection(): Promise<void> { await this.message('Reply with OK.', true); }

  private async message(content: string, check = false, userSignal?: AbortSignal, attachments = false): Promise<ProviderResponse> {
    throwIfCancelled(userSignal);
    const { model, apiKey } = this.settings();
    const timeout = AbortSignal.timeout(check ? 15_000 : 60_000);
    const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', redirect: 'manual', signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: check ? 16 : 2048, stream: false,
          ...(attachments ? { system: ATTACHMENT_POLICY } : {}), messages: [{ role: 'user', content }] }),
      });
    } catch { throw new ProviderError(signal.aborted ? abortCode(signal, userSignal) : 'NETWORK_ERROR'); }
    if (signal.aborted) throw new ProviderError(abortCode(signal, userSignal));
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError('HTTP_ERROR', response.status);
    }
    let body: unknown;
    try { body = await response.json(); }
    catch (cause) {
      throw new ProviderError(signal.aborted ? abortCode(signal, userSignal) : cause instanceof SyntaxError ? 'RESPONSE_PARSE_ERROR' : 'NETWORK_ERROR');
    }
    if (signal.aborted) throw new ProviderError(abortCode(signal, userSignal));
    if (!body || typeof body !== 'object' || !('type' in body) || body.type !== 'message'
      || !('role' in body) || body.role !== 'assistant' || !('content' in body) || !Array.isArray(body.content)) {
      throw new ProviderError('RESPONSE_PARSE_ERROR');
    }
    // Token/context limits and paused/tool/refused turns are not completed work.
    // The tiny connection probe checks access only and discards its text.
    if ('stop_reason' in body && body.stop_reason !== 'end_turn' && body.stop_reason !== 'stop_sequence'
      && !(check && body.stop_reason === 'max_tokens')) throw new ProviderError('EXECUTION_FAILED');
    const texts: string[] = [];
    for (const block of body.content) {
      // This slice supports text only: tool/thinking blocks are not execution results.
      if (!block || block.type !== 'text' || typeof block.text !== 'string') throw new ProviderError('RESPONSE_PARSE_ERROR');
      texts.push(block.text);
    }
    const output = texts.join('\n');
    if (!output.trim()) throw new ProviderError('RESPONSE_PARSE_ERROR');
    return { output: output.split(apiKey).join('[REDACTED]') };
  }
}
