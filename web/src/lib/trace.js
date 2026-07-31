/**
 * Trace reducer.
 *
 * Live events and replayed events are the same records, so this one reducer
 * builds the view for both. That is the reason a run you open from history is
 * indistinguishable from the one you watched happen.
 */

export const initialTraceState = {
  runId: null,
  goal: '',
  status: 'queued',
  engine: null,
  plan: [],
  planRevision: 0,
  nodes: [],
  deliverable: '',
  deliverableStreaming: false,
  activeStep: null,
  phase: null,
  error: null,
  stats: { toolCalls: 0, toolFailures: 0 },
  pendingInstructions: [],
};

let localId = 0;
const nextId = () => `n${++localId}`;

function push(nodes, node) {
  return [...nodes, { id: nextId(), ...node }];
}

function updateNode(nodes, predicate, patch) {
  let found = false;
  const next = nodes.map((node) => {
    if (found || !predicate(node)) return node;
    found = true;
    return { ...node, ...(typeof patch === 'function' ? patch(node) : patch) };
  });
  return found ? next : nodes;
}

export function applyEvent(state, event) {
  switch (event.type) {
    case 'stream.open':
      return { ...state, status: event.status ?? state.status };

    case 'stream.caughtUp':
      return { ...state, status: event.status ?? state.status, caughtUp: true };

    case 'run.status':
      return { ...state, status: event.status };

    case 'phase':
      return {
        ...state,
        phase: event.phase,
        nodes: push(state.nodes, { kind: 'phase', phase: event.phase, message: event.message, at: event.at }),
      };

    case 'plan.created':
      return {
        ...state,
        plan: event.steps,
        planRevision: event.revision ?? 1,
        nodes: push(state.nodes, { kind: 'plan', by: 'agent', steps: event.steps, revision: event.revision, at: event.at }),
      };

    case 'plan.updated':
      return {
        ...state,
        plan: event.steps,
        planRevision: event.revision ?? state.planRevision,
        nodes: push(state.nodes, {
          kind: 'plan',
          by: event.by,
          reason: event.reason,
          steps: event.steps,
          revision: event.revision,
          fromStep: event.fromStep,
          at: event.at,
        }),
      };

    case 'step.started':
      return {
        ...state,
        activeStep: event.stepIndex,
        nodes: push(state.nodes, {
          kind: 'step',
          stepIndex: event.stepIndex,
          title: event.title,
          detail: event.detail,
          tool: event.tool,
          status: 'running',
          at: event.at,
        }),
      };

    case 'step.completed':
      return {
        ...state,
        activeStep: null,
        plan: state.plan.map((step, i) =>
          i === event.stepIndex ? { ...step, status: event.status ?? 'done', summary: event.summary } : step,
        ),
        nodes: updateNode(
          [...state.nodes].reverse(),
          (n) => n.kind === 'step' && n.stepIndex === event.stepIndex && n.status === 'running',
          { status: event.status ?? 'done', summary: event.summary },
        ).reverse(),
      };

    case 'step.patched':
      return {
        ...state,
        plan: state.plan.map((step, i) => (i === event.stepIndex ? { ...step, ...event.patch } : step)),
      };

    /* ------------------------------------------------------------ text */
    case 'text': // replayed block
      if (event.channel === 'deliverable') {
        return { ...state, deliverable: state.deliverable + event.text };
      }
      return {
        ...state,
        nodes: push(state.nodes, {
          kind: 'text',
          blockId: event.seq,
          channel: event.channel,
          stepIndex: event.stepIndex,
          text: event.text,
          streaming: false,
          at: event.at,
        }),
      };

    case 'text.delta': {
      if (event.channel === 'deliverable') {
        return { ...state, deliverable: state.deliverable + event.delta, deliverableStreaming: true };
      }
      const exists = state.nodes.some((n) => n.kind === 'text' && n.blockId === event.blockId);
      if (exists) {
        return {
          ...state,
          nodes: state.nodes.map((n) =>
            n.kind === 'text' && n.blockId === event.blockId ? { ...n, text: n.text + event.delta, streaming: true } : n,
          ),
        };
      }
      return {
        ...state,
        nodes: push(state.nodes, {
          kind: 'text',
          blockId: event.blockId,
          channel: event.channel,
          stepIndex: event.stepIndex,
          text: event.delta,
          streaming: true,
          at: event.at,
        }),
      };
    }

    /* ------------------------------------------------------------ tools */
    case 'tool.call':
      return {
        ...state,
        stats: { ...state.stats, toolCalls: state.stats.toolCalls + 1 },
        nodes: push(state.nodes, {
          kind: 'tool',
          callId: event.callId,
          stepIndex: event.stepIndex,
          tool: event.tool,
          title: event.title,
          category: event.category,
          description: event.description,
          input: event.input,
          signature: event.signature,
          state: 'running',
          progress: [],
          startedAt: event.at,
        }),
      };

    case 'tool.progress':
      return {
        ...state,
        nodes: updateNode(state.nodes, (n) => n.kind === 'tool' && n.callId === event.callId, (n) => ({
          progress: [...n.progress, { message: event.message, at: event.at }],
        })),
      };

    case 'tool.result':
      return {
        ...state,
        stats: { ...state.stats, toolFailures: state.stats.toolFailures + (event.ok ? 0 : 1) },
        nodes: updateNode(state.nodes, (n) => n.kind === 'tool' && n.callId === event.callId, {
          state: event.ok ? 'ok' : 'failed',
          output: event.output,
          error: event.error,
          durationMs: event.durationMs,
          finishedAt: event.at,
        }),
      };

    /* ----------------------------------------------------------- control */
    case 'paused':
      return {
        ...state,
        status: 'paused',
        nodes: push(state.nodes, { kind: 'control', tone: 'pause', message: event.message, stepIndex: event.stepIndex, at: event.at }),
      };

    case 'resumed':
      return {
        ...state,
        status: 'running',
        nodes: push(state.nodes, { kind: 'control', tone: 'resume', message: event.message, stepIndex: event.stepIndex, at: event.at }),
      };

    case 'instruction':
      return {
        ...state,
        nodes: push(state.nodes, { kind: 'control', tone: 'instruction', message: event.text, stepIndex: event.stepIndex, at: event.at }),
      };

    case 'rollback':
      return {
        ...state,
        deliverable: '',
        nodes: push(state.nodes, { kind: 'rollback', stepIndex: event.stepIndex, message: event.message, at: event.at }),
      };

    case 'notice':
      return {
        ...state,
        nodes: push(state.nodes, { kind: 'control', tone: event.level === 'warn' ? 'warn' : 'note', message: event.message, at: event.at }),
      };

    case 'deliverable.ready':
      return { ...state, deliverableStreaming: false };

    case 'error':
      return {
        ...state,
        error: event.message,
        nodes: push(state.nodes, { kind: 'control', tone: 'error', message: event.message, at: event.at }),
      };

    case 'run.completed':
      return { ...state, status: event.status, activeStep: null, deliverableStreaming: false };

    default:
      return state;
  }
}

/** Builds view state for a run fetched from history. */
export function hydrate(run) {
  let state = {
    ...initialTraceState,
    runId: run.id,
    goal: run.goal,
    status: run.status,
    engine: run.engine,
    plan: run.plan ?? [],
    planRevision: run.planRevision ?? 0,
    deliverable: '',
    nodes: [],
    stats: { toolCalls: 0, toolFailures: 0 },
    pendingInstructions: run.pendingInstructions ?? [],
    error: run.error ?? null,
  };
  for (const event of run.events ?? []) state = applyEvent(state, event);
  return { ...state, plan: run.plan ?? state.plan, status: run.status, deliverable: run.deliverable ?? state.deliverable };
}

export function traceReducer(state, action) {
  if (action.type === 'hydrate') return hydrate(action.run);
  if (action.type === 'clear') return { ...initialTraceState };
  if (action.type === 'event') return applyEvent(state, action.event);
  if (action.type === 'patch') return { ...state, ...action.patch };
  return state;
}
