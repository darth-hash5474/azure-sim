import React, { useEffect, useState } from 'react';
import { DOMAINS, GAMES, type Az104Domain } from './games';

const STORAGE_KEY = 'az104-menu:selected';

const launchUrl = (id: string) => `games/${id}/`;

const loadSelected = (): number => {
  try {
    const idx = GAMES.findIndex((g) => g.id === localStorage.getItem(STORAGE_KEY));
    return idx >= 0 ? idx : 0;
  } catch {
    return 0;
  }
};

export default function Menu(): React.JSX.Element {
  const [selected, setSelected] = useState<number>(loadSelected);
  const [launching, setLaunching] = useState<string | null>(null);
  const game = GAMES[selected];

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, GAMES[selected].id);
    } catch {
      // Selection memory is a convenience only
    }
  }, [selected]);

  const launch = (id: string) => {
    setLaunching(id);
    window.location.href = launchUrl(id);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelected((i) => (i + 1) % GAMES.length);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelected((i) => (i - 1 + GAMES.length) % GAMES.length);
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLAnchorElement || e.target instanceof HTMLButtonElement)) {
        launch(GAMES[selected].id);
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= GAMES.length) {
        setSelected(Number(e.key) - 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  const coverage = (Object.keys(DOMAINS) as Az104Domain[]).map((d) => ({
    key: d,
    ...DOMAINS[d],
    games: GAMES.map((g, idx) => ({ g, idx })).filter(({ g }) => g.domain === d),
  }));

  return (
    <div className="bg-grid min-h-screen flex flex-col text-[13px] leading-relaxed">
      {/* Top bar */}
      <header className="border-b border-line bg-ink/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-12 flex items-center gap-4">
          <span className="flex items-center gap-2 font-bold tracking-[0.2em] text-fg">
            <span className="w-2 h-2 bg-accent" />
            AZ-104 FIELD OPS
          </span>
          <span className="hidden sm:inline text-dim">// azure administrator training missions</span>
          <span className="ml-auto text-[11px] text-dim">
            missions <span className="text-fg">{String(GAMES.length).padStart(2, '0')}</span>
          </span>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Mission list */}
        <section className="lg:col-span-2 flex flex-col bg-panel border border-line glow min-h-[420px]">
          <div className="h-9 px-3 flex items-center border-b border-line text-[11px]">
            <span className="px-2 py-0.5 border border-line text-fg">missions</span>
            <span className="ml-3 text-dim">select a mission to deploy</span>
            <span className="ml-auto text-dim hidden sm:inline">↑↓ select · enter launch</span>
          </div>

          <div className="px-4 pt-3 text-dim">
            <div>field-ops@azure:~$ ls ./missions</div>
          </div>

          <ul className="flex-1 p-2 sm:p-3 space-y-1" role="listbox" aria-label="Missions">
            {GAMES.map((g, idx) => {
              const active = idx === selected;
              return (
                <li key={g.id} role="option" aria-selected={active}>
                  <a
                    href={launchUrl(g.id)}
                    onMouseEnter={() => setSelected(idx)}
                    onFocus={() => setSelected(idx)}
                    onClick={(e) => {
                      e.preventDefault();
                      launch(g.id);
                    }}
                    className={`group flex items-start gap-3 px-3 py-3 border focus:outline-none ${
                      active ? 'border-accent/60 bg-accent/5' : 'border-transparent hover:border-line'
                    }`}
                  >
                    <span className={`shrink-0 w-4 ${active ? 'text-accent text-glow' : 'text-transparent'}`}>▸</span>
                    <span className="shrink-0 text-dim">{String(idx + 1).padStart(2, '0')}</span>
                    <span className="flex-1 min-w-0">
                      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className={`font-bold tracking-[0.15em] uppercase ${active ? 'text-ok' : 'text-fg'}`}>
                          {g.title}
                        </span>
                        <span className="text-[10px] uppercase tracking-[0.2em] text-dim border border-line px-1.5">
                          {g.format}
                        </span>
                      </span>
                      <span className="block mt-1 text-dim">{g.tagline}</span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-line px-4 h-11 flex items-center gap-2">
            <span className="text-accent shrink-0">field-ops@azure:~$</span>
            <span className="text-fg truncate">
              {launching ? `./deploy ${launching} ... connecting` : `./deploy ${game.id}`}
            </span>
            <span className="w-2 h-4 bg-accent animate-pulse shrink-0" />
          </div>
        </section>

        {/* Briefing + coverage */}
        <aside className="flex flex-col gap-4">
          <Panel title="briefing">
            <div className="text-lg font-bold tracking-[0.15em] uppercase text-ok text-glow">{game.title}</div>
            <div className="mt-1 text-[11px] text-dim">
              {DOMAINS[game.domain].label} · <span className="text-fg">{DOMAINS[game.domain].weight}</span> of exam
            </div>
            <p className="mt-3 text-fg/90">{game.briefing}</p>
            <div className="mt-4 text-[10px] uppercase tracking-[0.2em] text-dim">objectives</div>
            <ul className="mt-1 space-y-1">
              {game.skills.map((s) => (
                <li key={s} className="flex gap-2">
                  <span className="text-accent">+</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => launch(game.id)}
              className="mt-5 w-full border border-accent/70 px-4 py-2.5 font-bold tracking-[0.3em] text-accent hover:bg-accent hover:text-ink hover:[text-shadow:none] focus:outline-none focus-visible:bg-accent focus-visible:text-ink"
            >
              LAUNCH ▸
            </button>
          </Panel>

          <Panel title="exam coverage">
            <div className="space-y-2">
              {coverage.map((d) => (
                <div key={d.key} className="flex items-start gap-3">
                  <span className={`flex-1 ${d.key === game.domain ? 'text-fg' : 'text-dim'}`}>
                    {d.label}
                    <span className="block text-[11px]">
                      {d.games.length > 0 ? (
                        d.games.map(({ g, idx }) => (
                          <button
                            key={g.id}
                            type="button"
                            onClick={() => setSelected(idx)}
                            className="mr-3 font-bold tracking-wider uppercase text-ok hover:underline focus:outline-none focus-visible:underline"
                          >
                            ▸ {g.title}
                          </button>
                        ))
                      ) : (
                        <span className="text-dim/70">no lab yet</span>
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-dim">{d.weight}</span>
                </div>
              ))}
            </div>
          </Panel>
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
