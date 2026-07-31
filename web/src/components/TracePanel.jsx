import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clockTime, duration, pretty } from '../lib/format.js';

/**
 * The trace spine.
 *
 * Everything the agent does hangs off one vertical rail in the order it
 * happened, and each kind of event gets its own colour, glyph and shape:
 * plans are violet blocks, reasoning is quiet graphite prose, tool calls are
 * teal cards with their typed parameters visible, results are green or red,
 * and anything the user did cuts across the rail so you can see who changed
 * the run and when. Reading top to bottom should answer "what did it do, why,
 * and what came back" without opening anything.
 */
export default function TracePanel({ trace, live, onRollback }) {
  const scroller = useRef(null);
  const [stick, setStick] = useState(true);

  useLayoutEffect(() => {
    if (!stick || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [trace.nodes, stick]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  return (
    <div className="trace" ref={scroller} onScroll={onScroll}>
      {trace.nodes.length === 0 && (
        <p className="trace__empty">
          {live ? 'Connected. The first thing you will see is the plan.' : 'This run has no recorded events.'}
        </p>
      )}

      <ol className="spine">
        {trace.nodes.map((node) => (
          <TraceNode key={node.id} node={node} onRollback={onRollback} />
        ))}
        {live && <li className="spine__playhead" aria-hidden="true" />}
      </ol>

      {!stick && (
        <button className="trace__jump" onClick={() => setStick(true)}>
          Jump to live ↓
        </button>
      )}
    </div>
  );
}

function TraceNode({ node, onRollback }) {
  switch (node.kind) {
    case 'plan':
      return <PlanNode node={node} />;
    case 'step':
      return <StepNode node={node} onRollback={onRollback} />;
    case 'text':
      return <TextNode node={node} />;
    case 'tool':
      return <ToolNode node={node} />;
    case 'rollback':
      return <RollbackNode node={node} />;
    case 'control':
      return <ControlNode node={node} />;
    case 'phase':
      return <PhaseNode node={node} />;
    default:
      return null;
  }
}

function PhaseNode({ node }) {
  return (
    <li className="node node--phase" data-channel="phase">
      <span className="node__glyph" aria-hidden="true" />
      <div className="node__body">
        <p className="node__phase">{node.message}</p>
      </div>
    </li>
  );
}

function PlanNode({ node }) {
  return (
    <li className="node node--plan" data-channel="plan">
      <span className="node__glyph" aria-hidden="true" />
      <div className="node__body">
        <p className="node__head">
          <strong>{node.by === 'user' ? 'You rewrote the plan' : node.revision > 1 ? 'The agent replanned' : 'Plan'}</strong>
          <span className="node__time">{clockTime(node.at)}</span>
        </p>
        {node.reason && <p className="node__reason">{node.reason}</p>}
        <ol className="node__plan">
          {node.steps.map((step, i) => (
            <li key={step.id ?? i}>
              <span className="node__plannum">{i + 1}</span>
              {step.title}
              {step.tool && <code>{step.tool}</code>}
            </li>
          ))}
        </ol>
      </div>
    </li>
  );
}

function StepNode({ node, onRollback }) {
  return (
    <li className={`node node--step is-${node.status}`} data-channel="step">
      <span className="node__glyph" aria-hidden="true">
        {node.stepIndex + 1}
      </span>
      <div className="node__body">
        <p className="node__head">
          <strong>{node.title}</strong>
          <span className="node__time">{clockTime(node.at)}</span>
        </p>
        {node.detail && <p className="node__detail">{node.detail}</p>}
        {node.summary && <p className="node__summary">{node.summary}</p>}
        {node.status === 'done' && (
          <button className="linklike" onClick={() => onRollback(node.stepIndex)}>
            Rerun from this step
          </button>
        )}
      </div>
    </li>
  );
}

function TextNode({ node }) {
  const label = node.channel === 'planning' ? 'Thinking about the goal' : 'Reasoning';
  return (
    <li className={`node node--text is-${node.channel}`} data-channel={node.channel}>
      <span className="node__glyph" aria-hidden="true" />
      <div className="node__body">
        <p className="node__label">{label}</p>
        <p className="node__prose">
          {node.text}
          {node.streaming && <span className="caret" aria-hidden="true" />}
        </p>
      </div>
    </li>
  );
}

function ToolNode({ node }) {
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const running = node.state === 'running';

  useEffect(() => {
    if (!running) return undefined;
    const started = new Date(node.startedAt).getTime();
    const timer = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, [running, node.startedAt]);

  const params = Object.entries(node.input ?? {});
  const lastProgress = node.progress?.[node.progress.length - 1];

  return (
    <li className={`node node--tool is-${node.state}`} data-channel="tool">
      <span className="node__glyph" aria-hidden="true" />
      <div className="node__body">
        <p className="node__head">
          <code className="tool__sig">{node.signature}</code>
          <span className={`tool__state is-${node.state}`}>
            {running ? `running ${duration(elapsed)}` : node.state === 'ok' ? `ok · ${duration(node.durationMs)}` : `failed · ${duration(node.durationMs)}`}
          </span>
        </p>
        <p className="tool__title">
          {node.title}
          <span className="tool__category">{node.category}</span>
        </p>

        {params.length > 0 && (
          <dl className="tool__params">
            {params.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{truncateValue(value)}</dd>
              </div>
            ))}
          </dl>
        )}

        {running && (
          <p className="tool__progress">
            <span className="tool__spark" aria-hidden="true" />
            {lastProgress ? lastProgress.message : 'Starting…'}
          </p>
        )}

        {node.state === 'failed' && node.error && (
          <div className="tool__error">
            <p className="tool__errorhead">
              {node.error.kind}
              {node.error.retriable ? <span className="tag">recoverable</span> : <span className="tag tag--hard">not recoverable</span>}
            </p>
            <p>{node.error.message}</p>
            <p className="tool__errorfoot">The run continues — the agent sees this message and decides what to do next.</p>
          </div>
        )}

        {node.state === 'ok' && (
          <div className={`tool__result ${open ? 'is-open' : ''}`}>
            <pre>{pretty(node.output)}</pre>
            <button className="linklike" onClick={() => setOpen((v) => !v)}>
              {open ? 'Collapse result' : 'Expand full result'}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function RollbackNode({ node }) {
  return (
    <li className="node node--rollback" data-channel="rollback">
      <span className="node__glyph" aria-hidden="true" />
      <div className="node__body">
        <p className="node__head">
          <strong>Rolled back to step {node.stepIndex + 1}</strong>
          <span className="node__time">{clockTime(node.at)}</span>
        </p>
        <p className="node__detail">{node.message}</p>
      </div>
    </li>
  );
}

function ControlNode({ node }) {
  const label =
    node.tone === 'pause'
      ? 'Paused by you'
      : node.tone === 'resume'
        ? 'Resumed'
        : node.tone === 'instruction'
          ? 'Your instruction'
          : node.tone === 'error'
            ? 'Run failed'
            : node.tone === 'warn'
              ? 'Degraded'
              : 'Note';
  return (
    <li className={`node node--control is-${node.tone}`} data-channel="control">
      <span className="node__glyph" aria-hidden="true" />
      <div className="node__body">
        <p className="node__head">
          <strong>{label}</strong>
          <span className="node__time">{clockTime(node.at)}</span>
        </p>
        <p className="node__detail">{node.message}</p>
      </div>
    </li>
  );
}

function truncateValue(value) {
  const text = typeof value === 'string' ? value : pretty(value);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}
