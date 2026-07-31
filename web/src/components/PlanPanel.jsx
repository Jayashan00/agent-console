import { useEffect, useState } from 'react';

/**
 * The plan is the contract between the user and the agent, so it is a first
 * class panel rather than a line in the log: it shows what will happen next,
 * it is directly editable the moment the agent is paused, and every finished
 * step carries the button that rewinds the run to it.
 */
export default function PlanPanel({ plan, status, activeStep, revision, onResumeWithPlan, onRollback }) {
  const paused = status === 'paused';
  const firstOpen = (() => {
    const i = plan.findIndex((step) => step.status !== 'done');
    return i === -1 ? plan.length : i;
  })();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [instruction, setInstruction] = useState('');

  useEffect(() => {
    if (!paused && editing) setEditing(false);
  }, [paused, editing]);

  const beginEdit = () => {
    setDraft(plan.slice(firstOpen).map((step) => ({ title: step.title, detail: step.detail ?? '', tool: step.tool ?? null })));
    setEditing(true);
  };

  const apply = () => {
    const cleaned = draft.map((s) => ({ ...s, title: s.title.trim() })).filter((s) => s.title);
    if (!cleaned.length) return;
    onResumeWithPlan(cleaned, instruction.trim() || undefined);
    setEditing(false);
    setInstruction('');
  };

  return (
    <section className="pane pane--plan">
      <header className="pane__head">
        <h2>Plan</h2>
        <span className="pane__rev">rev {revision || 1}</span>
      </header>

      {plan.length === 0 ? (
        <p className="pane__empty">The agent writes its plan before it touches a tool. It will appear here first.</p>
      ) : editing ? (
        <div className="planedit">
          <p className="planedit__note">
            Steps 1–{firstOpen} are done and stay in the record. Everything below is yours to rewrite.
          </p>
          {draft.map((step, i) => (
            <div className="planedit__row" key={i}>
              <span className="planedit__num">{firstOpen + i + 1}</span>
              <div className="planedit__fields">
                <input
                  value={step.title}
                  placeholder="What should this step do?"
                  onChange={(e) => setDraft(draft.map((s, j) => (i === j ? { ...s, title: e.target.value } : s)))}
                />
                <input
                  className="planedit__detail"
                  value={step.detail}
                  placeholder="Detail (optional)"
                  onChange={(e) => setDraft(draft.map((s, j) => (i === j ? { ...s, detail: e.target.value } : s)))}
                />
              </div>
              <button className="icon-button" aria-label={`Remove step ${firstOpen + i + 1}`} onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button className="button button--ghost" onClick={() => setDraft([...draft, { title: '', detail: '', tool: null }])}>
            Add a step
          </button>
          <input
            className="planedit__instruction"
            value={instruction}
            placeholder="Optional instruction to send with the new plan…"
            onChange={(e) => setInstruction(e.target.value)}
          />
          <div className="planedit__actions">
            <button className="button button--primary" onClick={apply} disabled={!draft.some((s) => s.title.trim())}>
              Resume with this plan
            </button>
            <button className="button button--ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <ol className="plan">
            {plan.map((step, i) => (
              <li key={step.id ?? i} className={`plan__step is-${step.status} ${activeStep === i ? 'is-active' : ''}`}>
                <span className="plan__marker" aria-hidden="true" />
                <div className="plan__body">
                  <p className="plan__title">
                    <span className="plan__num">{i + 1}</span>
                    {step.title}
                    {step.origin === 'user' && <span className="tag tag--user">yours</span>}
                  </p>
                  {step.detail && <p className="plan__detail">{step.detail}</p>}
                  {step.summary && <p className="plan__summary">{step.summary}</p>}
                  {step.status === 'done' && (
                    <button className="linklike" onClick={() => onRollback(i)}>
                      Rerun from here
                    </button>
                  )}
                </div>
                {step.tool && <code className="plan__tool">{step.tool}</code>}
              </li>
            ))}
          </ol>

          {paused && (
            <button className="button button--primary plan__edit" onClick={beginEdit}>
              Edit remaining steps
            </button>
          )}
        </>
      )}
    </section>
  );
}
