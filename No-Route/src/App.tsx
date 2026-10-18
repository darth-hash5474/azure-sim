import React, { useEffect, useReducer, useRef } from 'react';
import ScratchPanel from './ScratchPanel';
import { SCRATCH } from './engine';
import { applyScratch, type ScratchAction } from './scratch';
import {
  DB_IP,
  DB_PORT,
  WEB_IP,
  audit,
  initialGame,
  livePrompt,
  peeringState,
  runCommand,
  trace,
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

const LAYER_LABEL = { route: 'ROUTE', peering: 'PEERING', nsg: 'NSG' } as const;

export default function NoRoute(): React.JSX.Element {
  const [game, dispatch] = useReducer(reducer, undefined, initialGame);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game.history]);

  const checks = audit(game);
  const passing = checks.filter((c) => c.ok).length;
  const t = trace(game);
  const rules = [...game.rules].sort((a, b) => a.priority - b.priority);

  const verdict = game.solved
    ? { text: 'CONNECTED', cls: 'text-ok', border: 'border-ok/60' }
    : { text: `OPEN ${passing}/${checks.length}`, cls: 'text-warn', border: 'border-line' };

  return (
    <div className="bg-grid min-h-screen flex flex-col text-[13px] leading-relaxed">
      <header className="border-b border-line bg-ink/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-12 flex items-center gap-4">
          <span className="flex items-center gap-2 font-bold tracking-[0.2em] text-fg">
            <span className="w-2 h-2 bg-accent" />
            NO ROUTE
          </span>
          <span className="hidden sm:inline text-dim">// azure network troubleshooting · level 05</span>
          <span className="ml-auto text-[11px] text-dim">
            rg <span className="text-fg">net-rg</span>
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
            <span className="ml-3 text-dim">peering · routes · nsg · network watcher</span>
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
          defaultFile="rule.json"
          onWrite={(name, text) => dispatch({ type: 'write', name, text })}
          onFocus={(name) => dispatch({ type: 'focus', name })}
          hint={<>saves as you type · send a file with <span className="text-fg">az rest --method put --url &lt;ARM path&gt; --body @rule.json</span> (<span className="text-fg">help</span> lists the paths) · resets on restart</>}
        />
        </div>

        <aside className="flex flex-col gap-4">
          <Panel title="live path">
            <div className="flex items-center justify-between">
              <span className="text-fg">
                web-vm <span className="text-dim">{WEB_IP}</span>
              </span>
              <span className={`text-[10px] font-bold tracking-widest ${t.ok ? 'text-ok' : 'text-err'}`}>{t.ok ? '── REACHABLE ──▸' : `──✗ ${LAYER_LABEL[t.layer!]} ✗──`}</span>
              <span className="text-fg">
                db-vm <span className="text-dim">:{DB_PORT}</span>
              </span>
            </div>
            <div className={`mt-2 text-[11px] ${t.ok ? 'text-dim' : 'text-warn'}`}>{t.ok ? `via ${t.hop?.hopType}, NSG rule ${t.rule}` : `blocked: ${t.message}`}</div>
            <div className="mt-1 text-[10px] text-dim">db-vm {DB_IP}</div>
          </Panel>

          <Panel title="connectivity review">
            <div className="space-y-1.5">
              {checks.map((c) => (
                <div key={c.label} className="flex items-center gap-3">
                  <span className={`w-4 text-center font-bold ${c.ok ? 'text-ok' : 'text-dim'}`}>{c.ok ? '✓' : '·'}</span>
                  <span className={`flex-1 ${c.ok ? 'text-fg' : 'text-dim'}`}>{c.label}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="topology">
            <div className="text-[10px] uppercase tracking-[0.2em] text-dim">peerings</div>
            {game.peerings.length === 0 && <div className="text-dim">none</div>}
            {game.peerings.map((p) => (
              <div key={`${p.vnet}-${p.name}`} className="flex items-center gap-3 py-0.5">
                <span className="flex-1 text-fg truncate">{p.vnet} → {p.remote}</span>
                <span className={`text-[11px] ${peeringState(game, p) === 'Connected' ? 'text-ok' : 'text-warn'}`}>{peeringState(game, p)}</span>
                <span className={`text-[10px] ${p.allowVnetAccess ? 'text-dim' : 'text-err'}`}>{p.allowVnetAccess ? 'access' : 'no access'}</span>
              </div>
            ))}

            <div className="mt-3 text-[10px] uppercase tracking-[0.2em] text-dim">rt-web</div>
            {game.routes.map((r) => (
              <div key={r.name} className="flex items-center gap-3 py-0.5">
                <span className="flex-1 text-fg truncate">{r.prefix}</span>
                <span className="text-dim text-[11px]">→ {r.hop === 'None' ? 'None' : r.ip}</span>
              </div>
            ))}

            <div className="mt-3 text-[10px] uppercase tracking-[0.2em] text-dim">nsg-db inbound</div>
            {rules.map((r) => (
              <div key={r.name} className="flex items-center gap-3 py-0.5">
                <span className="w-8 tabular-nums text-dim">{r.priority}</span>
                <span className="flex-1 text-fg truncate">{r.name}</span>
                <span className={`text-[11px] ${r.access === 'Allow' ? 'text-ok' : 'text-err'}`}>{r.access}</span>
              </div>
            ))}
          </Panel>

          <div className={`mt-auto border px-4 py-3 flex items-center justify-between text-[11px] tracking-widest ${verdict.border}`}>
            <span className="text-dim">TICKET NET-2291</span>
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
