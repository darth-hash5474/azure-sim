import React, { useState } from 'react';
import { needsMore } from './shell';

/** The multi-line prompt: Enter runs a finished command, keeps typing while a quote or \ is still open. */
export default function TerminalInput({
  prompt,
  onSubmit,
  inputRef,
}: {
  prompt: string;
  onSubmit: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [past, setPast] = useState<string[]>([]);
  const [recall, setRecall] = useState<number | null>(null);

  const submit = () => {
    const t = text.replace(/\s+$/, '');
    if (!t.trim()) return;
    setPast((p) => [...p, t]);
    setRecall(null);
    onSubmit(t);
    setText('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (!text.trim()) {
        e.preventDefault();
      } else if (e.ctrlKey || e.metaKey || !needsMore(text)) {
        e.preventDefault();
        submit();
      }
      return; // otherwise the browser adds the line break and the command continues
    }
    if (e.key === 'c' && e.ctrlKey && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
      e.preventDefault();
      setText('');
      setRecall(null);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const el = e.currentTarget;
      if (e.key === 'ArrowUp' && text.slice(0, el.selectionStart).includes('\n')) return;
      if (e.key === 'ArrowDown' && text.slice(el.selectionEnd).includes('\n')) return;
      if (past.length === 0) return;
      e.preventDefault();
      const last = past.length - 1;
      const next = e.key === 'ArrowUp' ? (recall === null ? last : Math.max(0, recall - 1)) : recall === null || recall >= last ? null : recall + 1;
      setRecall(next);
      setText(next === null ? '' : past[next]);
    }
  };

  const rows = Math.min(10, Math.max(1, text.split('\n').length));

  return (
    <div className="border-t border-line px-4 py-2.5 flex items-start gap-2">
      <span className="text-accent shrink-0 hidden sm:inline leading-relaxed">{prompt}</span>
      <span className="text-accent shrink-0 sm:hidden leading-relaxed">$</span>
      <textarea
        ref={inputRef}
        value={text}
        rows={rows}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="flex-1 min-w-0 bg-transparent focus:outline-none text-fg caret-accent placeholder:text-dim/50 resize-none leading-relaxed"
        placeholder="help"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoFocus
      />
    </div>
  );
}
