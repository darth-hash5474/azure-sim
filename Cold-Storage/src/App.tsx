import React, { useEffect, useReducer, useRef } from 'react';
import {
  ACCOUNT,
  APP_IDS,
  TICKETS,
  appProblem,
  initialGame,
  livePrompt,
  inspectSas,
  keyInUse,
  runCommand,
  type AppId,
  type Game,
  type LineType,
} from './engine';
import ScratchPanel from './ScratchPanel';
import { SCRATCH } from './engine';
import TerminalInput, { ShellTabs } from './TerminalInput';
import { setMode, type Mode } from './shell';
import { applyScratch, type ScratchAction } from './scratch';

const LINE_STYLES: Record<LineType, string> = {
  input: 'text-fg',
  output: 'text-dim',
  heading: 'text-accent/80 pt-2',
  error: 'text-err',
  success: 'text-ok',
  alert: 'text-warn',
};
type Action = string | { type: 'shell'; mode: Mode } | ScratchAction;

const reducer = (g: Game, a: Action): Game =>
  typeof a === 'string' ? runCommand(g, a) : a.type === 'shell' ? setMode(g, a.mode) : applyScratch(g, a, SCRATCH);

export default function ColdStorage(): React.JSX.Element {
  const [game, dispatch] = useReducer(reducer, undefined, initialGame);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game.history]);

  const over = game.ticket >= TICKETS.length;
  const current = TICKETS[game.ticket];
  const closed = game.status.filter((s) => s === 'closed').length;
  const reopens = game.reopens.reduce((a, b) => a + b, 0);
  const finance = game.shares.finance;
  const partner = game.sas.find((s) => s.id === game.partnerSas);

  const appStatus = (app: AppId) => {
    const p = appProblem(game, app);
    return p ? <span className="text-err">{p === 'stale key' ? 'DOWN · stale key' : 'DOWN · firewalled'}</span> : <span className="text-ok">up · {keyInUse(game, app)}</span>;
  };

  const verdict = over
    ? closed === TICKETS.length
      ? { text: reopens ? 'ALL CLOSED' : 'FLAWLESS', cls: 'text-ok', border: 'border-ok/60' }
      : { text: `FAILED ${TICKETS.length - closed}`, cls: 'text-err', border: 'border-err/60' }
    : { text: `${closed}/${TICKETS.length} CLOSED`, cls: 'text-accent', border: 'border-line' };

  return (
    <div className="bg-grid min-h-screen flex flex-col text-[13px] leading-relaxed">
      <header className="border-b border-line bg-ink/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-12 flex items-center gap-4">
          <span className="flex items-center gap-2 font-bold tracking-[0.2em] text-fg">
            <span className="w-2 h-2 bg-accent" />
            COLD STORAGE
          </span>
          <span className="hidden sm:inline text-dim">// storage ops shift · level 03</span>
          <span className="ml-auto text-[11px] text-dim">
            account <span className="text-fg">{ACCOUNT}</span>
          </span>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 flex flex-col gap-4">
        <section
          className="flex flex-col h-[680px] bg-panel border border-line"
          onClick={() => inputRef.current?.focus()}
        >
          <div className="h-9 px-3 flex items-center border-b border-line text-[11px]">
            <ShellTabs mode={game.sh.mode} onMode={(mode) => dispatch({ type: 'shell', mode })} />
            <span className="ml-3 text-dim">azure storage</span>
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

          <TerminalInput prompt={livePrompt(game)} mode={game.sh.mode} inputRef={inputRef} onSubmit={(text) => dispatch(text)} />
        </section>

        <ScratchPanel
          files={game.files}
          focus={game.focus}
          readonly={SCRATCH.readonly}
          defaultFile="logs-v2.json"
          onWrite={(name, text) => dispatch({ type: 'write', name, text })}
          onFocus={(name) => dispatch({ type: 'focus', name })}
          hint={<>saves as you type · apply a file with <span className="text-fg">az storage account management-policy create --account-name contosodata -g data-rg --policy @logs-v2.json</span> · the policy is checked as it was when applied · resets on restart</>}
        />
        </div>

        <aside className="flex flex-col gap-4">
          <Panel title={over ? 'shift complete' : `open ticket · ${current.id}`}>
            {over ? (
              <div className="text-dim">All tickets handled. Read the debrief, or type "restart".</div>
            ) : (
              <>
                <div className="font-bold tracking-[0.1em] uppercase text-ok text-glow">{current.title}</div>
                <ul className="mt-2 space-y-0.5">
                  {current.reqs.map((r) => (
                    <li key={r} className="flex gap-2">
                      <span className="text-accent">+</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 text-[11px] text-dim">submit · hint · skip</div>
              </>
            )}
          </Panel>

          <Panel title="queue">
            <div className="space-y-0.5">
              {TICKETS.map((t, i) => {
                const s = game.status[i];
                const active = i === game.ticket;
                const mark = active ? { t: '▸', c: 'text-accent' } : s === 'closed' ? { t: '✓', c: 'text-ok' } : s === 'skipped' ? { t: '✗', c: 'text-err' } : { t: '·', c: 'text-dim' };
                return (
                  <div key={t.id} className={`flex gap-2 ${active ? 'text-fg' : 'text-dim'}`}>
                    <span className={`w-3 ${mark.c}`}>{mark.t}</span>
                    <span className="shrink-0">{t.id}</span>
                    <span className="truncate">{t.title}</span>
                    {game.reopens[i] > 0 && <span className="ml-auto shrink-0 text-warn">↺{game.reopens[i]}</span>}
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title={ACCOUNT}>
            <Row label="redundancy">{game.sku.replace('Standard_', '')}</Row>
            <Row label="container soft delete">{game.containerRetention ? `${game.containerRetention}d` : <span className="text-warn">off</span>}</Row>
            <Row label="lifecycle">{game.lifecycle ?? '—'}</Row>
            <Row label="share finance">{finance ? `${finance.quota} GiB · ${finance.tier}` : '—'}</Row>
            <Row label="firewall">
              {game.defaultAction === 'Allow' ? (
                <span className="text-warn">open</span>
              ) : (
                `deny · ${game.ipRules.length} ip · ${game.subnetRule ? 1 : 0} vnet`
              )}
            </Row>
            <Row label="partner SAS">
              {partner ? (inspectSas(game, partner).problem ? <span className="text-ok">dead</span> : <span className="text-warn">live</span>) : '—'}
            </Row>
            <div className="mt-2 pt-2 border-t border-line">
              {APP_IDS.map((app) => (
                <Row key={app} label={app}>
                  {appStatus(app)}
                </Row>
              ))}
            </div>
          </Panel>

          <div className={`mt-auto border px-4 py-3 flex items-center justify-between text-[11px] tracking-widest ${verdict.border}`}>
            <span className="text-dim">SHIFT</span>
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
      <span className="text-fg text-right truncate">{children}</span>
    </div>
  );
}
