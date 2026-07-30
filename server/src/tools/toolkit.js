import { config } from '../config.js';

/**
 * Every tool in this product is declared with an explicit typed parameter
 * schema. The schema does three jobs at once:
 *   1. it is compiled into the prompt the model sees,
 *   2. it validates and coerces the model's arguments before anything runs,
 *   3. it renders the parameter table the user sees in the trace.
 * One declaration, so the three can never drift apart.
 */

export class ToolError extends Error {
  constructor(message, { kind = 'tool_error', retriable = false, detail = null } = {}) {
    super(message);
    this.name = 'ToolError';
    this.kind = kind;
    this.retriable = retriable;
    this.detail = detail;
  }
}

export const inputError = (message, detail) =>
  new ToolError(message, { kind: 'invalid_input', retriable: true, detail });

function coerce(name, spec, raw) {
  const label = `"${name}"`;
  if (raw === undefined || raw === null || raw === '') {
    if (spec.required) throw inputError(`Missing required parameter ${label}.`);
    return spec.default;
  }
  switch (spec.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw inputError(`Parameter ${label} must be a number, received ${JSON.stringify(raw)}.`);
      if (spec.min !== undefined && n < spec.min) throw inputError(`Parameter ${label} must be >= ${spec.min}.`);
      if (spec.max !== undefined && n > spec.max) throw inputError(`Parameter ${label} must be <= ${spec.max}.`);
      return n;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (['true', 'yes', '1'].includes(String(raw).toLowerCase())) return true;
      if (['false', 'no', '0'].includes(String(raw).toLowerCase())) return false;
      throw inputError(`Parameter ${label} must be true or false.`);
    case 'string': {
      const s = typeof raw === 'string' ? raw : String(raw);
      if (spec.enum && !spec.enum.includes(s)) {
        throw inputError(`Parameter ${label} must be one of: ${spec.enum.join(', ')}.`);
      }
      if (spec.maxLength && s.length > spec.maxLength) return s.slice(0, spec.maxLength);
      return s;
    }
    default:
      return raw;
  }
}

export function validateInput(tool, rawInput) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const known = Object.keys(tool.parameters);
  const unknown = Object.keys(input).filter((k) => !known.includes(k));
  if (unknown.length) {
    throw inputError(
      `Unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `"${u}"`).join(', ')} for ${tool.name}. Accepted: ${known.join(', ')}.`,
    );
  }
  const out = {};
  for (const [name, spec] of Object.entries(tool.parameters)) {
    const value = coerce(name, spec, input[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export function defineTool(definition) {
  return {
    timeoutMs: config.toolTimeoutMs,
    ...definition,
    /** Human-readable one-liner shown on the trace card header. */
    signature(input) {
      if (definition.signature) return definition.signature(input);
      const first = Object.keys(definition.parameters)[0];
      const value = input?.[first];
      return `${definition.name}(${value === undefined ? '' : JSON.stringify(String(value)).slice(0, 60)})`;
    },
  };
}

/** Wraps a promise with a real timeout so a hung tool can never hang the run. */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolError(`${label} timed out after ${ms}ms.`, { kind: 'timeout', retriable: true })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function truncate(text, limit, note = '…[truncated]') {
  const s = String(text ?? '');
  return s.length <= limit ? s : s.slice(0, limit) + note;
}

/** Strips tags, scripts and entity noise from an HTML document. */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function httpGet(url, { headers = {}, timeoutMs = config.toolTimeoutMs, progress } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    progress?.(`Requesting ${new URL(url).host}`);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'HevaAgentConsole/1.0 (+assignment demo)',
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });
    if (!res.ok) {
      throw new ToolError(`HTTP ${res.status} ${res.statusText} from ${new URL(url).host}.`, {
        kind: 'http_error',
        retriable: res.status >= 500 || res.status === 429,
        detail: { status: res.status, url },
      });
    }
    progress?.(`Reading response from ${new URL(url).host}`);
    const body = await res.text();
    return { body, status: res.status, contentType: res.headers.get('content-type') || '', finalUrl: res.url || url };
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (err.name === 'AbortError') {
      throw new ToolError(`Request to ${url} timed out after ${timeoutMs}ms.`, { kind: 'timeout', retriable: true });
    }
    throw new ToolError(`Network request to ${url} failed: ${err.message}`, {
      kind: 'network_error',
      retriable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}
