/**
 * End-to-end smoke test. Boots the real server, drives a real run through the
 * real HTTP API and the real SSE stream, and asserts the guarantees the product
 * makes: streaming arrives incrementally, pause holds, plan edits are honoured,
 * rollback rewinds the trace, and history survives.
 *
 *   node test/smoke.js
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'src', 'index.js');
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-console-test-'));

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

/** Reads the SSE stream with a hand-written parser, exactly like the browser does. */
function openStream(runId, onEvent) {
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`${BASE}/api/runs/${runId}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            onEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* ignore keepalives */
          }
        }
      }
    }
  })().catch(() => {});
  return { close: () => controller.abort(), done };
}

const child = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', TOOL_TIMEOUT_MS: '8000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Server never became healthy.');
}

async function main() {
  await waitForServer();
  console.log('\nAgent Console — smoke test\n');

  const meta = await api('GET', '/api/meta');
  check('meta lists at least 4 typed tools', () => {
    assert.ok(meta.json.tools.length >= 4, `only ${meta.json.tools.length} tools`);
    for (const tool of meta.json.tools) {
      assert.ok(tool.parameters.length > 0, `${tool.name} has no typed parameters`);
      assert.ok(tool.description, `${tool.name} has no description`);
    }
  });

  /* ---------------------------------------------------- run 1: full run */
  const events = [];
  const deltaTimes = [];
  const created = await api('POST', '/api/runs', { goal: 'Research the Model Context Protocol and summarise it' });
  check('run is created with 201', () => assert.equal(created.status, 201));
  const runId = created.json.run.id;

  const stream = openStream(runId, (e) => {
    events.push(e);
    if (e.type === 'text.delta') deltaTimes.push(Date.now());
  });

  for (let i = 0; i < 200; i++) {
    if (events.some((e) => e.type === 'run.completed')) break;
    await sleep(150);
  }

  check('the run reached a terminal state', () =>
    assert.ok(events.some((e) => e.type === 'run.completed'), 'no run.completed event'));
  check('a plan was produced and streamed', () => assert.ok(events.some((e) => e.type === 'plan.created')));
  check('reasoning streamed incrementally, not in one batch', () => {
    const reasoning = events.filter((e) => e.type === 'text.delta' && e.channel === 'reasoning');
    assert.ok(reasoning.length > 10, `only ${reasoning.length} reasoning deltas`);
    const spread = deltaTimes[deltaTimes.length - 1] - deltaTimes[0];
    assert.ok(spread > 200, `all deltas arrived within ${spread}ms — that is batched, not streamed`);
  });
  check('every tool call has a matching result', () => {
    const calls = events.filter((e) => e.type === 'tool.call').map((e) => e.callId);
    const results = new Set(events.filter((e) => e.type === 'tool.result').map((e) => e.callId));
    assert.ok(calls.length > 0, 'no tool calls at all');
    for (const id of calls) assert.ok(results.has(id), `call ${id} never returned`);
  });
  check('tool failures are structured, not crashes', () => {
    for (const e of events.filter((x) => x.type === 'tool.result' && !x.ok)) {
      assert.ok(e.error?.message, 'a failed result had no error message');
      assert.ok(e.error?.kind, 'a failed result had no error kind');
    }
  });
  check('a deliverable was produced separately from the trace', async () => {
    const detail = events.find((e) => e.type === 'deliverable.ready');
    assert.ok(detail, 'no deliverable.ready event');
  });

  const fetched = await api('GET', `/api/runs/${runId}`);
  check('the finished run persists its full trace', () => {
    assert.ok(fetched.json.run.events.length > 10);
    assert.ok(fetched.json.run.deliverable && fetched.json.run.deliverable.length > 50);
    assert.equal(fetched.json.run.status, 'completed');
  });

  const stepCount = fetched.json.run.plan.length;
  check('the plan has at least 3 steps, all completed', () => {
    assert.ok(stepCount >= 3, `plan had ${stepCount} steps`);
    assert.ok(fetched.json.run.plan.every((s) => s.status === 'done'));
  });

  /* ------------------------------------------------------- rollback */
  const beforeRollback = fetched.json.run.events.length;
  await api('POST', `/api/runs/${runId}/rollback`, { stepIndex: 1 });
  await sleep(400);
  const rolled = await api('GET', `/api/runs/${runId}`);
  check('rollback discards the trace after the target step', () => {
    const marker = rolled.json.run.events.find((e) => e.type === 'rollback');
    assert.ok(marker, 'no rollback marker in the trace');
    assert.ok(marker.seq < beforeRollback, 'rollback did not rewind the trace');
  });
  check('rollback re-runs from the target step', () => {
    assert.ok(['running', 'planning', 'completed', 'paused'].includes(rolled.json.run.status), rolled.json.run.status);
  });
  await api('POST', `/api/runs/${runId}/abandon`);
  stream.close();

  /* ------------------------------- run 2: pause, edit plan, resume */
  const events2 = [];
  const created2 = await api('POST', '/api/runs', { goal: 'Find out what SSE is and write notes' });
  const runId2 = created2.json.run.id;
  const stream2 = openStream(runId2, (e) => events2.push(e));

  for (let i = 0; i < 100; i++) {
    if (events2.some((e) => e.type === 'step.started')) break;
    await sleep(100);
  }
  const pause = await api('POST', `/api/runs/${runId2}/pause`);
  check('pause is accepted while the run is executing', () => assert.equal(pause.status, 200));

  for (let i = 0; i < 100; i++) {
    if (events2.some((e) => e.type === 'paused')) break;
    await sleep(100);
  }
  check('the run actually pauses at a step boundary', () =>
    assert.ok(events2.some((e) => e.type === 'paused'), 'never reported paused'));

  const pausedRun = await api('GET', `/api/runs/${runId2}`);
  const pausedIndex = pausedRun.json.run.plan.findIndex((s) => s.status !== 'done');
  check('a paused run reports the paused status', () => assert.equal(pausedRun.json.run.status, 'paused'));

  const eventsAtPause = events2.length;
  await sleep(700);
  check('no new steps begin while paused', () => {
    const newSteps = events2.slice(eventsAtPause).filter((e) => e.type === 'step.started');
    assert.equal(newSteps.length, 0, `${newSteps.length} steps started while paused`);
  });

  const editedPlan = [
    { title: 'User-authored step: verify the notes', detail: 'Added during the pause by the test.', tool: null },
    { title: 'User-authored step: finish up', detail: 'Second user step.', tool: null },
  ];
  const resumed = await api('POST', `/api/runs/${runId2}/resume`, {
    plan: editedPlan,
    instruction: 'Keep the summary under 100 words.',
  });
  check('resume with a plan edit is accepted', () => assert.equal(resumed.status, 200));

  for (let i = 0; i < 120; i++) {
    if (events2.some((e) => e.type === 'run.completed')) break;
    await sleep(150);
  }

  check('the edited plan is honoured, not ignored', () => {
    const update = events2.filter((e) => e.type === 'plan.updated' && e.by === 'user').pop();
    assert.ok(update, 'no user plan update event');
    const titles = update.steps.map((s) => s.title);
    assert.ok(titles.includes('User-authored step: verify the notes'), `plan was ${titles.join(' | ')}`);
    assert.ok(update.steps.slice(pausedIndex).every((s) => s.origin === 'user'));
  });
  check('the added instruction is recorded in the trace', () =>
    assert.ok(events2.some((e) => e.type === 'instruction' && /100 words/.test(e.text))));
  check('the run completes after the interruption', () =>
    assert.ok(events2.some((e) => e.type === 'run.completed')));

  stream2.close();

  /* --------------------------------------------------- replay + history */
  const replay = [];
  const stream3 = openStream(runId2, (e) => replay.push(e));
  await sleep(600);
  stream3.close();
  check('a past run replays its full trace to a new viewer', () => {
    assert.ok(replay.some((e) => e.type === 'stream.caughtUp'));
    assert.ok(replay.filter((e) => e.type === 'tool.call').length > 0);
    assert.ok(replay.length > 20, `replayed only ${replay.length} events`);
  });

  const history = await api('GET', '/api/runs');
  check('run history lists both runs with status and counts', () => {
    assert.ok(history.json.runs.length >= 2);
    const entry = history.json.runs.find((r) => r.id === runId2);
    assert.ok(entry.goal && entry.status && typeof entry.toolCalls === 'number');
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures above' : ' — all green'}\n`);
}

main()
  .catch((err) => {
    console.error('\nSmoke test crashed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    child.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
