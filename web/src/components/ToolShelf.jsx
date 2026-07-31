import { useEffect } from 'react';

/** The typed tool interfaces, straight from the server registry — one source of truth. */
export default function ToolShelf({ tools, limits, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="shelf" role="dialog" aria-modal="true" aria-label="Tools">
      <div className="shelf__scrim" onClick={onClose} />
      <div className="shelf__panel">
        <header className="shelf__head">
          <h2>Tools</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <p className="shelf__note">
          Every tool declares its parameter types once on the server. The same declaration validates the agent's
          arguments, builds the prompt, and renders the parameter list you see in the trace.
        </p>
        {limits && (
          <p className="shelf__limits">
            Up to {limits.maxToolCallsPerStep} tool calls per step · {limits.maxSteps} steps per run ·{' '}
            {Math.round(limits.toolTimeoutMs / 1000)}s tool timeout
          </p>
        )}
        <ul className="shelf__list">
          {tools.map((tool) => (
            <li key={tool.name}>
              <p className="shelf__name">
                <code>{tool.name}</code>
                <span className="shelf__cat">{tool.category}</span>
              </p>
              <p className="shelf__desc">{tool.description}</p>
              <ul className="shelf__params">
                {tool.parameters.map((param) => (
                  <li key={param.name}>
                    <code>
                      {param.name}: {param.type}
                    </code>
                    <span className={param.required ? 'req' : 'opt'}>{param.required ? 'required' : 'optional'}</span>
                    <span className="shelf__pdesc">{param.description}</span>
                  </li>
                ))}
              </ul>
              <p className="shelf__returns">returns: {tool.returns}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
