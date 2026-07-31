# Agent Console

**An AI agent interface that makes execution legible, interruptible and reversible.**

Heva AI — Full Stack Developer, Assignment 1
Built by **Jayashan Nawarathne**

You give the agent a goal. It writes a plan before touching anything. Then it executes, and every plan revision, reasoning token, tool call, parameter, result and failure streams into the UI as it happens. At any point you can pause it, rewrite its remaining plan, hand it a new instruction, abandon it, or roll it back to any completed step and let it run forward again from there. Every run is persisted, and reopening one from history replays exactly what you would have watched live.

---

## Quick start

```bash
npm install     # installs the server and the web app
npm run dev     # API on :8787, UI on http://localhost:5173
```

Open **http://localhost:5173**.

That is the whole setup. **No API key is required to see a complete live run** — see [Two engines](#two-engines) below. For model-driven runs:

```bash
cp .env.example .env
# put your key in ANTHROPIC_API_KEY
npm run dev
```

Production (single origin, one URL):

```bash
npm run build   # builds the frontend
npm start       # serves the API and the built UI on :8787
```

Verify the guarantees yourself:

```bash
npm run smoke --prefix server
```

This boots the real server, drives real runs over the real HTTP API and the real SSE stream, and asserts 22 properties — that reasoning arrives incrementally rather than batched, that every tool call has a matching result, that failures are structured rather than fatal, that **no new step begins while paused**, that an edited plan is actually honoured, that rollback rewinds the trace, and that a past run replays in full.

---

## Two engines

| | `llm` | `scripted` |
|---|---|---|
| When | `ANTHROPIC_API_KEY` is set | no key set, or the model call fails mid-run |
| Decides what to do | Claude, via a streaming tagged protocol | a deterministic research routine |
| Tools | real | **the same real tools** |
| Streaming, pause, rollback, persistence | identical | identical |

The scripted engine is not a mock. It runs the same loop, hits the same live networks, writes the same files on disk and streams through the same channel — only the decision-making is deterministic. It exists for two reasons: an evaluator can clone the repo and watch a complete live agent run in one command with no credentials, and a model outage **degrades** a run in flight instead of killing it. If the model dies mid-run you will see a `Degraded` marker in the trace and the run carries on.

---

## Agent architecture

No LangChain, no LlamaIndex, no AutoGen. The loop is `server/src/agent/runner.js`, ~330 lines, and the interruption guarantees are properties of that loop rather than of a framework's callbacks.

```
POST /api/runs
      │
      ▼
┌─────────────┐   plan is streamed, then persisted and shown before any tool runs
│  PLANNING   │
└──────┬──────┘
       ▼
┌──────────────────────── step boundary ────────────────────────┐
│  controller.checkpoint()   ← blocks here while paused         │
│  drain user changes        ← plan edits + instructions land   │
│  ┌──────────── up to N tool calls per step ────────────────┐  │
│  │  engine.decide()  →  <thinking> streams while it decides│  │
│  │      ├── action   →  execute tool, stream result        │  │
│  │      ├── complete →  close the step                     │  │
│  │      └── replan   →  replace remaining steps, restart   │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
       ▼
┌─────────────┐   rendered separately from the trace, copyable and downloadable
│ DELIVERABLE │
└─────────────┘
```

**The engine contract** is three methods — `plan`, `decide`, `finalize` — so the LLM engine and the scripted engine are interchangeable at runtime.

**The model protocol** is a tiny tagged format rather than JSON-only output:

```
<thinking>The search returned a Wikipedia article. Reading it in full so I quote
the source rather than the snippet.</thinking>
<action>{"tool": "fetch_url", "input": {"url": "https://…", "maxChars": 6000}}</action>
```

`<thinking>` streams to the browser token by token *while the same response is still producing the `<action>` JSON that decides what happens next*. Pure JSON output would have forced a choice between structured decisions and streamable reasoning; the tagged format gets both from one call. `server/src/lib/tagStream.js` is the incremental parser that makes this safe — it releases text the instant it cannot be part of a tag, and holds back only the characters that could still turn out to be `</think…`.

**Interruption** (`server/src/agent/controller.js`) uses two kinds of checkpoint:

- **Step boundaries** — `checkpoint()` blocks while paused. This is the promise the product makes: the step in flight always finishes, and no new step begins until you resume. Plan edits and instructions are staged on the controller and drained at the moment the loop wakes, so an edit can never be applied to a step that already started.
- **Cancellation points** — after every tool call, so abandon and rollback cut in immediately rather than waiting out the step.

A plan edit replaces every step from the pause point onward and marks them `origin: 'user'`; the UI tags them `yours`, and they are permanently in the trace as a `plan.updated` event attributed to you. Instructions become `instruction` events that enter the agent's context on the next turn and stay in the record forever.

**Rollback** stops the loop, truncates the event log back to the target step's `step.started`, resets those steps to pending, writes a visible rollback marker, and restarts execution from that index. Because the agent's memory is derived from the event log (see below), rewinding the trace rewinds the agent's mind — it does not "remember" the work you just discarded.

---

## Tool implementations

Six real tools, each with a typed parameter schema declared once in `server/src/tools/`. That single declaration does three jobs — it compiles into the model's prompt, it validates and coerces the model's arguments before anything executes, and it renders the parameter table you see on the trace card — so the three can never drift apart. Open the **tools** chip in the header to see the live registry.

| Tool | What it really does |
|---|---|
| `web_search` | Queries DuckDuckGo's Instant Answer API and Wikipedia's search API in parallel, merges and de-duplicates by URL. If one provider dies it returns the other's results flagged as degraded; it only fails when both do. |
| `fetch_url` | Fetches a page, extracts readable text, follows redirects, reports the final URL. Rejects non-http(s) schemes and private/loopback addresses rather than sanitising them into something that quietly works. |
| `write_file` | Writes to a workspace scoped **per run**, resolved through `path.resolve` so `../../etc/passwd` is rejected, not normalised. |
| `read_file` | Reads it back. On a miss it returns the list of files that *do* exist, so the agent can self-correct instead of guessing. |
| `run_javascript` | Real execution in a fresh `node:vm` context built from an empty object — no `require`, no `process`, no `fetch`, no filesystem — under a hard wall-clock timeout. Synchronous only, which is a real limit of running under a V8 timeout and is stated in the tool description so the agent plans around it instead of discovering it by failing. |
| `get_weather` | Two chained calls to Open-Meteo: geocode the place, then forecast the coordinates. Included to prove dependent API chaining and a specific, actionable error when the first hop finds nothing. |

**Failure handling.** `executeTool` *always resolves*. A failing tool returns a structured envelope — `kind`, `message`, `retriable` — that the agent reads on its next turn and reacts to. One bad tool call cannot end a run someone is watching. Every tool also has an `AbortController`-backed timeout, and a second outer timeout catches a tool that hangs past its own.

Failures render in the trace as a red card with the error kind, whether it is recoverable, and the line *"The run continues — the agent sees this message and decides what to do next."* Watching an agent recover from a failure is one of the strongest trust signals the interface can give, so the design treats failure as content rather than as an error state.

---

## Streaming mechanism

SSE end to end. No polling anywhere in the product.

```
tool / model  →  store.appendDelta  →  bus.publish  →  SSE frame  →  fetch reader  →  reducer  →  DOM
```

- **Server** (`routes/runs.js`): `GET /api/runs/:id/stream` writes `text/event-stream` with `x-accel-buffering: no`, replays the persisted trace, emits `stream.caughtUp`, then attaches to a per-run emitter for live events. A late viewer sees exactly what an early viewer saw.
- **Client** (`web/src/lib/stream.js`): a hand-written SSE reader on `fetch` + `ReadableStream` rather than `EventSource`. Three user-visible reasons: it can be aborted precisely when you switch runs, so a background run never paints into the panel you are now looking at; it can **reconnect from a sequence number**, so a dropped connection resumes the trace instead of duplicating or losing events; and every chunk reaches the reducer the instant it is decoded, with no buffering layer in between.
- **Token-level, not chunk-level.** Reasoning arrives as `text.delta` events carrying a `blockId`, and the client appends to the matching block. The smoke test asserts both that there are many deltas *and* that their arrival timestamps are spread over time — a batched response with a fake delay would fail that check.
- **Meaningful loading states.** Tools emit `tool.progress` events (`Requesting en.wikipedia.org`, `Reading response`, `Extracting text from 47.2 KB`), so a long-running call shows what it is doing and a live elapsed timer, not an unexplained spinner.

---

## Persistence

Each run is one JSON document (`data/runs/<id>.json`) written atomically via tmp-file-plus-rename, with writes serialised per run so a crash mid-write cannot leave a half-written trace. The run holds the goal, the plan, the **full ordered event log**, the deliverable and stats. History lists every past goal with its status (`completed` / `interrupted` / `failed` / `paused`), step and tool-call counts, and links to the full trace. A run that was executing when the process died is marked `interrupted` on boot rather than lying about still running.

*Why not SQLite:* nothing here needs relational queries — the access pattern is "load one run by id" and "list runs" — and a zero-native-dependency store means `npm install` cannot fail on an evaluator's machine over a compiler toolchain. The store interface is five functions, so swapping in Postgres for a multi-user deployment is a contained change.

---

## The design decision that cost real engineering

**The trace is the state. The agent's working memory is rebuilt from the persisted event log on every single turn, rather than kept in a live in-process context.**

The obvious implementation is the cheap one: hold a `messages` array in memory, append to it as the run proceeds, and write a log to disk on the side for display. Instead, `rebuildObservations()` walks the persisted events and reconstructs the agent's context before every decision.

**What it cost.**

- Everything the agent needs later has to be *in* an event, which forced the event schema to be genuinely complete rather than display-shaped — tool results carry full structured output, not a rendered summary.
- Streamed text needed a dual representation: a `text` block on disk that deltas merge into, plus `text.delta` frames on the wire carrying a `blockId`, plus matching merge logic on both sides. Roughly the whole of `store.appendDelta` and half the client reducer exist because of this.
- Context is reassembled and re-truncated on every turn instead of being appended once.
- Ordering and truncation semantics had to be exactly right, because a bug here corrupts the agent's memory rather than just the display.

**What the user gets.**

- **Rollback that actually means something.** Rewinding the trace rewinds the agent's mind. With an in-memory context, "roll back to step 2" would rewind the *display* while the agent still silently remembered the discarded work — the interface would be lying, which is the exact failure this product exists to avoid.
- **History that is not a summary.** A run reopened from history is byte-identical to the one you watched, because the live view and the replay consume the same records.
- **Survivable runs.** A resumed run picks up from the first incomplete step after a restart, because nothing important lived only in process memory.

A second decision in the same spirit, cheaper but worth naming: **pause waits for the in-flight step to finish** instead of aborting it. Aborting mid-tool-call is easier to implement and looks more responsive, but it leaves half-executed side effects — a file half written, an API called with no result recorded — and the user cannot reason about what actually happened. The cost is a pause that can take a few seconds; the benefit is that the trace never contains a step whose outcome is unknown.

---

## What I would add next to make a user trust the agent more

1. **Approval gates on write tools** — a per-tool "ask me first" toggle, so `write_file` or any future side-effecting tool pauses for confirmation with its exact parameters shown before it runs.
2. **Diffs on rollback** — show what is about to be discarded before the rewind happens, rather than after.
3. **Source-level provenance in the deliverable** — every claim hyperlinked back to the exact tool call in the trace that produced it, so "where did this come from" is one click, not a scroll.

---

## Project layout

```
server/
  src/
    agent/     runner.js (the loop) · controller.js (interruption) · llmEngine · scriptedEngine · prompts
    tools/     toolkit.js (typed schemas, timeouts, errors) · 6 tool implementations · index.js (registry)
    lib/       store.js (persistence) · bus.js (pub/sub) · llm.js (hand-written streaming client) · tagStream.js
    routes/    runs.js (REST + SSE)
  test/smoke.js
web/
  src/
    lib/       stream.js (hand-written SSE client) · trace.js (event reducer) · markdown.js · api.js
    components/ TracePanel · PlanPanel · ControlDock · Deliverable · RunSidebar · GoalComposer · ToolShelf
    styles.css
Dockerfile · render.yaml
```

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/meta` | Engine, model, tool registry with typed parameters, limits |
| `GET` | `/api/runs` | Run history |
| `POST` | `/api/runs` | Start a run — `{ goal }` |
| `GET` | `/api/runs/:id` | Full run: plan, event log, deliverable |
| `GET` | `/api/runs/:id/stream` | SSE — replay then live, `?from=<seq>` to resume |
| `POST` | `/api/runs/:id/pause` | Pause after the current step |
| `POST` | `/api/runs/:id/resume` | Resume — optional `{ plan, instruction }` |
| `POST` | `/api/runs/:id/plan` | Stage a plan edit |
| `POST` | `/api/runs/:id/instruct` | Add an instruction mid-run |
| `POST` | `/api/runs/:id/rollback` | Rewind to `{ stepIndex }` and re-run |
| `POST` | `/api/runs/:id/abandon` | Abandon |
| `DELETE` | `/api/runs/:id` | Delete a run |

## Deployment

Docker (any host):

```bash
docker build -t agent-console .
docker run -p 8787:8787 -e ANTHROPIC_API_KEY=sk-… -v $(pwd)/data:/app/data agent-console
```

Render: push the repo, pick **Blueprint**, `render.yaml` is already here — free tier, Docker runtime, persistent disk for run history, health check on `/api/health`. Fly.io and Railway both work from the same Dockerfile. The only required environment variable is `ANTHROPIC_API_KEY`, and even that is optional if you are happy with the scripted engine.

## Constraints honoured

- **No agent framework** — the loop, the controller, the tool registry and the model client are all written here.
- **No pre-built streaming chat UI** — the SSE client, the event reducer, the trace renderer and the markdown renderer are all in `web/src`. The only runtime dependencies are React and React DOM on the frontend, Express and CORS on the backend.
- **4+ real typed tools with graceful failure** — six, each with a typed schema, a timeout and a structured error envelope.
- **Streaming, not polling** — SSE, token-level, with an automated test that would fail a batched imitation.
