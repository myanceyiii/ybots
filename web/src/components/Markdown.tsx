import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitRawOutput } from '@shared/raw-output';
import { useSimple } from '../lib/simple';
import { loadsOnItsOwn, safeLink } from '@shared/safe-url';

/** A code block with its language named and a Copy button. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const cls = ((children as { props?: { className?: string } } | undefined)?.props?.className ?? '') as string;
  const lang = /language-([\w+#-]+)/.exec(cls)?.[1];
  const copy = async () => {
    try { await navigator.clipboard.writeText(ref.current?.innerText ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard not allowed here */ }
  };
  return (
    <div className="md-code">
      <div className="md-code__bar">
        <span className="md-code__lang">{lang ?? 'code'}</span>
        <button type="button" className="md-code__copy" onClick={copy} aria-label="Copy code">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

/**
 * A picture on another site. Loading it on its own would send that site whatever the address carries
 * (a reply could put private words in it), so it shows as a button naming the site until tapped.
 */
function ExternalPicture({ src, alt }: { src: string; alt: string }) {
  const [shown, setShown] = useState(false);
  const link = safeLink(src);
  if (!link) return alt ? <span>{alt}</span> : null;
  if (shown) return <img src={link} alt={alt} loading="lazy" className="md-img" referrerPolicy="no-referrer" onClick={() => useStore.getState().set({ lightbox: { src: link, name: alt || 'Picture' } })} />;
  return (
    <button type="button" className="md-img-ask" onClick={() => setShown(true)} title={link}>
      Show picture from {new URL(link).hostname}{alt ? ` · ${alt}` : ''}
    </button>
  );
}

const components: Components = {
  pre: ({ node: _n, children }) => <CodeBlock>{children}</CodeBlock>,
  // A picture in an answer opens large on a click. One on another site waits for a tap (ExternalPicture).
  img: ({ node: _n, src, alt, ...props }) => {
    if (!src || typeof src !== 'string') return alt ? <span>{alt}</span> : null;
    if (!loadsOnItsOwn(src)) return <ExternalPicture src={src} alt={alt ?? ''} />;
    return <img {...props} src={src} alt={alt ?? ''} loading="lazy" className="md-img" onClick={() => useStore.getState().set({ lightbox: { src, name: alt || 'Picture' } })} />;
  },
  a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _n, ...props }) => (
    <div className="md-table"><table {...props} /></div>
  ),
};

/**
 * Assistant message markdown: headings, lists, tables, quotes, code. Raw tool output (JSON blobs,
 * logs, long dumps) is folded into a "details" row so the answer reads first.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Sam's view (lib/simple.ts) leaves raw tool output out: it is for whoever maintains the bot, not the answer.
  const simple = useSimple();
  const all = useMemo(() => splitRawOutput(text), [text]);
  const segments = simple && all.some((s) => s.kind === 'md' && s.text.trim()) ? all.filter((s) => s.kind === 'md') : all;
  return (
    <div className="md">
      {segments.map((s, i) => s.kind === 'md'
        ? <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={components}>{s.text}</ReactMarkdown>
        : (
          <details key={i} className="md-raw">
            <summary><span className="md-raw-label">{s.summary}</span><span className="md-raw-hint">Show</span></summary>
            <pre><code>{s.text}</code></pre>
          </details>
        ))}
    </div>
  );
});
