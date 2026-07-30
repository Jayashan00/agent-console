import webSearch from './webSearch.js';
import fetchUrl from './fetchUrl.js';
import { readFile, writeFile } from './files.js';
import runJavascript from './runJavascript.js';
import getWeather from './weather.js';
import { ToolError, validateInput, withTimeout } from './toolkit.js';
import { config } from '../config.js';

export const TOOLS = [webSearch, fetchUrl, writeFile, readFile, runJavascript, getWeather];

export const toolRegistry = new Map(TOOLS.map((tool) => [tool.name, tool]));

export const getTool = (name) => toolRegistry.get(name) ?? null;

/** The tool catalogue the UI renders and the model is prompted with. */
export const toolCatalogue = () =>
  TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    category: tool.category,
    description: tool.description,
    returns: tool.returns,
    parameters: Object.entries(tool.parameters).map(([name, spec]) => ({
      name,
      type: spec.type,
      required: Boolean(spec.required),
      default: spec.default,
      enum: spec.enum,
      description: spec.description,
    })),
  }));

/** Compact, typed spec injected into the system prompt. */
export function toolsPromptSpec() {
  return TOOLS.map((tool) => {
    const params = Object.entries(tool.parameters)
      .map(([name, spec]) => {
        const bits = [`${name}: ${spec.type}`];
        if (!spec.required) bits.push(`optional, default ${JSON.stringify(spec.default)}`);
        if (spec.enum) bits.push(`one of ${spec.enum.join('|')}`);
        return `    - ${bits.join(', ')} — ${spec.description}`;
      })
      .join('\n');
    return `- ${tool.name}: ${tool.description}\n  parameters:\n${params}\n  returns: ${tool.returns}`;
  }).join('\n');
}

/**
 * Runs a tool and *always* resolves. A failing tool produces a structured
 * error the agent can read and react to; it never rejects up into the run loop,
 * because one bad tool call must not end a run the user is watching.
 */
export async function executeTool(name, rawInput, ctx) {
  const tool = getTool(name);
  const startedAt = Date.now();
  if (!tool) {
    return {
      ok: false,
      durationMs: 0,
      error: {
        kind: 'unknown_tool',
        message: `There is no tool named "${name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`,
        retriable: true,
      },
    };
  }

  let input;
  try {
    input = validateInput(tool, rawInput);
  } catch (err) {
    return {
      ok: false,
      tool: tool.name,
      input: rawInput,
      durationMs: Date.now() - startedAt,
      error: { kind: err.kind ?? 'invalid_input', message: err.message, retriable: true },
    };
  }

  try {
    const output = await withTimeout(
      Promise.resolve(tool.run(input, { ...ctx, timeoutMs: tool.timeoutMs ?? config.toolTimeoutMs })),
      (tool.timeoutMs ?? config.toolTimeoutMs) + 2000,
      tool.name,
    );
    return { ok: true, tool: tool.name, input, signature: tool.signature(input), output, durationMs: Date.now() - startedAt };
  } catch (err) {
    const isToolError = err instanceof ToolError;
    return {
      ok: false,
      tool: tool.name,
      input,
      signature: tool.signature(input),
      durationMs: Date.now() - startedAt,
      error: {
        kind: isToolError ? err.kind : 'unexpected_error',
        message: err.message || 'The tool failed without a message.',
        retriable: isToolError ? err.retriable : true,
        detail: isToolError ? err.detail : undefined,
      },
    };
  }
}
