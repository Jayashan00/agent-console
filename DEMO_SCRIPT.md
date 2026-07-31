# Demo video script — 2 to 3 minutes

Record at 1440×900 or larger, browser zoom 100%. Have one completed run already in history before you hit record, so the sidebar is not empty. Speak over it; no captions needed.

---

## 0:00 – 0:20 — What this is

> "This is Agent Console. You give an agent a goal, and you watch it work — the plan before it runs, every tool call as it happens, and you can stop it at any point."

Show the empty-goal screen. Point at the header chips: the tool count, the engine, and the green **stream live** dot.

Click the **tools** chip for three seconds — show the six typed tool interfaces — then close it.

> "Six real tools. Each one declares its parameter types once on the server, and that same declaration validates the agent's arguments and renders what you see in the trace."

---

## 0:20 – 1:05 — A complete run

Paste this goal and hit **Start run**:

```
Compare how SSE and WebSockets differ for streaming AI output, and recommend one for a chat product
```

Do not cut. Let it stream.

> "The plan comes first — nothing has executed yet. Now it's reasoning, and that text is arriving token by token, not a chunk at the end."

As the first tool card appears:

> "Here's the tool call. Name, typed parameters, and a live progress line — it's telling me it's requesting Wikipedia, not just spinning."

When a result lands, click **Expand full result**.

> "The full structured result, straight from the tool."

If a tool fails on camera, stay on it — that's a feature, not a blooper:

> "That one failed, and the run didn't. The agent gets the error message and decides what to do next."

---

## 1:05 – 1:50 — Interruption and redirect

Hit **Pause** mid-run.

> "Pause. The step it's in finishes — I don't want a half-written file — but no new step begins."

Point at the plan panel status, then click **Edit remaining steps**.

> "The finished steps stay in the record. Everything below is mine to rewrite."

Change one step's title to something visibly different, delete one step, and type an instruction:

```
Keep the final answer under 200 words and lead with the recommendation.
```

Click **Resume with this plan**.

> "And those edits are actually honoured — the plan update is in the trace, attributed to me, and the agent's next turn sees my instruction."

Point at the amber `yours` tags and the amber marker in the trace.

Let it finish. When the deliverable tab lights up, open it.

> "The deliverable is rendered separately from the trace — copyable, downloadable, nothing to scroll past."

---

## 1:50 – 2:25 — Rollback and history

On a completed step in the plan panel, click **Rerun from here**.

> "And if I decide a step was wrong, I roll back to it. The trace after that point is discarded — you can see the cut — and it re-runs from there. That's not just a display rewind: the agent's memory is rebuilt from the trace, so it doesn't remember the work I just threw away."

Open the sidebar and click an older run.

> "Every run is persisted with its full trace. Opening one from history replays exactly what I'd have watched live — same events, same order."

Scroll the replayed trace briefly.

---

## 2:25 – 2:40 — Close

> "No agent framework, no streaming UI library — the loop, the SSE transport and the trace renderer are all in the repo. There's a smoke test that boots the real server and asserts the guarantees: that streaming isn't batched, that pause actually holds, and that plan edits are honoured."

Optionally show the terminal:

```bash
npm run smoke --prefix server
```

End on the green check list.

---

## Recording notes

- Run with `ANTHROPIC_API_KEY` set — model-written reasoning demos better than the scripted engine.
- Bump `AGENT_MAX_TOOL_CALLS_PER_STEP=2` if you want a tighter run for time.
- Pause **during** a tool call, not between steps, so the "the current step finishes" behaviour is visible.
- If a run finishes before you can pause it, start one with a broader goal.
