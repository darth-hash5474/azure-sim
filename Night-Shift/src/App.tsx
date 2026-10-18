import React, { useEffect, useReducer, useRef } from 'react';
import ScratchPanel from './ScratchPanel';
import { SCRATCH } from './engine';
import { applyScratch, type ScratchAction } from './scratch';
import {
  DELETE_AT,
  audit,
  hhmm,
  initialGame,
  livePrompt,
  runCommand,
  silenced,
  type Game,
  type LineType,
} from './engine';
import TerminalInput from './TerminalInput';

const LINE_STYLES: Record<LineType, string> = {
  input: 'text-fg',
  output: 'text-dim',
  heading: 'text-accent/80 pt-2',
  error: 'text-err',
  success: 'text-ok',
  alert: 'text-warn',
};

type Action = { type: 'command'; text: string } | ScratchAction;

const reducer = (g: Game, a: Action): Game =>
  a.type === 'command' ? runCommand(g, a.text) : applyScratch(g, a, SCRATCH);

export default function NightShift(): React.JSX.Element {
  const [game, dispatch] = useReducer(reducer, undefined, initialGame);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game.history]);

  const checks = audit(game);
  const passing = checks.filter((c) => c.ok).length;
  const left = DELETE_AT - game.clock;
  const quiet = silenced(game);

  const verdict = game.solved
    ? { text: 'HANDED OVER', cls: 'text-ok', border: 'border-ok/60' }
    : game.lost
      ? { text: 'VM LOST', cls: 'text-err', border: 'border-err/60' }
      : { text: `ON CALL ${passing}/${checks.length}`, cls: 'text-warn', border: 'border-line' };

  const vmStatus =
    game.vm === 'running'
      ? { text: 'running', cls: 'text-ok' }
      : game.vm === 'restored'
        ? { text: 'restored', cls: 'text-ok' }
        : { text: 'DELETED', cls: 'text-err' };

  return (
    <div className="bg-grid min-h-screen flex flex-col text-[13px] leading-relaxed">
      <header className="border-b border-line bg-ink/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-12 flex items-center gap-4">
          <span className="flex items-center gap-2 font-bold tracking-[0.2em] text-fg">
            <span className="w-2 h-2 bg-accent" />
            NIGHT SHIFT
          </span>
          <span className="hidden sm:inline text-dim">// azure monitoring incident · level 06</span>
          <span className="ml-auto text-[11px] text-dim">
            rg <span className="text-fg">ops-rg</span>
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
            <span className="text-fg">az cli</span>
            <span className="ml-3 text-dim">metrics · logs · alerts · backup</span>
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

          <TerminalInput prompt={livePrompt(game)} inputRef={inputRef} onSubmit={(text) => dispatch({ type: 'command', text })} />
        </section>

        <ScratchPanel
          files={game.files}
          focus={game.focus}
          readonly={SCRATCH.readonly}
          defaultFile="query.kql"
          onWrite={(name, text) => dispatch({ type: 'write', name, text })}
          onFocus={(name) => dispatch({ type: 'focus', name })}
          hint={<>saves as you type · run a file with <span className="text-fg">--analytics-query @query.kql</span> · send JSON with <span className="text-fg">az rest --method put --url &lt;ARM path&gt; --body @alert.json</span> (every command still costs a minute) · resets on restart</>}
        />
        </div>

        <aside className="flex flex-col gap-4">
          <Panel title="the night">
            <div className="flex items-baseline justify-between">
              <span className="text-dim">clock</span>
              <span className="text-lg font-bold tabular-nums text-fg">{hhmm(game.clock)}</span>
            </div>
            <Row label="batch-vm deleted at">
              <span className={left > 0 && left <= 15 ? 'text-err' : 'text-warn'}>{hhmm(DELETE_AT)}</span>
              <span className="text-dim"> {left > 0 ? `· in ${left} min` : '· done'}</span>
            </Row>
            <Row label="pages sent to on-call">
              <span className={quiet || game.vm !== 'running' ? 'text-ok' : 'text-err'}>{game.pages}</span>
              <span className="text-dim">{quiet ? ' · silenced' : game.vm !== 'running' ? ' · stopped' : ' · rising'}</span>
            </Row>
          </Panel>

          <Panel title="handover review">
            <div className="space-y-1.5">
              {checks.map((c) => (
                <div key={c.label} className="flex items-center gap-3">
                  <span className={`w-4 text-center font-bold ${c.ok ? 'text-ok' : 'text-dim'}`}>{c.ok ? '✓' : '·'}</span>
                  <span className={`flex-1 ${c.ok ? 'text-fg' : 'text-dim'}`}>{c.label}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="estate">
            <Row label="batch-vm">
              <span className={vmStatus.cls}>{vmStatus.text}</span>
            </Row>
            <Row label="guest logs → law-ops">
              {game.dcrAssociatedAt === null ? (
                <span className="text-warn">not sending</span>
              ) : (
                <span className="text-ok">associated {hhmm(game.dcrAssociatedAt)}</span>
              )}
            </Row>
            <Row label="alert rules">{game.alerts.length}</Row>
            <Row label="processing rules">{game.procRules.length}</Row>
            <Row label="vaults">{game.vaults.map((v) => `${v.name} (${v.kind === 'rsv' ? 'RSV' : 'Backup'})`).join(', ')}</Row>
            <Row label="recovery points">{game.recoveryPoints.length}</Row>
          </Panel>

          <div className={`mt-auto border px-4 py-3 flex items-center justify-between text-[11px] tracking-widest ${verdict.border}`}>
            <span className="text-dim">INC-5530</span>
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
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-dim shrink-0">{label}</span>
      <span className="text-fg text-right">{children}</span>
    </div>
  );
}
