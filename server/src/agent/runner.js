import { config, hasLlm } from '../config.js';
import * as store from '../lib/store.js';
import { publish } from '../lib/bus.js';
import { executeTool, getTool } from '../tools/index.js';
import { truncate } from '../tools/toolkit.js';
import { llmEngine } from './llmEngine.js';
import { scriptedEngine } from './scriptedEngine.js';
import { getController } from './controller.js';
import { LlmError } from '../lib/llm.js';

/**
 * The agent loop. Written by hand, on purpose: the interruption guarantees this
 * product makes are properties of *this* loop, not of a framework's callbacks.
 */

const ENGINES = { llm: llmEngine, scripted: scriptedEngine };

export const pickEngineName = () => (hasLlm() ? 'llm' : 'scripted');

class Abandoned extends Error {}
class SoftStop extends Error {}

/* ---------------------------------------------------------------- emitting */

function emitter(runId) {
  const emit = (type, payload = {}) => {
    const record = store.appendEvent(runId, { type, ...payload });
    if (record) publish(runId, record);
    return record;
  };

  const emitText = (channel, delta, stepIndex) => {
    const record = store.appendDelta(runId, { channel, stepIndex, delta });
    if (record) {
      publish(runId, {
        type: 'text.delta',
        blockId: record.seq,
        channel,
        stepIndex,
        delta,
        at: record.at,
      });
    }
  };

  const closeText = () => store.closeOpenText(runId);

  return { emit, emitText, closeText };
}

function setStatus(runId, status, extra = {}) {
  const run = store.updateRun(runId, { status, ...extra });
  publish(runId, { type: 'run.status', status, at: new Date().toISOString(), ...extra });
  return run;
}

/* ------------------------------------------------------------ observations */

/** Rebuilds agent working memory from the persisted trace — the trace is the state. */
function rebuildObservations(run) {
  const observations = [];
  for (const event of run.events) {
    if (event.type === 'tool.result') {
      observations.push({
        kind: 'tool',
        stepIndex: event.stepIndex,
        tool: event.tool,
        signature: event.signature,
        ok: event.ok,
        durationMs: event.durationMs,
        output: event.output ?? null,
        errorMessage: event.error?.message,
        text: event.ok ? summariseOutput(event.output) : `ERROR (${event.error?.kind}): ${event.error?.message}`,
      });
    } else if (event.type === 'instruction') {
      observations.push({ kind: 'instruction', stepIndex: event.stepIndex, text: event.text });
    } else if (event.type === 'rollback') {
      observations.push({ kind: 'rollback', stepIndex: event.stepIndex, text: `Rolled back to step ${event.stepIndex + 1}.` });
    } else if (event.type === 'plan.updated' && event.by === 'user') {
      observations.push({ kind: 'note', text: 'The user rewrote the remaining plan. Follow the plan as it now stands.' });
    }
  }
  return observations;
}

function summariseOutput(output) {
  if (output == null) return 'null';
  if (typeof output === 'string') return truncate(output, 2500);
  try {
    return truncate(JSON.stringify(output, null, 2), 2500);
  } catch {
    return truncate(String(output), 2500);
  }
}

const normaliseSteps = (steps) =>
  steps.map((step, i) => ({
    id: step.id ?? `s${i}_${Math.random().toString(36).slice(2, 8)}`,
    title: String(step.title ?? `Step ${i + 1}`).slice(0, 140),
    detail: String(step.detail ?? '').slice(0, 400),
    tool: step.tool ?? null,
    script: step.script ?? null,
    status: step.status ?? 'pending',
    startedAt: step.startedAt ?? null,
    finishedAt: step.finishedAt ?? null,
    summary: step.summary ?? null,
    error: step.error ?? null,
    origin: step.origin ?? 'agent',
  }));

/* ------------------------------------------------------------------- loop */

export async function startRun(runId, { fromStep = 0 } = {}) {
  const controller = getController(runId, { create: true });
  if (controller.running) return;
  controller.markRunning();

  const { emit, emitText, closeText } = emitter(runId);
  let run = store.getRun(runId);
  if (!run) {
    controller.markStopped();
    return;
  }

  let engine = ENGINES[run.engine] ?? scriptedEngine;

  /** Runs an engine call; if the model dies mid-run, degrade instead of failing. */
  const withEngine = async (fn) => {
    try {
      return await fn(engine);
    } catch (err) {
      if (err instanceof LlmError && engine !== scriptedEngine) {
        engine = scriptedEngine;
        store.updateRun(runId, { engine: 'scripted', engineFallbackReason: err.message });
        emit('notice', {
          level: 'warn',
          message: `The model is unavailable (${truncate(err.message, 160)}). Continuing this run on the scripted engine so your work is not lost.`,
        });
        return fn(engine);
      }
      throw err;
    }
  };

  const buildContext = (currentStepIndex, extra = {}) => {
    const current = store.getRun(runId);
    return {
      goal: current.goal,
      plan: current.plan,
      currentStepIndex,
      observations: rebuildObservations(current),
      instructions: current.pendingInstructions ?? [],
      signal: controller.signal,
      emitText: (channel, delta) => emitText(channel, delta, currentStepIndex),
      ...extra,
    };
  };

  try {
    /* ---------------------------------------------------------- planning */
    if (!run.plan.length) {
      setStatus(runId, 'planning');
      emit('phase', { phase: 'planning', message: 'Breaking the goal into a plan' });

      const steps = await withEngine((e) => e.plan(buildContext(0)));
      closeText();
      if (controller.shouldExit) throw controller.abandonRequested ? new Abandoned() : new SoftStop();

      const plan = normaliseSteps(steps);
      store.updateRun(runId, { plan, planRevision: 1, startedAt: run.startedAt ?? new Date().toISOString() });
      emit('plan.created', { steps: plan, revision: 1 });
    }

    setStatus(runId, 'running');

    /* ------------------------------------------------------------- steps */
    let index = fromStep;
    let guard = 0;
    while (index < store.getRun(runId).plan.length && guard++ < config.maxSteps * 4) {
      const exit = await controller.checkpoint({
        onPause: () => {
          setStatus(runId, 'paused', { pausedAtStep: index });
          store.bumpStat(runId, 'interruptions');
          emit('paused', {
            stepIndex: index,
            message: `Paused before step ${index + 1}. Edit the remaining plan, add an instruction, or resume.`,
          });
        },
        onResume: () => {
          setStatus(runId, 'running');
          emit('resumed', { stepIndex: index, message: `Resumed at step ${index + 1}.` });
        },
      });
      if (exit) throw controller.abandonRequested ? new Abandoned() : new SoftStop();

      applyUserChanges(runId, controller, emit, index);

      const current = store.getRun(runId);
      if (index >= current.plan.length) break;

      const outcome = await runStep({ runId, index, controller, engine: () => engine, withEngine, emit, emitText, closeText, buildContext });
      if (outcome.replanned) continue;
      index += 1;
    }

    /* -------------------------------------------------------- deliverable */
    const exit = await controller.checkpoint({
      onPause: () => {
        setStatus(runId, 'paused', { pausedAtStep: store.getRun(runId).plan.length });
        emit('paused', { stepIndex: store.getRun(runId).plan.length, message: 'Paused before writing the deliverable.' });
      },
      onResume: () => setStatus(runId, 'running'),
    });
    if (exit) throw controller.abandonRequested ? new Abandoned() : new SoftStop();

    emit('phase', { phase: 'deliverable', message: 'Writing the deliverable' });
    const markdown = await withEngine((e) => e.finalize(buildContext(store.getRun(runId).plan.length)));
    closeText();

    store.updateRun(runId, { deliverable: markdown, finishedAt: new Date().toISOString() });
    emit('deliverable.ready', { chars: markdown.length });
    setStatus(runId, 'completed', { finishedAt: new Date().toISOString() });
    emit('run.completed', { status: 'completed' });
  } catch (err) {
    closeText();
    if (err instanceof SoftStop || controller.stopRequested) {
      // A rollback or restart is taking over; the caller decides the next status.
    } else if (err instanceof Abandoned || controller.abandonRequested) {
      store.updateRun(runId, { finishedAt: new Date().toISOString() });
      setStatus(runId, 'interrupted', { finishedAt: new Date().toISOString() });
      emit('run.completed', { status: 'interrupted', message: 'You abandoned this run.' });
    } else {
      const message = err?.message ?? 'Unknown failure';
      store.updateRun(runId, { error: message, finishedAt: new Date().toISOString() });
      emit('error', { message, fatal: true });
      setStatus(runId, 'failed', { finishedAt: new Date().toISOString() });
      emit('run.completed', { status: 'failed', message });
      console.error(`[runner] ${runId} failed:`, err);
    }
  } finally {
    controller.markStopped();
  }
}

/* --------------------------------------------------------------- one step */

async function runStep({ runId, index, controller, withEngine, emit, emitText, closeText, buildContext }) {
  const started = new Date().toISOString();
  patchStep(runId, index, { status: 'running', startedAt: started });
  const step = store.getRun(runId).plan[index];
  emit('step.started', { stepIndex: index, title: step.title, detail: step.detail, tool: step.tool });

  for (let attempt = 0; attempt < config.maxToolCallsPerStep; attempt++) {
    if (controller.shouldExit) throw controller.abandonRequested ? new Abandoned() : new SoftStop();

    const decision = await withEngine((e) => e.decide(buildContext(index)));
    closeText();
    if (controller.shouldExit) throw controller.abandonRequested ? new Abandoned() : new SoftStop();

    if (decision.type === 'replan') {
      const current = store.getRun(runId);
      const kept = current.plan.slice(0, index);
      const replacement = normaliseSteps(decision.steps).map((s) => ({ ...s, origin: 'agent' }));
      const plan = [...kept, ...replacement];
      store.updateRun(runId, { plan, planRevision: (current.planRevision ?? 0) + 1 });
      emit('plan.updated', {
        steps: plan,
        revision: (current.planRevision ?? 0) + 1,
        by: 'agent',
        reason: decision.reason,
        fromStep: index,
      });
      return { replanned: true };
    }

    if (decision.type === 'complete') {
      // Instructions have now been seen by a full step; they stop being "unaddressed"
      // but remain permanently in the trace as instruction events.
      if (store.getRun(runId).pendingInstructions?.length) store.updateRun(runId, { pendingInstructions: [] });
      patchStep(runId, index, { status: 'done', finishedAt: new Date().toISOString(), summary: decision.summary });
      emit('step.completed', { stepIndex: index, summary: decision.summary, status: 'done' });
      return { replanned: false };
    }

    /* ------------------------------------------------------- tool call */
    const tool = getTool(decision.tool);
    const callId = store.newId('call');
    emit('tool.call', {
      callId,
      stepIndex: index,
      tool: decision.tool,
      title: tool?.title ?? 'Unknown tool',
      category: tool?.category ?? 'unknown',
      description: tool?.description ?? null,
      input: decision.input,
      signature: tool ? tool.signature(decision.input) : `${decision.tool}(…)`,
      expects: tool ? Object.keys(tool.parameters) : [],
    });
    store.bumpStat(runId, 'toolCalls');

    const result = await executeTool(decision.tool, decision.input, {
      runId,
      stepIndex: index,
      signal: controller.signal,
      progress: (message) => {
        const record = { type: 'tool.progress', callId, stepIndex: index, message, at: new Date().toISOString() };
        publish(runId, record);
      },
    });

    if (!result.ok) store.bumpStat(runId, 'toolFailures');

    emit('tool.result', {
      callId,
      stepIndex: index,
      tool: result.tool ?? decision.tool,
      signature: result.signature ?? `${decision.tool}(…)`,
      ok: result.ok,
      durationMs: result.durationMs,
      output: result.ok ? result.output : null,
      error: result.ok ? null : result.error,
    });

    if (controller.shouldExit) throw controller.abandonRequested ? new Abandoned() : new SoftStop();
  }

  // Ran out of tool budget for this step: close it honestly rather than looping.
  const note = `Reached the ${config.maxToolCallsPerStep}-tool-call budget for this step.`;
  patchStep(runId, index, { status: 'done', finishedAt: new Date().toISOString(), summary: note });
  emit('step.completed', { stepIndex: index, summary: note, status: 'done' });
  return { replanned: false };
}

function patchStep(runId, index, patch) {
  const run = store.getRun(runId);
  if (!run?.plan[index]) return;
  const plan = run.plan.map((step, i) => (i === index ? { ...step, ...patch } : step));
  store.updateRun(runId, { plan });
  publish(runId, { type: 'step.patched', stepIndex: index, patch, at: new Date().toISOString() });
}

/** Applies plan edits and instructions staged by the user while the loop slept. */
function applyUserChanges(runId, controller, emit, index) {
  const { instructions, planEdit } = controller.drainUserChanges();

  if (planEdit) {
    const run = store.getRun(runId);
    const kept = run.plan.slice(0, index);
    const edited = normaliseSteps(planEdit).map((step) => ({ ...step, origin: 'user', status: 'pending' }));
    const plan = [...kept, ...edited];
    store.updateRun(runId, { plan, planRevision: (run.planRevision ?? 0) + 1 });
    emit('plan.updated', {
      steps: plan,
      revision: (run.planRevision ?? 0) + 1,
      by: 'user',
      reason: 'You rewrote the remaining plan.',
      fromStep: index,
    });
  }

  if (instructions.length) {
    const run = store.getRun(runId);
    store.updateRun(runId, { pendingInstructions: [...(run.pendingInstructions ?? []), ...instructions] });
    for (const text of instructions) {
      emit('instruction', { stepIndex: index, text });
    }
  }
}

/* ---------------------------------------------------- external transitions */

export async function rollbackRun(runId, stepIndex) {
  const controller = getController(runId, { create: true });
  if (controller.running) await controller.stop();

  const run = store.truncateFromStep(runId, stepIndex);
  if (!run) return null;

  const record = store.appendEvent(runId, {
    type: 'rollback',
    stepIndex,
    message: `Rolled back to step ${stepIndex + 1}. Everything after this point was discarded and will be re-run.`,
  });
  publish(runId, record);
  store.updateRun(runId, { finishedAt: null, error: null });

  controller.pauseRequested = false;
  setImmediate(() => startRun(runId, { fromStep: stepIndex }));
  return store.getRun(runId);
}

export async function resumeRun(runId) {
  const controller = getController(runId, { create: true });
  if (controller.running) {
    controller.resume();
    return store.getRun(runId);
  }
  // Nothing is executing (e.g. after a server restart): restart from the first
  // step that has not completed, so a resumed run picks up where it stopped.
  const run = store.getRun(runId);
  if (!run) return null;
  const next = run.plan.findIndex((step) => step.status !== 'done');
  const fromStep = next === -1 ? run.plan.length : next;
  controller.pauseRequested = false;
  setImmediate(() => startRun(runId, { fromStep }));
  return run;
}
