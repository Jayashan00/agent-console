/**
 * RunController — the interruption mechanism.
 *
 * The run loop never checks a database or polls for user intent. It awaits this
 * object at two kinds of checkpoint:
 *
 *   • a *step boundary*, where `checkpoint()` blocks while paused. This is the
 *     contract the product promises: the step in flight always finishes, and no
 *     new step begins until the user resumes.
 *   • a *cancellation point* after every tool call, where an abandon or a
 *     rollback can cut in without waiting for the rest of the step.
 *
 * Anything the user changes while paused — plan edits, extra instructions —
 * lands here and is drained by the loop at the moment it wakes up, so an edit
 * can never be applied to a step that already started.
 */

/** @type {Map<string, RunController>} */
const controllers = new Map();

export class RunController {
  constructor(runId) {
    this.runId = runId;
    this.running = false;
    this.pauseRequested = false;
    this.paused = false;
    this.abandonRequested = false;
    this.stopRequested = false;
    this.instructions = [];
    this.planEdit = null;
    this.abortController = null;
    this._waiters = [];
    this._done = Promise.resolve();
    this._resolveDone = null;
  }

  get signal() {
    return this.abortController?.signal;
  }

  markRunning() {
    this.running = true;
    this.stopRequested = false;
    this.abandonRequested = false;
    this.abortController = new AbortController();
    this._done = new Promise((resolve) => {
      this._resolveDone = resolve;
    });
  }

  markStopped() {
    this.running = false;
    this.paused = false;
    this.pauseRequested = false;
    this._resolveDone?.();
    this._resolveDone = null;
  }

  /** Resolves once the loop has actually left the building. */
  whenStopped() {
    return this._done;
  }

  requestPause() {
    if (!this.running) return false;
    this.pauseRequested = true;
    return true;
  }

  addInstruction(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return null;
    this.instructions.push(trimmed);
    return trimmed;
  }

  stagePlanEdit(steps) {
    this.planEdit = steps;
  }

  resume() {
    this.pauseRequested = false;
    this.paused = false;
    this.release();
  }

  abandon() {
    this.abandonRequested = true;
    this.abortController?.abort();
    this.release();
  }

  /** Soft cancel used by rollback: stop the loop without failing the run. */
  stop() {
    this.stopRequested = true;
    this.abortController?.abort();
    this.release();
    return this.whenStopped();
  }

  release() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) resolve();
  }

  get shouldExit() {
    return this.abandonRequested || this.stopRequested;
  }

  /**
   * Step boundary. Blocks while paused; returns true if the loop should exit.
   * `onPause` / `onResume` let the loop tell the user what just happened.
   */
  async checkpoint({ onPause, onResume } = {}) {
    if (this.shouldExit) return true;
    if (!this.pauseRequested) return false;

    this.paused = true;
    onPause?.();
    while (this.pauseRequested && !this.shouldExit) {
      await new Promise((resolve) => this._waiters.push(resolve));
    }
    this.paused = false;
    if (this.shouldExit) return true;
    onResume?.();
    return false;
  }

  /** Drains everything the user staged while the loop was asleep. */
  drainUserChanges() {
    const instructions = this.instructions.splice(0, this.instructions.length);
    const planEdit = this.planEdit;
    this.planEdit = null;
    return { instructions, planEdit };
  }
}

export function getController(runId, { create = false } = {}) {
  let controller = controllers.get(runId);
  if (!controller && create) {
    controller = new RunController(runId);
    controllers.set(runId, controller);
  }
  return controller ?? null;
}

export const dropController = (runId) => controllers.delete(runId);
