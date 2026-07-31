import { streamUrl } from './api.js';

/**
 * SSE client, written by hand on top of fetch + ReadableStream rather than
 * EventSource. Three reasons, all of them user-visible:
 *
 *  1. it can be aborted precisely when the user switches runs, so a background
 *     run never keeps painting into the panel they are now looking at;
 *  2. it can reconnect *from a sequence number*, so a dropped connection
 *     resumes the trace instead of duplicating or losing events;
 *  3. every chunk is handed to the UI the instant it is decoded — there is no
 *     buffering layer between the socket and the render.
 */
export function openRunStream(runId, { onEvent, onStatus }) {
  const controller = new AbortController();
  let closed = false;
  let lastSeq = null;
  let attempt = 0;

  async function connect() {
    while (!closed) {
      try {
        onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');
        const res = await fetch(streamUrl(runId, lastSeq === null ? undefined : lastSeq + 1), {
          signal: controller.signal,
          headers: { accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`Stream failed (${res.status})`);

        onStatus?.('live');
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue; // ': ping' keepalives fall through here
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                const event = JSON.parse(payload);
                if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq ?? -1, event.seq);
                onEvent(event);
              } catch {
                /* a partial frame is impossible here, but never crash the stream on one */
              }
            }
          }
        }
        if (closed) return;
        throw new Error('The stream closed.');
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        attempt += 1;
        onStatus?.('offline');
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  connect();

  return () => {
    closed = true;
    controller.abort();
  };
}
