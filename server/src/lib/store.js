import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Run store.
 *
 * Every run is one JSON document on disk: goal, plan, full ordered event log,
 * deliverable and status. The event log is the source of truth — the live SSE
 * stream and the "open a past run" view replay exactly the same records, so a
 * historical trace is never a lossy summary of what the user watched happen.
 *
 * Writes are atomic (tmp file + rename) and serialised per run, so a crash
 * mid-write can never leave a half-written trace behind.
 */

const runsDir = path.join(config.dataDir, 'runs');
fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(config.workspaceDir, { recursive: true });

/** @type {Map<string, object>} */
const cache = new Map();
/** @type {Map<string, Promise<void>>} */
const writeQueues = new Map();

const filePath = (id) => path.join(runsDir, `${id}.json`);

export const newId = (prefix = 'run') =>
  `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

function loadFromDisk() {
  let files = [];
  try {
    files = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(runsDir, file), 'utf8');
      const run = JSON.parse(raw);
      if (run && run.id) {
        // A run that was executing when the process died is not executing now.
        if (run.status === 'running' || run.status === 'planning') {
          run.status = 'interrupted';
          run.interruptedReason = 'Server restarted while this run was executing.';
        }
        cache.set(run.id, run);
      }
    } catch (err) {
      console.warn(`[store] skipping unreadable run file ${file}: ${err.message}`);
    }
  }
}
loadFromDisk();

function persist(id) {
  const previous = writeQueues.get(id) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      const run = cache.get(id);
      if (!run) return;
      const target = filePath(id);
      const tmp = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(run, null, 2), 'utf8');
      await fsp.rename(tmp, target);
    })
    .catch((err) => {
      console.error(`[store] failed to persist ${id}:`, err.message);
    });
  writeQueues.set(id, next);
  return next;
}

export function createRun({ goal, engine }) {
  const now = new Date().toISOString();
  const run = {
    id: newId(),
    goal,
    engine,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    plan: [],
    planRevision: 0,
    events: [],
    deliverable: null,
    error: null,
    pendingInstructions: [],
    stats: { toolCalls: 0, toolFailures: 0, tokensStreamed: 0, rollbacks: 0, interruptions: 0 },
  };
  cache.set(run.id, run);
  persist(run.id);
  return run;
}

export const getRun = (id) => cache.get(id) ?? null;

export function listRuns({ limit = 100 } = {}) {
  return [...cache.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
    .map((run) => ({
      id: run.id,
      goal: run.goal,
      status: run.status,
      engine: run.engine,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
      stepCount: run.plan.length,
      completedSteps: run.plan.filter((s) => s.status === 'done').length,
      toolCalls: run.stats?.toolCalls ?? 0,
      hasDeliverable: Boolean(run.deliverable),
    }));
}

export function updateRun(id, patch) {
  const run = cache.get(id);
  if (!run) return null;
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  persist(id);
  return run;
}

/** Appends an event to the run's immutable trace and returns the stored record. */
export function appendEvent(id, event) {
  const run = cache.get(id);
  if (!run) return null;
  const record = {
    seq: run.events.length,
    at: new Date().toISOString(),
    ...event,
  };
  run.events.push(record);
  run.updatedAt = record.at;
  persist(id);
  return record;
}

/**
 * Applies a delta to the last event of a streaming type instead of appending a
 * new record — this is how token-level reasoning stays one coherent block in
 * both the live view and the replay.
 */
export function appendDelta(id, { channel, stepIndex, delta }) {
  const run = cache.get(id);
  if (!run) return null;
  const last = run.events[run.events.length - 1];
  if (last && last.type === 'text' && last.channel === channel && last.stepIndex === stepIndex && !last.closed) {
    last.text += delta;
    run.updatedAt = new Date().toISOString();
    run.stats.tokensStreamed += 1;
    persist(id);
    return { ...last, isUpdate: true, delta };
  }
  const record = appendEvent(id, { type: 'text', channel, stepIndex, text: delta, closed: false });
  run.stats.tokensStreamed += 1;
  return { ...record, isUpdate: false, delta };
}

export function closeOpenText(id) {
  const run = cache.get(id);
  if (!run) return;
  const last = run.events[run.events.length - 1];
  if (last && last.type === 'text' && !last.closed) {
    last.closed = true;
    persist(id);
  }
}

/**
 * Rollback: discards every event from the start of `stepIndex` onwards and
 * returns the surviving trace. Nothing is silently rewritten — a rollback
 * marker event is appended by the caller so the history stays honest.
 */
export function truncateFromStep(id, stepIndex) {
  const run = cache.get(id);
  if (!run) return null;
  const cutAt = run.events.findIndex((e) => e.type === 'step.started' && e.stepIndex === stepIndex);
  if (cutAt >= 0) run.events = run.events.slice(0, cutAt);
  run.plan = run.plan.map((step, i) =>
    i >= stepIndex
      ? { ...step, status: 'pending', startedAt: null, finishedAt: null, summary: null, error: null }
      : step,
  );
  run.deliverable = null;
  run.stats.rollbacks += 1;
  persist(id);
  return run;
}

export function bumpStat(id, key, by = 1) {
  const run = cache.get(id);
  if (!run) return;
  run.stats[key] = (run.stats[key] ?? 0) + by;
  persist(id);
}

export async function flush() {
  await Promise.all([...writeQueues.values()]);
}

export function deleteRun(id) {
  cache.delete(id);
  writeQueues.delete(id);
  try {
    fs.unlinkSync(filePath(id));
  } catch {
    /* already gone */
  }
}
