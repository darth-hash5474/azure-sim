import React from 'react';

interface Props {
  files: Record<string, string>;
  focus: string | null;
  readonly: string[];
  /** Tab shown when nothing has been opened yet. */
  defaultFile: string;
  onWrite: (name: string, text: string) => void;
  onFocus: (name: string) => void;
  hint: React.ReactNode;
}

/** The scratch-folder editor: one tab per file, edits save as you type, JSON files show a live validity line. */
export default function ScratchPanel({ files, focus, readonly, defaultFile, onWrite, onFocus, hint }: Props): React.JSX.Element {
  const names = Object.keys(files);
  const open = focus && focus in files ? focus : defaultFile in files ? defaultFile : names[0];
  const locked = readonly.includes(open);
  const text = files[open] ?? '';

  let json: { ok: boolean; msg: string } | null = null;
  if (open.endsWith('.json')) {
    try {
      JSON.parse(text);
      json = { ok: true, msg: 'valid JSON' };
    } catch (e) {
      json = { ok: false, msg: (e as Error).message };
    }
  }

  return (
    <section className="bg-panel border border-line">
      <div className="min-h-9 px-3 py-1.5 flex items-center gap-2 border-b border-line text-[11px] flex-wrap">
        <span className="text-dim shrink-0">~/scratch</span>
        {names.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onFocus(n)}
            className={`px-2 py-0.5 border shrink-0 focus:outline-none focus-visible:border-accent ${
              n === open ? 'border-accent/60 text-fg' : 'border-line text-dim hover:text-fg'
            }`}
          >
            {n}
            {readonly.includes(n) ? ' · ro' : ''}
          </button>
        ))}
        {json && (
          <span className={`ml-auto truncate max-w-full ${json.ok ? 'text-ok' : 'text-err'}`} title={json.msg}>
            {json.ok ? '✓ ' : '✗ '}
            {json.msg}
          </span>
        )}
        {!json && locked && <span className="ml-auto text-dim">read-only</span>}
      </div>
      <textarea
        aria-label={`Editor for ${open}`}
        value={text}
        readOnly={locked}
        onChange={(e) => onWrite(open, e.target.value)}
        spellCheck={false}
        className="block w-full h-44 resize-y bg-transparent px-4 py-3 font-mono text-fg caret-accent focus:outline-none"
      />
      <div className="border-t border-line px-4 py-2 text-[11px] text-dim">{hint}</div>
    </section>
  );
}
