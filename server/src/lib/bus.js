import { EventEmitter } from 'node:events';

/**
 * One process-wide emitter, one channel per run id.
 * Publishers never know or care whether anyone is watching, so an agent run is
 * never blocked or altered by the presence of a viewer.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const publish = (runId, event) => emitter.emit(`run:${runId}`, event);

export function subscribe(runId, listener) {
  const channel = `run:${runId}`;
  emitter.on(channel, listener);
  return () => emitter.off(channel, listener);
}

export const subscriberCount = (runId) => emitter.listenerCount(`run:${runId}`);
