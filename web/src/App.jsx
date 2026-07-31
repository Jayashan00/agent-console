import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from './lib/api.js';
import { openRunStream } from './lib/stream.js';
import { initialTraceState, traceReducer } from './lib/trace.js';
import RunSidebar from './components/RunSidebar.jsx';
import GoalComposer from './components/GoalComposer.jsx';
import ControlDock from './components/ControlDock.jsx';
import PlanPanel from './components/PlanPanel.jsx';
import TracePanel from './components/TracePanel.jsx';
import Deliverable from './components/Deliverable.jsx';
import ToolShelf from './components/ToolShelf.jsx';
import { STATUS_COPY } from './lib/format.js';

const LIVE = new Set(['queued', 'planning', 'running', 'paused']);

export default function App() {
  const [meta, setMeta] = useState(null);
  const [runs, setRuns] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [trace, dispatch] = useReducer(traceReducer, initialTraceState);
  const [streamStatus, setStreamStatus] = useState('idle');
  const [tab, setTab] = useState('trace');
  const [banner, setBanner] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const closeStream = useRef(null);

  const notify = useCallback((message, tone = 'info') => {
    setBanner({ message, tone, at: Date.now() });
  }, []);

  useEffect(() => {
    if (!banner) return undefined;
    const timer = setTimeout(() => setBanner(null), 5000);
    return () => clearTimeout(timer);
  }, [banner]);

  const refreshRuns = useCallback(async () => {
    try {
      const { runs: list } = await api.listRuns();
      setRuns(list);
      return list;
    } catch (err) {
      notify(err.message, 'error');
      return [];
    }
  }, [notify]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [metaRes, list] = await Promise.all([api.meta(), api.listRuns()]);
        if (cancelled) return;
        setMeta(metaRes);
        setRuns(list.runs);
        if (list.runs.length) setActiveId(list.runs[0].id);
      } catch (err) {
        if (!cancelled) notify(`Cannot reach the API. ${err.message}`, 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  /* Open one stream per selected run; replay then live, always from seq 0. */
  useEffect(() => {
    closeStream.current?.();
    closeStream.current = null;
    if (!activeId) {
      dispatch({ type: 'clear' });
      setStreamStatus('idle');
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const { run } = await api.getRun(activeId);
        if (cancelled) return;
        dispatch({ type: 'hydrate', run: { ...run, events: [], deliverable: '' } });
        setTab('trace');
        // Replayed history must not hijack the view; only live events do.
        let caughtUp = false;
        closeStream.current = openRunStream(activeId, {
          onEvent: (event) => {
            dispatch({ type: 'event', event });
            if (event.type === 'stream.caughtUp') caughtUp = true;
            if (event.type === 'run.completed' || event.type === 'plan.created' || event.type === 'run.status') {
              refreshRuns();
            }
            if (caughtUp && event.type === 'deliverable.ready') setTab('deliverable');
          },
          onStatus: setStreamStatus,
        });
      } catch (err) {
        if (!cancelled) notify(err.message, 'error');
      }
    })();

    return () => {
      cancelled = true;
      closeStream.current?.();
      closeStream.current = null;
    };
  }, [activeId, notify, refreshRuns]);

  const startRun = useCallback(
    async (goal) => {
      try {
        const { run } = await api.createRun(goal);
        await refreshRuns();
        setActiveId(run.id);
        setSidebarOpen(false);
      } catch (err) {
        notify(err.message, 'error');
      }
    },
    [notify, refreshRuns],
  );

  const control = useMemo(
    () => ({
      pause: async () => {
        try {
          const res = await api.pause(activeId);
          notify(res.message);
        } catch (err) {
          notify(err.message, 'error');
        }
      },
      resume: async (payload) => {
        try {
          const res = await api.resume(activeId, payload ?? {});
          notify(res.message);
        } catch (err) {
          notify(err.message, 'error');
        }
      },
      instruct: async (instruction) => {
        try {
          const res = await api.instruct(activeId, instruction);
          notify(res.message);
        } catch (err) {
          notify(err.message, 'error');
        }
      },
      abandon: async () => {
        try {
          const res = await api.abandon(activeId);
          notify(res.message);
          refreshRuns();
        } catch (err) {
          notify(err.message, 'error');
        }
      },
      rollback: async (stepIndex) => {
        try {
          const res = await api.rollback(activeId, stepIndex);
          notify(res.message);
          setTab('trace');
        } catch (err) {
          notify(err.message, 'error');
        }
      },
      remove: async (id) => {
        try {
          await api.deleteRun(id);
          const list = await refreshRuns();
          if (id === activeId) setActiveId(list[0]?.id ?? null);
        } catch (err) {
          notify(err.message, 'error');
        }
      },
    }),
    [activeId, notify, refreshRuns],
  );

  const isLive = LIVE.has(trace.status);
  const hasRun = Boolean(activeId);

  return (
    <div className={`shell ${sidebarOpen ? 'shell--drawer' : ''}`}>
      <header className="topbar">
        <button className="icon-button topbar__menu" onClick={() => setSidebarOpen((v) => !v)} aria-label="Toggle run history">
          <span />
          <span />
          <span />
        </button>

        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <i />
            <i />
          </span>
          <span className="brand__name">Agent Console</span>
        </div>

        <div className="topbar__meta">
          <button className="chip chip--button" onClick={() => setShelfOpen(true)}>
            {meta ? `${meta.tools.length} tools` : 'tools'}
          </button>
          <span className={`chip chip--engine ${meta?.modelConfigured ? 'is-model' : 'is-scripted'}`}>
            {meta ? (meta.modelConfigured ? meta.model : 'scripted engine') : 'connecting…'}
          </span>
          <span className={`chip chip--stream is-${streamStatus}`}>
            <i className="dot" />
            {streamStatus === 'live' ? 'stream live' : streamStatus}
          </span>
        </div>
      </header>

      {banner && (
        <div className={`banner banner--${banner.tone}`} role="status">
          {banner.message}
        </div>
      )}

      <div className="body">
        <RunSidebar
          runs={runs}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id);
            setSidebarOpen(false);
          }}
          onDelete={control.remove}
          open={sidebarOpen}
        />

        <main className="workspace">
          <GoalComposer onSubmit={startRun} busy={isLive && hasRun} status={trace.status} goal={trace.goal} />

          {!hasRun ? (
            <EmptyState onPick={startRun} />
          ) : (
            <>
              <ControlDock status={trace.status} stats={trace.stats} control={control} activeStep={trace.activeStep} plan={trace.plan} />

              <section className="panes">
                <PlanPanel
                  plan={trace.plan}
                  status={trace.status}
                  activeStep={trace.activeStep}
                  revision={trace.planRevision}
                  onResumeWithPlan={(plan, instruction) => control.resume({ plan, instruction })}
                  onRollback={control.rollback}
                />

                <section className="pane pane--stream">
                  <div className="pane__tabs" role="tablist">
                    <button role="tab" aria-selected={tab === 'trace'} className={tab === 'trace' ? 'is-active' : ''} onClick={() => setTab('trace')}>
                      Execution trace
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === 'deliverable'}
                      className={tab === 'deliverable' ? 'is-active' : ''}
                      onClick={() => setTab('deliverable')}
                    >
                      Deliverable
                      {trace.deliverable ? <span className="tab-dot" /> : null}
                    </button>
                    <span className="pane__status">{STATUS_COPY[trace.status] ?? trace.status}</span>
                  </div>

                  {tab === 'trace' ? (
                    <TracePanel trace={trace} live={isLive} onRollback={control.rollback} />
                  ) : (
                    <Deliverable
                      markdown={trace.deliverable}
                      streaming={trace.deliverableStreaming}
                      goal={trace.goal}
                      status={trace.status}
                    />
                  )}
                </section>
              </section>
            </>
          )}
        </main>
      </div>

      {shelfOpen && <ToolShelf tools={meta?.tools ?? []} limits={meta?.limits} onClose={() => setShelfOpen(false)} />}
    </div>
  );
}

const SUGGESTIONS = [
  'Compare how SSE and WebSockets differ for streaming AI output, and recommend one for a chat product',
  'Research the Model Context Protocol and write a short brief for an engineering team',
  'Find the current weather in Colombo and tell me whether to move an outdoor event',
];

function EmptyState({ onPick }) {
  return (
    <div className="empty">
      <p className="empty__lead">Give the agent a goal. You will see the plan before anything runs.</p>
      <ul className="empty__list">
        {SUGGESTIONS.map((goal) => (
          <li key={goal}>
            <button onClick={() => onPick(goal)}>{goal}</button>
          </li>
        ))}
      </ul>
      <p className="empty__note">
        Every step below is real: real search providers, real page fetches, real files on disk, real code execution.
      </p>
    </div>
  );
}
