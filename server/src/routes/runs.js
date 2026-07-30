import express from 'express';
import * as store from '../lib/store.js';
import { subscribe } from '../lib/bus.js';
import { getController } from '../agent/controller.js';
import { pickEngineName, resumeRun, rollbackRun, startRun } from '../agent/runner.js';
import { toolCatalogue } from '../tools/index.js';
import { config, engineName, hasLlm } from '../config.js';

export const router = express.Router();

const bad = (res, code, message) => res.status(code).json({ error: message });

const withControl = (run) => ({
  ...run,
  control: {
    canPause: ['running', 'planning'].includes(run.status),
    canResume: run.status === 'paused',
    canAbandon: ['running', 'planning', 'paused'].includes(run.status),
    canRollback: run.plan.some((s) => s.status === 'done'),
    isLive: ['running', 'planning', 'paused'].includes(run.status),
  },
});

router.get('/meta', (_req, res) => {
  res.json({
    engine: engineName(),
    model: hasLlm() ? config.model : null,
    modelConfigured: hasLlm(),
    tools: toolCatalogue(),
    limits: {
      maxSteps: config.maxSteps,
      maxToolCallsPerStep: config.maxToolCallsPerStep,
      toolTimeoutMs: config.toolTimeoutMs,
    },
  });
});

router.get('/runs', (req, res) => {
  res.json({ runs: store.listRuns({ limit: Number(req.query.limit) || 100 }) });
});

router.post('/runs', (req, res) => {
  const goal = String(req.body?.goal ?? '').trim();
  if (!goal) return bad(res, 400, 'A goal is required.');
  if (goal.length > 2000) return bad(res, 400, 'That goal is too long — keep it under 2000 characters.');

  const run = store.createRun({ goal, engine: pickEngineName() });
  setImmediate(() => startRun(run.id));
  res.status(201).json({ run: withControl(run) });
});

router.get('/runs/:id', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return bad(res, 404, 'No run with that id.');
  res.json({ run: withControl(run) });
});

router.delete('/runs/:id', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return bad(res, 404, 'No run with that id.');
  getController(req.params.id)?.abandon();
  store.deleteRun(req.params.id);
  res.json({ ok: true });
});

/* --------------------------------------------------------------- streaming */

router.get('/runs/:id/stream', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return bad(res, 404, 'No run with that id.');

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Replay the persisted trace first, then switch to live. A viewer who joins
  // late sees exactly what a viewer who was there from the start saw.
  const from = Number(req.query.from);
  const backlog = Number.isFinite(from) ? run.events.filter((e) => e.seq >= from) : run.events;
  send({ type: 'stream.open', runId: run.id, status: run.status, replayCount: backlog.length });
  for (const event of backlog) send(event);
  send({ type: 'stream.caughtUp', status: store.getRun(req.params.id)?.status ?? run.status });

  const unsubscribe = subscribe(req.params.id, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

/* ----------------------------------------------------------------- control */

router.post('/runs/:id/pause', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return bad(res, 404, 'No run with that id.');
  const controller = getController(req.params.id);
  if (!controller?.running) return bad(res, 409, 'This run is not executing, so there is nothing to pause.');
  controller.requestPause();
  res.json({ ok: true, message: 'Pausing after the current step finishes.' });
});

router.post('/runs/:id/resume', async (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return bad(res, 404, 'No run with that id.');
  const controller = getController(req.params.id, { create: true });

  const steps = req.body?.plan;
  if (Array.isArray(steps)) {
    if (!steps.length) return bad(res, 400, 'The remaining plan cannot be empty — abandon the run instead.');
    controller.stagePlanEdit(steps);
  }
  const instruction = req.body?.instruction;
  if (instruction) controller.addInstruction(instruction);

  await resumeRun(req.params.id);
  res.json({ ok: true, message: 'Resuming with your changes applied.' });
});

router.post('/runs/:id/instruct', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return bad(res, 404, 'No run with that id.');
  const controller = getController(req.params.id, { create: true });
  const text = controller.addInstruction(req.body?.instruction);
  if (!text) return bad(res, 400, 'An instruction is required.');
  res.json({ ok: true, message: 'The agent will pick this up at the next step boundary.' });
});

router.post('/runs/:id/plan', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return bad(res, 404, 'No run with that id.');
  const steps = req.body?.plan;
  if (!Array.isArray(steps) || !steps.length) return bad(res, 400, 'Send a non-empty plan array.');
  const controller = getController(req.params.id, { create: true });
  controller.stagePlanEdit(steps);
  res.json({ ok: true, message: 'Plan staged. It is applied when the agent resumes.' });
});

router.post('/runs/:id/abandon', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return bad(res, 404, 'No run with that id.');
  const controller = getController(req.params.id, { create: true });
  if (!controller.running) {
    store.updateRun(req.params.id, { status: 'interrupted', finishedAt: new Date().toISOString() });
    return res.json({ ok: true, message: 'Run marked as abandoned.' });
  }
  controller.abandon();
  res.json({ ok: true, message: 'Abandoning the run.' });
});

router.post('/runs/:id/rollback', async (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return bad(res, 404, 'No run with that id.');
  const stepIndex = Number(req.body?.stepIndex);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= run.plan.length) {
    return bad(res, 400, `stepIndex must be between 0 and ${run.plan.length - 1}.`);
  }
  await rollbackRun(req.params.id, stepIndex);
  res.json({ ok: true, message: `Rolled back to step ${stepIndex + 1}. The agent is re-running from there.` });
});
