import vm from 'node:vm';
import { defineTool, ToolError, truncate } from './toolkit.js';

/**
 * run_javascript — genuine code execution, deliberately sandboxed.
 *
 * The script runs in a fresh V8 context built from an empty object, so there is
 * no `require`, no `process`, no `fetch` and no filesystem reachable from
 * inside. Only Math, JSON, Date and a captured `console` are handed in, and a
 * hard wall-clock timeout stops runaway loops. Synchronous code only — that is
 * a real limit of running a script under a V8 timeout, and it is stated in the
 * tool description so the agent plans around it instead of discovering it by
 * failing.
 */
export default defineTool({
  name: 'run_javascript',
  title: 'Run JavaScript',
  category: 'compute',
  description:
    'Execute a short synchronous JavaScript snippet in a sandbox and return its result. Use for arithmetic, sorting, filtering, date maths or transforming data you already gathered. No network, no filesystem, no async/await.',
  parameters: {
    code: {
      type: 'string',
      required: true,
      maxLength: 20000,
      description: 'JavaScript source. The value of the last expression, or whatever you `return`, is captured as the result.',
    },
    timeoutMs: { type: 'number', required: false, default: 2000, min: 100, max: 10000, description: 'Execution time limit.' },
  },
  returns: 'The returned value (JSON-encoded), anything logged to console, and the execution time.',
  signature: (input) => `run_javascript(${String(input.code ?? '').split('\n').length} lines)`,

  async run({ code, timeoutMs = 2000 }, ctx) {
    const logs = [];
    const sandbox = Object.create(null);
    Object.assign(sandbox, {
      Math,
      JSON,
      Date,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      RegExp,
      isNaN,
      parseInt,
      parseFloat,
      console: {
        log: (...args) => logs.push(args.map(fmt).join(' ')),
        error: (...args) => logs.push('ERROR: ' + args.map(fmt).join(' ')),
        warn: (...args) => logs.push('WARN: ' + args.map(fmt).join(' ')),
      },
    });

    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const wrapped = `(function () {\n${code}\n})()`;
    const startedAt = Date.now();
    ctx.progress('Executing in sandbox');

    let value;
    try {
      value = new vm.Script(wrapped, { filename: 'agent-snippet.js' }).runInContext(context, {
        timeout: timeoutMs,
        breakOnSigint: true,
      });
    } catch (err) {
      const timedOut = /timed out|Script execution/i.test(err.message);
      throw new ToolError(
        timedOut
          ? `Snippet exceeded the ${timeoutMs}ms limit — it is probably looping forever.`
          : `${err.name}: ${err.message}`,
        { kind: timedOut ? 'timeout' : 'runtime_error', retriable: true, detail: { logs } },
      );
    }

    return {
      result: safeStringify(value),
      type: value === null ? 'null' : typeof value,
      logs: logs.slice(0, 50),
      durationMs: Date.now() - startedAt,
    };
  },
});

function fmt(v) {
  if (typeof v === 'string') return v;
  return safeStringify(v);
}

function safeStringify(value) {
  if (value === undefined) return 'undefined';
  try {
    return truncate(JSON.stringify(value, null, 2) ?? String(value), 4000);
  } catch {
    return truncate(String(value), 4000);
  }
}
