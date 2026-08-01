import { config, hasLlm, providerLabel } from '../config.js';

/**
 * A hand-written streaming client for the Anthropic Messages API.
 *
 * No SDK: the assignment bans agent frameworks, and building the transport by
 * hand is also what lets the run loop react to the very first token — the
 * caller gets an `onDelta` callback per chunk, which is the top of the pipe
 * that ends at the browser.
 */

export class LlmError extends Error {
  constructor(message, { status = 0, retriable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retriable = retriable;
    /** Honour the provider's own Retry-After when it sends one. */
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a rate-limited or transient model failure before the run degrades.
 *
 * The important subtlety: a retry is only safe if nothing has been streamed to
 * the user yet. Once a single token has reached the browser, re-running the
 * call would duplicate reasoning mid-sentence, so a mid-stream failure is
 * surfaced immediately instead. Free provider tiers rate-limit constantly, and
 * an honest short pause is far better than degrading a run that would have
 * succeeded two seconds later.
 */
export async function streamCompletion(options) {
  if (!hasLlm()) throw new LlmError('No model key is configured.', { retriable: false });
  const call = config.provider === 'openai' ? streamOpenAiCompatible : streamAnthropic;

  let lastError;
  for (let attempt = 0; attempt <= config.llmMaxRetries; attempt++) {
    let streamed = false;
    try {
      return await call({
        ...options,
        onDelta: (delta) => {
          streamed = true;
          options.onDelta?.(delta);
        },
      });
    } catch (err) {
      lastError = err;
      const canRetry =
        err instanceof LlmError &&
        err.retriable &&
        !streamed &&
        !options.signal?.aborted &&
        attempt < config.llmMaxRetries;
      if (!canRetry) throw err;

      const wait = Math.min(err.retryAfterMs ?? 800 * 2 ** attempt, config.llmRetryCapMs);
      options.onRetry?.({ attempt: attempt + 1, waitMs: wait, reason: err.message });
      await sleep(wait);
    }
  }
  throw lastError;
}

/**
 * Reads an SSE body line by line and hands each parsed `data:` payload to
 * `onPayload`. Shared by both providers — they differ in their JSON shape, not
 * in their framing.
 */
async function readSse(res, onPayload) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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
        try {
          onPayload(JSON.parse(payload));
        } catch {
          /* a keepalive or partial frame — never crash the stream on one */
        }
      }
    }
  }
}

async function failure(res, label) {
  const detail = await res.text().catch(() => '');
  const header = res.headers.get('retry-after');
  const seconds = header ? Number.parseFloat(header) : NaN;
  return new LlmError(`${label} request failed (HTTP ${res.status}). ${detail.slice(0, 400)}`, {
    status: res.status,
    retriable: res.status === 429 || res.status >= 500,
    retryAfterMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
  });
}

async function streamAnthropic({ system, messages, onDelta, maxTokens, signal, temperature }) {
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

  if (!res.ok || !res.body) throw await failure(res, 'Anthropic');

  let full = '';
  let stopReason = null;
  let streamError = null;

  await readSse(res, (parsed) => {
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      full += parsed.delta.text;
      onDelta?.(parsed.delta.text);
    } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
      stopReason = parsed.delta.stop_reason;
    } else if (parsed.type === 'error') {
      streamError = parsed.error?.message ?? 'The model stream returned an error.';
    }
  });

  if (streamError) throw new LlmError(streamError, { retriable: true });
  return { text: full, stopReason };
}

/**
 * Any OpenAI-compatible endpoint: Groq, Google AI Studio, Cerebras, OpenRouter,
 * a local Ollama, or OpenAI itself. The system prompt becomes the first message
 * rather than a top-level field — the only structural difference that matters.
 */
async function streamOpenAiCompatible({ system, messages, onDelta, maxTokens, signal, temperature }) {
  const res = await fetch(`${config.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens ?? config.maxTokens,
      temperature,
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });

  if (!res.ok || !res.body) throw await failure(res, providerLabel());

  let full = '';
  let stopReason = null;
  let streamError = null;

  await readSse(res, (parsed) => {
    if (parsed.error) {
      streamError = parsed.error.message ?? 'The model stream returned an error.';
      return;
    }
    const choice = parsed.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) {
      full += delta;
      onDelta?.(delta);
    }
    if (choice?.finish_reason) stopReason = choice.finish_reason;
  });

  if (streamError) throw new LlmError(streamError, { retriable: true });
  return { text: full, stopReason };
}
