import { useState } from 'react';

export default function ControlDock({ status, stats, control, activeStep, plan }) {
  const [instruction, setInstruction] = useState('');
  const running = status === 'running' || status === 'planning';
  const paused = status === 'paused';
  const live = running || paused || status === 'queued';

  const sendInstruction = async () => {
    const text = instruction.trim();
    if (!text) return;
    await control.instruct(text);
    setInstruction('');
  };

  return (
    <section className="dock">
      <div className="dock__state">
        <span className={`pulse is-${status}`} aria-hidden="true" />
        <span className="dock__label">
          {running && activeStep !== null && plan[activeStep]
            ? `Step ${activeStep + 1} of ${plan.length} — ${plan[activeStep].title}`
            : running
              ? 'Working'
              : paused
                ? 'Paused. The step in flight finished; nothing new has started.'
                : status === 'completed'
                  ? 'Finished. The trace below is the complete record.'
                  : status === 'interrupted'
                    ? 'You abandoned this run.'
                    : status === 'failed'
                      ? 'The run failed. The trace shows where.'
                      : 'Waiting to start'}
        </span>
      </div>

      <div className="dock__actions">
        {running && (
          <button className="button" onClick={control.pause}>
            Pause
          </button>
        )}
        {paused && (
          <button className="button button--primary" onClick={() => control.resume()}>
            Resume
          </button>
        )}
        {live && (
          <button className="button button--danger" onClick={control.abandon}>
            Abandon
          </button>
        )}
        <span className="dock__stats">
          {stats.toolCalls} tool calls
          {stats.toolFailures > 0 && <em className="dock__fails"> · {stats.toolFailures} failed</em>}
        </span>
      </div>

      {live && (
        <div className="dock__instruct">
          <input
            value={instruction}
            placeholder={paused ? 'Add an instruction before you resume…' : 'Redirect the agent — applied at the next step boundary'}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendInstruction();
            }}
          />
          <button className="button button--ghost" onClick={sendInstruction} disabled={!instruction.trim()}>
            Send
          </button>
        </div>
      )}
    </section>
  );
}
