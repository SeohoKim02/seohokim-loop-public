// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import type { AIProvider, ProviderExecutionOptions, ProviderRequest, ProviderResponse } from '../../src/providers/ai-provider.ts';
import { abortCode, throwIfCancelled } from '../../src/providers/cancellation.ts';
import { ProviderError } from '../../src/providers/provider-error.ts';
import type { ProviderErrorCode } from '../../src/providers/provider-error.ts';
import { attachmentContext, ATTACHMENT_POLICY } from '../../src/providers/text-attachments.ts';

// Main-process-only configuration. Never serialize this object over IPC.
export interface OpenAICompatibleConfig {
  id: string;
  displayName: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

function endpointFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    return url.href;
  } catch {
    throw new ProviderError('INVALID_BASE_URL');
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly #config: OpenAICompatibleConfig | undefined;
  readonly #fetch: typeof fetch;

  constructor(config?: OpenAICompatibleConfig, fetcher: typeof fetch = fetch) {
    this.id = config?.id ?? 'openai-compatible';
    this.displayName = config?.displayName ?? 'OpenAI-compatible';
    this.#config = config ? { ...config } : undefined;
    this.#fetch = fetcher;
  }

  private settings(): { endpoint: string; model: string; apiKey: string } {
    const config = this.#config;
    if (!config) throw new ProviderError('CONFIG_MISSING');
    if (!config.apiKey?.trim()) throw new ProviderError('API_KEY_MISSING');
    if (!config.baseUrl?.trim() || !config.model?.trim()) throw new ProviderError('CONFIG_MISSING');
    // Reject header control characters without including any credential in the error.
    if (/[\r\n]/.test(config.apiKey)) throw new ProviderError('EXECUTION_FAILED');
    return { endpoint: endpointFor(config.baseUrl.trim()), model: config.model.trim(), apiKey: config.apiKey.trim() };
  }

  get configurationError(): ProviderErrorCode | undefined {
    try { this.settings(); return undefined; }
    catch (cause) { return cause instanceof ProviderError ? cause.code : 'CONFIG_MISSING'; }
  }

  async execute(request: ProviderRequest, options?: ProviderExecutionOptions): Promise<ProviderResponse> {
    return this.completion([
      request.userRequest,
      ...(request.attachments?.length ? [attachmentContext(request.attachments)] : []),
      `현재 작업: ${request.stepTitle}`,
      ...(request.objective ? [`작업 목표: ${request.objective}`] : []),
      ...(request.previousOutputs.length ? [`이전 결과:\n${request.previousOutputs.join('\n\n')}`] : []),
      request.isFinalStep ? '요청에 대한 최종 결과를 작성해주세요.' : '현재 작업의 결과를 작성해주세요.',
    ].join('\n\n'), false, options?.signal, !!request.attachments?.length);
  }

  async testConnection(): Promise<void> {
    // One explicit tiny request; discard generated text and never retry automatically.
    await this.completion('Reply with OK.', true);
  }

  private async completion(content: string, connectionCheck = false, userSignal?: AbortSignal, attachments = false): Promise<ProviderResponse> {
    throwIfCancelled(userSignal);
    const { endpoint, model, apiKey } = this.settings();
    const timeout = AbortSignal.timeout(connectionCheck ? 15_000 : 60_000);
    const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        // Never forward credentials through a server-directed redirect.
        redirect: 'manual',
        signal,
        body: JSON.stringify({
          model,
          stream: false,
          messages: [...(attachments ? [{ role: 'system', content: ATTACHMENT_POLICY }] : []), { role: 'user', content }],
          ...(connectionCheck ? { max_completion_tokens: 16 } : {}),
        }),
      });
    } catch {
      throw new ProviderError(signal.aborted ? abortCode(signal, userSignal) : 'NETWORK_ERROR');
    }
    if (signal.aborted) throw new ProviderError(abortCode(signal, userSignal));
    if (!response.ok) {
      // Do not read or log a remote error body/statusText: it may echo secrets.
      await response.body?.cancel().catch(() => {});
      throw new ProviderError('HTTP_ERROR', response.status);
    }

    let body: unknown;
    try { body = await response.json(); }
    catch (cause) {
      throw new ProviderError(signal.aborted ? abortCode(signal, userSignal)
        : cause instanceof SyntaxError ? 'RESPONSE_PARSE_ERROR' : 'NETWORK_ERROR');
    }
    if (signal.aborted) throw new ProviderError(abortCode(signal, userSignal));
    if (!body || typeof body !== 'object' || !('choices' in body) || !Array.isArray(body.choices)) {
      throw new ProviderError('RESPONSE_PARSE_ERROR');
    }
    const choice: unknown = body.choices[0];
    if (!choice || typeof choice !== 'object' || !('message' in choice)
      || !choice.message || typeof choice.message !== 'object' || !('content' in choice.message)
      || typeof choice.message.content !== 'string') {
      throw new ProviderError('RESPONSE_PARSE_ERROR');
    }
    // A tiny budget can be consumed by reasoning tokens. A valid length-limited
    // completion still verifies authentication/API access, not answer quality.
    if (!choice.message.content.trim()
      && !(connectionCheck && 'finish_reason' in choice && choice.finish_reason === 'length')) {
      throw new ProviderError('RESPONSE_PARSE_ERROR');
    }
    // HTTP 200 can still contain truncated/filtered text or a pending tool call.
    // Legacy compatible servers may omit finish_reason; keep that contract.
    if ('finish_reason' in choice && choice.finish_reason !== 'stop'
      && !(connectionCheck && choice.finish_reason === 'length')) throw new ProviderError('EXECUTION_FAILED');
    // Defense against a misconfigured endpoint that echoes the authorization value.
    return { output: choice.message.content.split(apiKey).join('[REDACTED]') };
  }
}
