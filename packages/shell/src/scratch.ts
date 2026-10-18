// Scratch folder (~/scratch): a tiny in-memory file set the player edits live and feeds to the CLI with @file.
// Shared by the simulators. No React in here.

export type LineType = 'input' | 'output' | 'error' | 'success' | 'heading' | 'alert';

export interface ScratchLine {
  text: string;
  type: LineType;
}

/** The parts of a game's state the scratch folder needs. Each game's own Game type satisfies this. */
export interface ScratchState {
  files: Record<string, string>;
  /** File the editor panel should show (set by "edit <file>" and by redirects). */
  focus: string | null;
  history: ScratchLine[];
}

export interface ScratchConfig {
  /** Files the player can read but not change. */
  readonly: string[];
  /** Files that exist (ls shows them) but are not text, e.g. release packages. */
  binary?: string[];
  max?: number;
}

export type ScratchOut = (text: string, type?: LineType) => void;

export type ScratchAction = { type: 'write'; name: string; text: string } | { type: 'focus'; name: string };

const SCRATCH_RE = /^(~\/scratch\/|\.\/)/;
export const fileName = (token: string) => token.replace(SCRATCH_RE, '');
export const validName = (n: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/.test(n);
const maxFiles = (cfg: ScratchConfig) => cfg.max ?? 12;

/** Live edit from the editor panel. Read-only and unknown files are ignored. */
export function setFile<G extends ScratchState>(g: G, name: string, text: string, cfg: ScratchConfig): G {
  return cfg.readonly.includes(name) || !(name in g.files) ? g : { ...g, files: { ...g.files, [name]: text } };
}

/** Reducer helper for the two editor actions. */
export function applyScratch<G extends ScratchState>(g: G, a: ScratchAction, cfg: ScratchConfig): G {
  if (a.type === 'write') return setFile(g, a.name, a.text, cfg);
  return a.name in g.files ? { ...g, focus: a.name } : g;
}

/** Reads "@file" (or a bare file name) from the scratch folder as text. Prints its own error and returns null. */
export function readScratchText(g: ScratchState, out: ScratchOut, ref: string): { name: string; text: string } | null {
  const name = fileName(ref.replace(/^@/, ''));
  if (!(name in g.files)) {
    out(`ERR Cannot read '${name}': no such file in ~/scratch. "ls" shows what is there.`, 'error');
    return null;
  }
  return { name: name.startsWith('<inline') ? 'inline JSON' : name, text: g.files[name] };
}

/** Reads "@file" as JSON. Prints its own error (with the parse message) and returns null. */
export function readScratchJson(g: ScratchState, out: ScratchOut, ref: string): { name: string; value: unknown } | null {
  const file = readScratchText(g, out, ref);
  if (!file) return null;
  try {
    return { name: file.name, value: JSON.parse(file.text) };
  } catch (e) {
    if (file.name === 'inline JSON') {
      out(`ERR Failed to parse string as JSON: ${(e as Error).message}`, 'error');
      out('# check the quotes around the JSON; in a file it is easier to keep right', 'heading');
    } else {
      out(`ERR Failed to parse '${file.name}' as JSON: ${(e as Error).message}`, 'error');
      out('# fix the file in the editor below the terminal, then run the command again', 'heading');
    }
    return null;
  }
}

const isRef = (v: string | undefined | null): v is string => !!v && v.startsWith('@');

/** True when a CLI value is an @file reference. */
export const isFileRef = isRef;

/** Handles ls, cat, edit, touch and rm. Returns true if the command was one of them. */
export function scratchCommand<G extends ScratchState>(g: G, out: ScratchOut, cmd: string, cfg: ScratchConfig): boolean {
  const binary = cfg.binary ?? [];
  const arg = () => fileName(cmd.split(/\s+/)[1]);
  const full = () => Object.keys(g.files).length >= maxFiles(cfg);

  if (/^ls(\s+\S+)?$/.test(cmd)) {
    out('~/scratch', 'heading');
    Object.entries(g.files).forEach(([n, t]) => out(`  ${n.padEnd(18)}${String(t.length).padStart(5)} B${cfg.readonly.includes(n) ? '  read-only' : ''}`));
    binary.forEach((n) => out(`  ${n.padEnd(18)}${'binary'.padStart(7)}${'  read-only'}`));
    return true;
  }
  if (/^cat\s+\S+$/.test(cmd)) {
    const n = arg();
    if (binary.includes(n)) out(`cat: ${n}: binary file`, 'error');
    else if (!(n in g.files)) out(`cat: ${n}: No such file or directory`, 'error');
    else g.files[n].replace(/\n$/, '').split('\n').forEach((l, i) => out(l || ' ', i === 0 && /^[A-Z0-9-]+ ·/.test(l) ? 'heading' : 'output'));
    return true;
  }
  if (/^(edit|nano|vi|vim|code)\s+\S+$/.test(cmd)) {
    const n = arg();
    if (binary.includes(n)) out(`ERR ${n} is a binary file and cannot be opened in the editor.`, 'error');
    else if (!validName(n)) out(`ERR '${n}' is not a usable file name.`, 'error');
    else if (!(n in g.files) && full()) out(`ERR ~/scratch is full (${maxFiles(cfg)} files). Remove one with: rm <file>`, 'error');
    else {
      if (!(n in g.files)) g.files[n] = '';
      g.focus = n;
      out(`Opened ~/scratch/${n} in the editor below the terminal${cfg.readonly.includes(n) ? ' (read-only)' : ''}. Changes save as you type.`, 'success');
    }
    return true;
  }
  if (/^touch\s+\S+$/.test(cmd)) {
    const n = arg();
    if (!validName(n)) out(`ERR '${n}' is not a usable file name.`, 'error');
    else if (n in g.files || binary.includes(n)) out(`OK  ${n} already exists.`);
    else if (full()) out(`ERR ~/scratch is full (${maxFiles(cfg)} files). Remove one with: rm <file>`, 'error');
    else {
      g.files[n] = '';
      g.focus = n;
      out(`OK  created ~/scratch/${n}`, 'success');
    }
    return true;
  }
  if (/^rm\s+\S+$/.test(cmd)) {
    const n = arg();
    if (binary.includes(n) || cfg.readonly.includes(n)) out(`rm: cannot remove '${n}': Permission denied (read-only)`, 'error');
    else if (!(n in g.files)) out(`rm: cannot remove '${n}': No such file or directory`, 'error');
    else {
      delete g.files[n];
      if (g.focus === n) g.focus = null;
      out(`OK  removed ${n}`, 'success');
    }
    return true;
  }
  return false;
}

/**
 * Wraps a game's command executor with "<command> > file" handling: the command runs, then what it printed is saved
 * into ~/scratch instead. A command that printed an error writes nothing.
 * `execute(prev, cmd, echo)` runs `cmd` and prints `echo` as the typed line.
 */
export function withRedirect<G extends ScratchState>(
  prev: G,
  text: string,
  execute: (prev: G, cmd: string, echo: string) => G,
  cfg: ScratchConfig
): G {
  const raw = text.trim();
  const redirect = /^(.+?)\s+>\s*(\S+)$/.exec(raw);
  if (!redirect || /^(clear|restart)\b/.test(redirect[1])) return execute(prev, raw, raw);

  const [, body, target] = redirect;
  const echoAt = prev.history.length;
  const g = execute(prev, body, raw);
  const produced = g.history.slice(echoAt + 1);
  if (produced.some((l) => l.type === 'error')) return g;

  const name = fileName(target);
  const fail = (msg: string) => {
    g.history = g.history.slice(0, echoAt + 1);
    g.history.push({ text: msg, type: 'error' });
    return g;
  };
  if (!validName(name)) return fail(`ERR '${target}' is not a usable file name. Use letters, digits, . _ - and stay in ~/scratch.`);
  if (cfg.readonly.includes(name) || (cfg.binary ?? []).includes(name)) return fail(`bash: ${name}: Permission denied (read-only)`);
  if (!(name in g.files) && Object.keys(g.files).length >= maxFiles(cfg)) return fail(`ERR ~/scratch is full (${maxFiles(cfg)} files). Remove one with: rm <file>`);

  const content = produced.map((l) => l.text).join('\n') + '\n';
  const lineCount = content.split('\n').length - 1;
  g.history = g.history.slice(0, echoAt + 1);
  g.files = { ...g.files, [name]: content };
  g.focus = name;
  g.history.push({ text: `OK  wrote ${lineCount} line${lineCount === 1 ? '' : 's'} to ~/scratch/${name}`, type: 'success' });
  return g;
}
