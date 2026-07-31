import { useState } from 'react';

export default function GoalComposer({ onSubmit, busy, status, goal }) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(!goal);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
    setOpen(false);
  };

  return (
    <section className="composer">
      {goal && !open ? (
        <div className="composer__current">
          <span className="eyebrow">Goal</span>
          <p className="composer__goal">{goal}</p>
          <button className="button button--ghost" onClick={() => setOpen(true)}>
            New goal
          </button>
        </div>
      ) : (
        <div className="composer__form">
          <label className="eyebrow" htmlFor="goal">
            What should the agent achieve?
          </label>
          <div className="composer__row">
            <textarea
              id="goal"
              rows={2}
              value={value}
              placeholder="e.g. Research how streaming APIs handle interruption and write me a one-page brief"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              }}
            />
            <button className="button button--primary" onClick={submit} disabled={!value.trim()}>
              Start run
            </button>
          </div>
          <p className="composer__hint">
            {busy ? `A run is ${status}. Starting a new goal leaves it running in the background.` : 'Cmd/Ctrl + Enter to start.'}
          </p>
        </div>
      )}
    </section>
  );
}
