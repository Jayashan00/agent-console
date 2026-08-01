import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

/**
 * Minimal .env loader. Avoids a dotenv dependency and keeps startup transparent:
 * real environment variables always win over the file.
 */
function loadEnvFile() {
  for (const candidate of [path.join(ROOT, '.env'), path.join(ROOT, 'server', '.env')]) {
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadEnvFile();

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Provider selection.
 *
 * Anthropic is the default when a key is present. Any OpenAI-compatible
 * endpoint works as an alternative — Groq, Google AI Studio, Cerebras,
 * OpenRouter and most others speak that dialect — so the product can be run
 * with a free, no-credit-card key. The agent loop, the tools and the streaming
 * pipeline are identical either way; only the transport differs.
 */
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const provider =
  process.env.LLM_PROVIDER || (anthropicApiKey ? 'anthropic' : openaiApiKey ? 'openai' : 'none');

const defaultModel = provider === 'anthropic' ? 'claude-sonnet-4-5' : 'llama-3.3-70b-versatile';

export const config = {
  port: int(process.env.PORT, 8787),
  host: process.env.HOST || '0.0.0.0',

  provider,
  anthropicApiKey,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  openaiApiKey,
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1',
  model: process.env.AGENT_MODEL || defaultModel,
  maxTokens: int(process.env.AGENT_MAX_TOKENS, 1400),

  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  workspaceDir: process.env.WORKSPACE_DIR || path.join(ROOT, 'data', 'workspace'),
  webDist: process.env.WEB_DIST || path.join(ROOT, 'web', 'dist'),

  maxSteps: int(process.env.AGENT_MAX_STEPS, 12),
  maxToolCallsPerStep: int(process.env.AGENT_MAX_TOOL_CALLS_PER_STEP, 3),
  toolTimeoutMs: int(process.env.TOOL_TIMEOUT_MS, 20000),
  runRetentionDays: int(process.env.RUN_RETENTION_DAYS, 60),
};

export const hasLlm = () =>
  config.provider === 'anthropic' ? Boolean(config.anthropicApiKey) : config.provider === 'openai' ? Boolean(config.openaiApiKey) : false;

export const engineName = () => (hasLlm() ? 'llm' : 'scripted');

export const providerLabel = () =>
  config.provider === 'anthropic' ? 'Anthropic' : config.provider === 'openai' ? new URL(config.openaiBaseUrl).host : 'none';
