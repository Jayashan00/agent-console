import { streamCompletion } from '../lib/llm.js';
import { TagStreamParser, parseLooseJson } from '../lib/tagStream.js';
import { contextBlock, planningPrompt, stepPrompt, finalPrompt } from './prompts.js';
import { config } from '../config.js';

/**
 * The LLM engine. Every model call streams through TagStreamParser, so
 * `<thinking>` text reaches the browser token by token while the same response
 * is still producing the `<action>` JSON that decides what happens next.
 */
export const llmEngine = {
  name: 'llm',
  label: `Claude (${config.model})`,

  async plan(ctx) {
    let planJson = null;
    const parser = new TagStreamParser(['thinking', 'plan'], {
      onDelta: (tag, delta) => {
        if (tag === 'thinking') ctx.emitText('planning', delta);
      },
      onClose: (tag, text) => {
        if (tag === 'plan') planJson = parseLooseJson(text);
      },
    });

    await streamCompletion({
      system: planningPrompt(),
      messages: [{ role: 'user', content: `GOAL\n${ctx.goal}\n\nProduce your reasoning and then the plan.` }],
      onDelta: (delta) => parser.push(delta),
      signal: ctx.signal,
      maxTokens: 1200,
    });
    parser.end();

    const steps = Array.isArray(planJson) ? planJson : planJson?.steps;
    if (!Array.isArray(steps) || !steps.length) {
      throw new Error('The model did not return a usable plan.');
    }
    return steps.slice(0, config.maxSteps).map((step) => ({
      title: String(step.title ?? 'Untitled step').slice(0, 140),
      detail: String(step.detail ?? '').slice(0, 400),
      tool: step.tool && step.tool !== 'null' ? String(step.tool) : null,
    }));
  },

  async decide(ctx) {
    let decision = null;
    const parser = new TagStreamParser(['thinking', 'action', 'complete', 'replan'], {
      onDelta: (tag, delta) => {
        if (tag === 'thinking') ctx.emitText('reasoning', delta);
      },
      onClose: (tag, text) => {
        if (decision) return;
        if (tag === 'action') {
          const parsed = parseLooseJson(text);
          if (parsed?.tool) decision = { type: 'action', tool: String(parsed.tool), input: parsed.input ?? parsed.arguments ?? {} };
        } else if (tag === 'complete') {
          decision = { type: 'complete', summary: text.trim() };
        } else if (tag === 'replan') {
          const parsed = parseLooseJson(text);
          if (Array.isArray(parsed?.steps) && parsed.steps.length) {
            decision = {
              type: 'replan',
              reason: String(parsed.reason ?? 'The agent revised its approach.'),
              steps: parsed.steps.slice(0, config.maxSteps).map((s) => ({
                title: String(s.title ?? 'Untitled step').slice(0, 140),
                detail: String(s.detail ?? '').slice(0, 400),
                tool: s.tool && s.tool !== 'null' ? String(s.tool) : null,
              })),
            };
          }
        }
      },
    });

    await streamCompletion({
      system: stepPrompt(),
      messages: [{ role: 'user', content: contextBlock(ctx) }],
      onDelta: (delta) => parser.push(delta),
      signal: ctx.signal,
      maxTokens: 1400,
    });
    parser.end();

    // A turn with reasoning but no valid decision is treated as "step done"
    // rather than crashing the run the user is watching.
    return decision ?? { type: 'complete', summary: 'Step finished without a further tool call.' };
  },

  async finalize(ctx) {
    let markdown = '';
    const parser = new TagStreamParser(['thinking', 'final'], {
      onDelta: (tag, delta) => {
        if (tag === 'final') {
          markdown += delta;
          ctx.emitText('deliverable', delta);
        }
      },
    });

    await streamCompletion({
      system: finalPrompt(),
      messages: [{ role: 'user', content: `${contextBlock(ctx)}\n\nWrite the final deliverable now.` }],
      onDelta: (delta) => parser.push(delta),
      signal: ctx.signal,
      maxTokens: 2000,
      temperature: 0.3,
    });
    parser.end();

    return markdown.trim();
  },
};
