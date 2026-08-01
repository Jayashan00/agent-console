/**
 * Provider transport test.
 *
 * Stands up mock Anthropic and OpenAI-compatible SSE endpoints and asserts that
 * `streamCompletion` reassembles both dialects into the same text *and* emits
 * it incrementally. This is the seam where a free provider (Groq, Google AI
 * Studio, Cerebras, OpenRouter) is swapped in, so it gets its own test rather
 * than being discovered broken at demo time.
 *
 *   node test/providers.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const CHUNKS = ['<thinking>', 'Searching ', 'for ', 'sources.', '</thinking>'];
const EXPECTED = CHUNKS.join('');

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

/**
 * Worker mode. `config.js` reads the environment once at import time, so each
 * provider is exercised in its own process — the same way it runs in production.
 */
if (process.env.PROVIDER_TEST_WORKER) {
  const { streamCompletion } = await import('../src/lib/llm.js');
  const deltas = [];
  const times = [];
  const result = await streamCompletion({
    system: 'SYSTEM PROMPT',
    messages: [{ role: 'user', content: 'GOAL' }],
    onDelta: (delta) => {
      deltas.push(delta);
      times.push(Date.now());
    },
  });
  process.stdout.write(
    JSON.stringify({ text: result.text, stopReason: result.stopReason, deltas, spread: times[times.length - 1] - times[0] }),
  );
  process.exit(0);
}

function mockServer(dialect) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

      for (const text of CHUNKS) {
        frame(
          dialect === 'anthropic'
            ? { type: 'content_block_delta', delta: { type: 'text_delta', text } }
            : { choices: [{ delta: { content: text } }] },
        );
        await new Promise((r) => setTimeout(r, 15));
      }
      frame(
        dialect === 'anthropic'
          ? { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
          : { choices: [{ delta: {}, finish_reason: 'stop' }] },
      );
      res.write('data: [DONE]\n\n');
      res.end();

      server.emit('captured', { parsed, headers: req.headers, url: req.url });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function run() {
  console.log('\nAgent Console — provider transports\n');
  const self = fileURLToPath(import.meta.url);

  for (const dialect of ['anthropic', 'openai']) {
    const server = await mockServer(dialect);
    const { port } = server.address();
    const captured = new Promise((resolve) => server.once('captured', resolve));

    const env = { ...process.env, PROVIDER_TEST_WORKER: '1', LLM_PROVIDER: dialect };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    if (dialect === 'anthropic') {
      env.ANTHROPIC_API_KEY = 'test-key';
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    } else {
      env.OPENAI_API_KEY = 'test-key';
      env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
    }

    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [self], { env });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `worker exited ${code}`))));
    });

    const result = JSON.parse(output);
    const request = await captured;

    check(`${dialect}: reassembles the full response`, () => assert.equal(result.text, EXPECTED));
    check(`${dialect}: emits one delta per chunk, incrementally`, () => {
      assert.equal(result.deltas.length, CHUNKS.length);
      assert.ok(result.spread > 30, `deltas arrived within ${result.spread}ms — that is batched`);
    });
    check(`${dialect}: reports the stop reason`, () => assert.ok(result.stopReason));
    check(`${dialect}: sends the system prompt in the right place`, () => {
      if (dialect === 'anthropic') {
        assert.equal(request.parsed.system, 'SYSTEM PROMPT');
        assert.equal(request.parsed.messages[0].content, 'GOAL');
        assert.equal(request.headers['x-api-key'], 'test-key');
      } else {
        assert.equal(request.parsed.messages[0].role, 'system');
        assert.equal(request.parsed.messages[0].content, 'SYSTEM PROMPT');
        assert.equal(request.parsed.messages[1].content, 'GOAL');
        assert.equal(request.headers.authorization, 'Bearer test-key');
        assert.ok(request.url.endsWith('/chat/completions'), `hit ${request.url}`);
      }
    });

    server.close();
  }

  console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures above' : ' — all green'}\n`);
}

run().catch((err) => {
  console.error('\nProvider test crashed:', err);
  process.exit(1);
});
