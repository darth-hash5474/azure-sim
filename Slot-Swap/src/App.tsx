import React, { useEffect, useReducer, useRef } from 'react';
import { applyScratch, type ScratchAction } from '@azure-sim/shell';
import { ScratchPanel, TerminalInput } from '@azure-sim/terminal-ui';
import { SCRATCH } from './engine';
import {
  LOCATION,
  PLAN,
  RG,
  SKUS,
  VM,
  VM_ZONE,
  WEB,
  audit,
  bicepLines,
  initialGame,
  livePrompt,
  runCommand,
  templateParams,
  vmSpec,
  type Game,
  type LineType,
} from './engine';

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

export default function SlotSwap(): React.JSX.Element {
  const [game, dispatch] = useReducer(reducer, undefined, initialGame);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game.history]);

  const checks = audit(game);
  const passing = checks.filter((c) => c.ok).length;
  const params = templateParams(bicepLines(game));
  const vm = game.vm && vmSpec(game.vm.size);

  const verdict = game.solved
    ? { text: 'GO', cls: 'text-ok', border: 'border-ok/60' }
    : game.lost.length
      ? { text: `LOST ${game.lost.length}`, cls: 'text-err', border: 'border-err/60' }
      : { text: `HOLD ${passing}/${checks.length}`, cls: 'text-warn', border: 'border-line' };

  return (
    <div className="bg-grid min-h-screen flex flex-col text-[13px] leading-relaxed">
      <header className="border-b border-line bg-ink/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-12 flex items-center gap-4">
          <span className="flex items-center gap-2 font-bold tracking-[0.2em] text-fg">
            <span className="w-2 h-2 bg-accent" />
            SLOT SWAP
          </span>
          <span className="hidden sm:inline text-dim">// azure launch-night drill · level 04</span>
          <span className="ml-auto text-[11px] text-dim">
            rg <span className="text-fg">{RG}</span>
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
            <span className="ml-3 text-dim">bicep · app service slots · vm sizes</span>
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
          defaultFile="params.json"
          onWrite={(name, text) => dispatch({ type: 'write', name, text })}
          onFocus={(name) => dispatch({ type: 'focus', name })}
          hint={<>saves as you type · try <span className="text-fg">az deployment group what-if -g launch-rg --template-file main.bicep --parameters @params.json</span> · <span className="text-fg">--settings @appsettings.json</span> for app settings · resets on restart</>}
        />
        </div>

        <aside className="flex flex-col gap-4">
          <Panel title="go-live review">
            <div className="space-y-1.5">
              {checks.map((c) => (
                <div key={c.label} className="flex items-center gap-3">
                  <span className={`w-4 text-center font-bold ${c.ok ? 'text-ok' : 'text-dim'}`}>{c.ok ? '✓' : '·'}</span>
                  <span className={`flex-1 ${c.ok ? 'text-fg' : 'text-dim'}`}>{c.label}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title={`estate · ${LOCATION}`}>
            <div className="space-y-1.5">
              <Row label={PLAN}>
                {game.plan.sku} <span className="text-dim">({SKUS[game.plan.sku].tier})</span> × {game.plan.workers}
              </Row>
              <Row label={`└ ${WEB}`}>
                <span className="text-ok">{game.prod.version}</span> <span className="text-dim">db</span> {game.prod.settings.DB_URL ?? '—'}
              </Row>
              <Row label="  └ staging">
                {game.staging ? (
                  <>
                    <span className="text-ok">{game.staging.version}</span> <span className="text-dim">db</span> {game.staging.settings.DB_URL ?? '—'}
                  </>
                ) : (
                  <span className="text-dim">no slot</span>
                )}
              </Row>
              <Row label="launchlogs">{game.logs ? <span className="text-ok">online</span> : <span className="text-err">DELETED</span>}</Row>
              <Row label={VM}>
                {game.vm && vm ? (
                  <>
                    {game.vm.size.replace('Standard_', '')} <span className="text-dim">{vm.vcpu}c/{vm.mem}G z{VM_ZONE}</span>
                  </>
                ) : (
                  <span className="text-err">DELETED</span>
                )}
              </Row>
            </div>
            {game.sticky.length > 0 && (
              <div className="mt-3 text-[10px] text-dim">
                slot settings (sticky): <span className="text-accent">{game.sticky.join(', ')}</span>
              </div>
            )}
          </Panel>

          <Panel title="main.bicep parameters">
            <Row label="planSku">{params.planSku}</Row>
            <Row label="instanceCount">{params.instanceCount}</Row>
          </Panel>

          <div className={`mt-auto border px-4 py-3 flex items-center justify-between text-[11px] tracking-widest ${verdict.border}`}>
            <span className="text-dim">LAUNCH</span>
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
      <span className="text-dim whitespace-pre">{label}</span>
      <span className="text-fg text-right">{children}</span>
    </div>
  );
}
