import React, { useEffect, useReducer, useRef } from 'react';
import {
  PRINCIPALS,
  READONLY_FILES,
  SOURCE_RG,
  TAG_KEY,
  audit,
  initialGame,
  livePrompt,
  runCommand,
  SCRATCH,
  specOf,
  type Game,
  type LineType,
  type LockLevel,
} from './engine';
import TerminalInput, { ShellTabs } from './TerminalInput';
import { setMode, type Mode } from './shell';
import { setFile } from './scratch';

const LINE_STYLES: Record<LineType, string> = {
  input: 'text-fg',
  output: 'text-dim',
  heading: 'text-accent/80 pt-2',
  error: 'text-err',
  success: 'text-ok',
  alert: 'text-warn',
};

const LOCK_BADGE: Record<LockLevel | 'none', { text: string; cls: string }> = {
  ReadOnly: { text: 'RO', cls: 'text-ok border-ok/50' },
  CanNotDelete: { text: 'CND', cls: 'text-accent border-accent/50' },
  none: { text: '····', cls: 'text-dim border-line' },
};

type Action =
  | { type: 'command'; text: string }
  | { type: 'shell'; mode: Mode }
  | { type: 'write'; name: string; text: string }
  | { type: 'focus'; name: string };

const reducer = (g: Game, a: Action): Game =>
  a.type === 'command' ? runCommand(g, a.text) : a.type === 'shell' ? setMode(g, a.mode) : a.type === 'write' ? setFile(g, a.name, a.text, SCRATCH) : a.name in g.files ? { ...g, focus: a.name } : g;

export default function ManageResources(): React.JSX.Element {
  const [game, dispatch] = useReducer(reducer, undefined, initialGame);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game.history]);

  const checks = audit(game);
  const passing = checks.filter((c) => c.ok).length;
  const groupNames = Object.keys(game.groups).sort((a, b) => (a === SOURCE_RG ? -1 : b === SOURCE_RG ? 1 : a.localeCompare(b)));

  const effectiveLock = (rg: string): LockLevel | null => {
    const mine = game.locks.filter((l) => l.rg === rg);
    return mine.some((l) => l.level === 'ReadOnly') ? 'ReadOnly' : mine.length ? 'CanNotDelete' : null;
  };

  const fileNames = Object.keys(game.files);
  const openFile = game.focus && game.focus in game.files ? game.focus : fileNames.includes('tags.json') ? 'tags.json' : fileNames[0];
  const locked = READONLY_FILES.includes(openFile);
  const fileText = game.files[openFile] ?? '';
  let jsonState: { ok: boolean; msg: string } | null = null;
  if (openFile.endsWith('.json')) {
    try {
      JSON.parse(fileText);
      jsonState = { ok: true, msg: 'valid JSON' };
    } catch (e) {
      jsonState = { ok: false, msg: (e as Error).message };
    }
  }

  const verdict = game.solved
    ? { text: 'PASSED', cls: 'text-ok', border: 'border-ok/60' }
    : game.lost.length
      ? { text: `LOST ${game.lost.length}`, cls: 'text-err', border: 'border-err/60' }
      : { text: `OPEN ${passing}/${checks.length}`, cls: 'text-warn', border: 'border-line' };

  return (
    <div className="bg-grid min-h-screen flex flex-col text-[13px] leading-relaxed">
      <header className="border-b border-line bg-ink/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-12 flex items-center gap-4">
          <span className="flex items-center gap-2 font-bold tracking-[0.2em] text-fg">
            <span className="w-2 h-2 bg-accent" />
            MANAGE RESOURCES
          </span>
          <span className="hidden sm:inline text-dim">// azure cleanup drill · level 03</span>
          <span className="ml-auto text-[11px] text-dim">
            sub <span className="text-fg">contoso-prod</span>
          </span>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 flex flex-col gap-4">
        <section
          className="flex flex-col h-[620px] bg-panel border border-line"
          onClick={() => inputRef.current?.focus()}
        >
          <div className="h-9 px-3 flex items-center border-b border-line text-[11px]">
            <ShellTabs mode={game.sh.mode} onMode={(mode) => dispatch({ type: 'shell', mode })} />
            <span className="ml-3 text-dim">tags · moves · resource groups</span>
            <span className="ml-auto text-dim">↑↓ history · Shift+Enter new line</span>
          </div>

          <div className="flex-1 px-4 py-3 overflow-y-auto">
            {game.history.map((log, idx) => (
              <div key={idx} className={`whitespace-pre-wrap break-words ${LINE_STYLES[log.type]}`}>
                {log.text}
              </div>
            ))}
            <div ref={terminalEndRef} />
          </div>

          <TerminalInput prompt={livePrompt(game)} mode={game.sh.mode} inputRef={inputRef} onSubmit={(text) => dispatch({ type: 'command', text })} />
        </section>

        <section className="bg-panel border border-line">
          <div className="min-h-9 px-3 py-1.5 flex items-center gap-2 border-b border-line text-[11px] flex-wrap">
            <span className="text-dim shrink-0">~/scratch</span>
            {fileNames.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => dispatch({ type: 'focus', name: n })}
                className={`px-2 py-0.5 border shrink-0 focus:outline-none focus-visible:border-accent ${
                  n === openFile ? 'border-accent/60 text-fg' : 'border-line text-dim hover:text-fg'
                }`}
              >
                {n}
                {READONLY_FILES.includes(n) ? ' · ro' : ''}
              </button>
            ))}
            {jsonState && (
              <span className={`ml-auto truncate max-w-full ${jsonState.ok ? 'text-ok' : 'text-err'}`} title={jsonState.msg}>
                {jsonState.ok ? '✓ ' : '✗ '}
                {jsonState.msg}
              </span>
            )}
            {!jsonState && locked && <span className="ml-auto text-dim">read-only</span>}
          </div>
          <textarea
            aria-label={`Editor for ${openFile}`}
            value={fileText}
            readOnly={locked}
            onChange={(e) => dispatch({ type: 'write', name: openFile, text: e.target.value })}
            spellCheck={false}
            className="block w-full h-44 resize-y bg-transparent px-4 py-3 font-mono text-fg caret-accent focus:outline-none"
          />
          <div className="border-t border-line px-4 py-2 text-[11px] text-dim">
            saves as you type · feed it to the CLI with <span className="text-fg">--tags @tags.json</span> or <span className="text-fg">--ids @ids.json</span> · resets on restart
          </div>
        </section>
        </div>

        <aside className="flex flex-col gap-4">
          <Panel title="audit · FA-26-Q4">
            <div className="space-y-1.5">
              {checks.map((c) => (
                <div key={c.label} className="flex items-center gap-3">
                  <span className={`w-4 text-center font-bold ${c.ok ? 'text-ok' : 'text-dim'}`}>{c.ok ? '✓' : '·'}</span>
                  <span className={`flex-1 ${c.ok ? 'text-fg' : 'text-dim'}`}>{c.label}</span>
                  <span className={`tabular-nums text-[11px] ${c.ok ? 'text-ok' : c.label === 'Nothing lost' ? 'text-err' : 'text-dim'}`}>
                    {c.count}/{c.of}
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="estate">
            <div className="space-y-3">
              {groupNames.map((rg) => {
                const lock = LOCK_BADGE[effectiveLock(rg) ?? 'none'];
                const inGroup = game.resources.filter((r) => r.rg === rg);
                return (
                  <div key={rg} className="space-y-1">
                    <div className="flex items-center gap-3">
                      <span className={`w-10 text-center text-[10px] font-bold border ${lock.cls}`}>{lock.text}</span>
                      <span className="flex-1 text-fg font-bold truncate">{rg}</span>
                      <span className="text-[11px] text-dim">{inGroup.length} res</span>
                    </div>
                    {inGroup.map((r) => {
                      const cc = r.tags[TAG_KEY];
                      const spec = specOf(r.name);
                      const ccCls = cc === undefined ? 'text-dim' : cc === spec.cc ? 'text-ok' : 'text-err';
                      const misplaced = rg !== SOURCE_RG && rg !== spec.rg;
                      return (
                        <div key={r.name} className="flex items-center gap-3 pl-[52px]">
                          <span className="flex-1 text-dim truncate">└ {r.name}</span>
                          {misplaced && <span className="text-[10px] text-warn">wrong rg</span>}
                          <span className={`tabular-nums text-[11px] ${ccCls}`}>{cc ?? '····'}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {game.lost.length > 0 && <div className="text-err text-[11px]">lost: {game.lost.join(', ')}</div>}
            </div>
            <div className="mt-3 text-[10px] text-dim">
              <span className="text-accent">CND</span> CanNotDelete · <span className="text-ok">RO</span> ReadOnly · right column is {TAG_KEY}
            </div>
          </Panel>

          <Panel title="session">
            <Row label="principal">{game.user ?? '—'}</Row>
            <Row label="rbac role">{game.user ? PRINCIPALS[game.user].role : '—'}</Row>
          </Panel>

          <div className={`mt-auto border px-4 py-3 flex items-center justify-between text-[11px] tracking-widest ${verdict.border}`}>
            <span className="text-dim">AUDIT</span>
            <span className={`font-bold ${verdict.cls}`}>{verdict.text}</span>
          </div>
        </aside>
      </main>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-panel border border-line">
      <div className="px-4 h-8 flex items-center border-b border-line text-[10px] uppercase tracking-[0.2em] text-dim">
        <span className="text-accent mr-2">//</span>
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-dim">{label}</span>
      <span className="text-fg">{children}</span>
    </div>
  );
}
