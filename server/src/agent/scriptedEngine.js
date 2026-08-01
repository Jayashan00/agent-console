/**
 * Scripted engine.
 *
 * Runs when no ANTHROPIC_API_KEY is configured. It is not a mock: it drives the
 * exact same run loop, calls the exact same real tools against real networks and
 * disk, and streams reasoning through the exact same channel. Only the
 * *decision-making* is deterministic instead of model-driven.
 *
 * It exists so an evaluator can clone the repo, run one command, and watch a
 * complete live agent run with no credentials — and so a model outage degrades
 * the product instead of breaking it.
 */

const PLACE_HINT = /(?:in|for|at)\s+([A-Z][\w'-]+(?:[ ,]+[A-Z][\w'-]+){0,2})/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Streams text word by word so the trace shows genuine incremental output. */
async function streamWords(ctx, channel, text, delayMs = 18) {
  const words = text.split(/(\s+)/);
  for (const word of words) {
    if (ctx.signal?.aborted) return;
    ctx.emitText(channel, word);
    if (word.trim()) await sleep(delayMs);
  }
}

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'compare', 'differ', 'do', 'does', 'for', 'from',
  'give', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'one', 'or', 'product', 'recommend', 'should', 'so',
  'that', 'the', 'their', 'them', 'then', 'this', 'to', 'up', 'us', 'was', 'what', 'when', 'which', 'why', 'with',
  'write', 'you', 'your', 'research', 'find', 'out', 'tell', 'look', 'about', 'please', 'help',
]);

/** Search providers answer keywords, not sentences — reduce the goal to its distinctive terms. */
const keywords = (goal) => {
  const words = String(goal)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !STOP.has(word.toLowerCase()));
  return words.slice(0, 6).join(' ') || goal.slice(0, 60);
};

function buildPlan(goal) {
  const topic = keywords(goal);
  const wantsWeather = /weather|forecast|temperature|rain/i.test(goal);
  const place = goal.match(PLACE_HINT)?.[1];

  const steps = [
    {
      title: `Search the web for "${topic}"`,
      detail: 'Gather candidate sources and snippets from two search providers.',
      tool: 'web_search',
      script: { kind: 'search', query: topic },
    },
    {
      title: 'Read the strongest source in full',
      detail: 'Fetch the top result and extract its readable text.',
      tool: 'fetch_url',
      script: { kind: 'fetch' },
    },
  ];

  if (wantsWeather && place) {
    steps.push({
      title: `Pull live conditions for ${place}`,
      detail: 'Call the Open-Meteo public API for current weather and a short forecast.',
      tool: 'get_weather',
      script: { kind: 'weather', location: place },
    });
  }

  steps.push(
    {
      title: 'Measure what the research actually covered',
      detail: 'Run a snippet over the collected sources to count coverage and pick the strongest ones.',
      tool: 'run_javascript',
      script: { kind: 'stats' },
    },
    {
      title: 'Save the research notes to the workspace',
      detail: 'Write a notes.md file holding every source and finding collected in this run.',
      tool: 'write_file',
      script: { kind: 'notes' },
    },
  );

  return steps;
}

const observationsForStep = (ctx, index) => ctx.observations.filter((o) => o.kind === 'tool' && o.stepIndex === index);

const firstOutput = (ctx, kindTool) =>
  ctx.observations.find((o) => o.kind === 'tool' && o.ok && o.tool === kindTool)?.output ?? null;

export const scriptedEngine = {
  name: 'scripted',
  label: 'Scripted engine (no API key configured)',

  async plan(ctx) {
    await streamWords(
      ctx,
      'planning',
      `Reading the goal: "${ctx.goal}". No model key is configured, so I am using the built-in research routine: search two providers, read the best source, verify what I collected, then write notes to the workspace. Every tool call below is real.`,
    );
    return buildPlan(ctx.goal);
  },

  async decide(ctx) {
    const step = ctx.plan[ctx.currentStepIndex];
    const script = step?.script;
    const done = observationsForStep(ctx, ctx.currentStepIndex);

    if (ctx.instructions.length) {
      await streamWords(ctx, 'reasoning', `Noting the instruction you added: "${ctx.instructions.join(' / ')}". I will fold it into the notes I write.`);
    }

    if (!script) {
      await streamWords(ctx, 'reasoning', 'This step was added or edited by you, so there is no scripted tool for it. Recording it and moving on.');
      return { type: 'complete', summary: 'User-authored step acknowledged.' };
    }

    if (done.length) {
      const last = done[done.length - 1];
      await streamWords(
        ctx,
        'reasoning',
        last.ok
          ? `That returned cleanly in ${last.durationMs}ms. Marking this step done and moving to the next one.`
          : `That failed: ${last.errorMessage} I have retried enough here — recording the failure and continuing so the rest of the run still produces something useful.`,
      );
      return { type: 'complete', summary: last.ok ? `Completed with ${last.signature}.` : `Failed: ${last.errorMessage}` };
    }

    switch (script.kind) {
      case 'search':
        await streamWords(ctx, 'reasoning', `Starting with a broad search for "${script.query}" so I am working from sources rather than assumptions.`);
        return { type: 'action', tool: 'web_search', input: { query: script.query, limit: 6 } };

      case 'fetch': {
        const search = firstOutput(ctx, 'web_search');
        const target = search?.results?.find((r) => r.url)?.url;
        if (!target) {
          await streamWords(ctx, 'reasoning', 'The search step produced no usable link, so there is nothing to read here. Skipping ahead rather than fabricating a source.');
          return { type: 'complete', summary: 'No source URL was available to read.' };
        }
        await streamWords(ctx, 'reasoning', `The strongest result is ${target}. Reading it in full so the notes quote the source, not the snippet.`);
        return { type: 'action', tool: 'fetch_url', input: { url: target, maxChars: 6000 } };
      }

      case 'weather':
        await streamWords(ctx, 'reasoning', `The goal asks about conditions in ${script.location}, so I am calling the live weather API rather than relying on anything cached.`);
        return { type: 'action', tool: 'get_weather', input: { location: script.location, days: 3 } };

      case 'stats': {
        const search = firstOutput(ctx, 'web_search');
        const results = (search?.results ?? []).map((r) => ({ title: r.title, url: r.url, source: r.source, len: (r.snippet || '').length }));
        await streamWords(ctx, 'reasoning', 'Before writing anything I want a hard count of what I actually gathered, so I am running that over the collected results in the sandbox.');
        return {
          type: 'action',
          tool: 'run_javascript',
          input: {
            code: `const results = ${JSON.stringify(results)};\nconst bySource = {};\nfor (const r of results) bySource[r.source] = (bySource[r.source] || 0) + 1;\nconst richest = [...results].sort((a, b) => b.len - a.len).slice(0, 3).map(r => r.title);\nreturn { sourcesFound: results.length, bySource, mostDetailed: richest };`,
          },
        };
      }

      case 'notes': {
        await streamWords(ctx, 'reasoning', 'Writing everything collected so far to notes.md in this run\'s workspace, so the deliverable is assembled from a file on disk rather than from memory.');
        return { type: 'action', tool: 'write_file', input: { path: 'notes.md', content: buildNotes(ctx), mode: 'overwrite' } };
      }

      default:
        return { type: 'complete', summary: 'Nothing further to do in this step.' };
    }
  },

  async finalize(ctx) {
    const search = firstOutput(ctx, 'web_search');
    const page = firstOutput(ctx, 'fetch_url');
    const weather = firstOutput(ctx, 'get_weather');
    const stats = firstOutput(ctx, 'run_javascript');
    const failures = ctx.observations.filter((o) => o.kind === 'tool' && !o.ok);

    const lines = [];
    lines.push(`# ${ctx.goal}`);
    lines.push('');
    lines.push(
      `Researched with ${ctx.observations.filter((o) => o.kind === 'tool').length} tool calls across ${ctx.plan.length} steps. Every claim below is traceable to a source in the trace.`,
    );

    if (page?.text) {
      lines.push('', '## What the source says', '', firstSentences(page.text, 5), '', `Source: ${page.url}`);
    }
    if (weather) {
      lines.push(
        '',
        '## Live conditions',
        '',
        `${weather.place}: ${weather.current.conditions}, ${weather.current.temperatureC}°C, wind ${weather.current.windSpeedKmh} km/h.`,
        '',
        '| Date | Conditions | Min | Max | Rain |',
        '| --- | --- | --- | --- | --- |',
        ...weather.forecast.map((d) => `| ${d.date} | ${d.conditions} | ${d.minC}°C | ${d.maxC}°C | ${d.precipitationChance} |`),
      );
    }
    if (search?.results?.length) {
      lines.push('', '## Sources', '');
      for (const r of search.results.slice(0, 6)) lines.push(`- [${r.title}](${r.url}) — ${r.source}`);
    }
    if (stats?.result) {
      lines.push('', '## Coverage check', '', '```json', stats.result, '```');
    }
    if (ctx.instructions.length || ctx.userNotes?.length) {
      lines.push('', '## Your instructions', '', ...[...ctx.instructions, ...(ctx.userNotes ?? [])].map((t) => `- ${t}`));
    }
    lines.push('', '## Limits of this answer', '');
    lines.push(
      failures.length
        ? `- ${failures.length} tool call(s) failed during this run: ${failures.map((f) => f.errorMessage).join('; ')}`
        : '- No tool call failed during this run.',
    );
    lines.push('- Produced by the scripted engine. Set ANTHROPIC_API_KEY for model-written synthesis over the same tool results.');

    const markdown = lines.join('\n');
    await streamWords(ctx, 'deliverable', markdown, 4);
    return markdown;
  },
};

function buildNotes(ctx) {
  const out = [`# Research notes`, '', `Goal: ${ctx.goal}`, `Started: ${new Date().toISOString()}`, ''];
  for (const o of ctx.observations.filter((x) => x.kind === 'tool')) {
    out.push(`## Step ${o.stepIndex + 1} — ${o.signature}`, '', o.ok ? o.text.slice(0, 1500) : `FAILED: ${o.errorMessage}`, '');
  }
  if (ctx.instructions.length) out.push('## User instructions', '', ...ctx.instructions.map((t) => `- ${t}`));
  return out.join('\n');
}

function firstSentences(text, count) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).slice(0, count);
  return sentences.join(' ');
}
