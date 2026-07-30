import { config, hasLlm } from '../config.js';

/**
 * A hand-written streaming client for the Anthropic Messages API.
 *
 * No SDK: the assignment bans agent frameworks, and building the transport by
 * hand is also what lets the run loop react to the very first token — the
 * caller gets an `onDelta` callback per chunk, which is the top of the pipe
 * that ends at the browser.
 */

export class LlmError extends Error {
  constructor(message, { status = 0, retriable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retriable = retriable;
  }
}

export async function streamCompletion({ system, messages, onDelta, maxTokens, signal, temperature = 0.2 }) {
  if (!hasLlm()) throw new LlmError('ANTHROPIC_API_KEY is not set.', { retriable: false });

  const res = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens ?? config.maxTokens,
      temperature,
      system,
      stream: true,
      messages,
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new LlmError(
      `Model request failed (HTTP ${res.status}). ${detail.slice(0, 400)}`,
      { status: res.status, retriable: res.status === 429 || res.status >= 500 },
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          full += parsed.delta.text;
          onDelta?.(parsed.delta.text);
        } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
          stopReason = parsed.delta.stop_reason;
        } else if (parsed.type === 'error') {
          throw new LlmError(parsed.error?.message ?? 'The model stream returned an error.', { retriable: true });
        }
      }
    }
  }

  return { text: full, stopReason };
}
