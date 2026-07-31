import { useMemo, useState } from 'react';
import { renderMarkdown } from '../lib/markdown.js';

export default function Deliverable({ markdown, streaming, goal, status }) {
  const [view, setView] = useState('formatted');
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(goal || 'deliverable').slice(0, 60).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!markdown) {
    return (
      <div className="deliverable deliverable--empty">
        <p>
          {status === 'completed'
            ? 'This run produced no deliverable.'
            : 'The deliverable is written once the plan finishes. It stays separate from the trace so you can take it away on its own.'}
        </p>
      </div>
    );
  }

  return (
    <div className="deliverable">
      <div className="deliverable__bar">
        <div className="deliverable__views">
          <button className={view === 'formatted' ? 'is-active' : ''} onClick={() => setView('formatted')}>
            Formatted
          </button>
          <button className={view === 'markdown' ? 'is-active' : ''} onClick={() => setView('markdown')}>
            Markdown
          </button>
        </div>
        <div className="deliverable__actions">
          {streaming && <span className="deliverable__writing">writing…</span>}
          <button className="button button--ghost" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="button button--ghost" onClick={download}>
            Download .md
          </button>
        </div>
      </div>

      {view === 'formatted' ? (
        <article className="deliverable__doc md" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="deliverable__raw">{markdown}</pre>
      )}
    </div>
  );
}
