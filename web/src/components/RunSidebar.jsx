import { relativeTime, STATUS_COPY } from '../lib/format.js';

export default function RunSidebar({ runs, activeId, onSelect, onDelete, open }) {
  return (
    <aside className={`sidebar ${open ? 'is-open' : ''}`} aria-label="Run history">
      <div className="sidebar__head">
        <h2>Runs</h2>
        <span className="sidebar__count">{runs.length}</span>
      </div>

      {runs.length === 0 ? (
        <p className="sidebar__empty">No runs yet. Your first goal will appear here with its full trace.</p>
      ) : (
        <ol className="runlist">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                className={`runlist__item ${run.id === activeId ? 'is-active' : ''}`}
                onClick={() => onSelect(run.id)}
                aria-current={run.id === activeId}
              >
                <span className={`runlist__status is-${run.status}`}>{STATUS_COPY[run.status] ?? run.status}</span>
                <span className="runlist__goal">{run.goal}</span>
                <span className="runlist__meta">
                  {run.completedSteps}/{run.stepCount} steps · {run.toolCalls} tool calls · {relativeTime(run.createdAt)}
                </span>
              </button>
              <button className="runlist__delete" onClick={() => onDelete(run.id)} aria-label={`Delete run: ${run.goal}`}>
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
