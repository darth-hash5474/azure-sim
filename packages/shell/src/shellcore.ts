// Shared pieces of the simulated shell: types, quoting, the checked file writer. No React in here.
import { fileName, validName, type LineType, type ScratchConfig, type ScratchLine, type ScratchState } from './scratch';

/** Session state of the simulated shell. Lives on every game as `sh`. */
export interface ShellEnv {
  bash: Record<string, string>;
}

export const newShell = (): ShellEnv => ({ bash: {} });

export interface ShellState extends ScratchState {
  sh: ShellEnv;
}

export interface Host<G extends ShellState> {
  /** Runs one canonical command (see quoteArg) in the lab. `echo` is always null: the shell prints the typed line itself. */
  execute: (prev: G, cmd: string, echo: string | null) => G;
  /** The bash prompt of the current user, e.g. "release-eng@contoso-prod:~$". */
  prompt: (g: G) => string;
  cfg: ScratchConfig;
}

// ---- quoting ----

/** Splits a command into words, honouring '...' and "..." (with \" and \\ inside double quotes). */
export function splitWords(cmd: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      cur = (cur ?? '') + cmd.slice(i + 1, end < 0 ? cmd.length : end);
      i = end < 0 ? cmd.length : end;
    } else if (c === '"') {
      cur = cur ?? '';
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) i++;
        cur += cmd[i];
      }
    } else if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else cur = (cur ?? '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** The canonical form of one argument: plain when it is safe, otherwise quoted so splitWords gets it back. */
export function quoteArg(s: string): string {
  if (s !== '' && /^[\w@%+=:,./~<>-]+$/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/(["\\])/g, '\\$1')}"`;
}

// ---- scratch file writes ----

export type WriteProblem = 'readonly' | 'badname' | 'full';

/** Writes (or appends to) a scratch file. Mutates `g`, which must be a private copy. Returns why it could not. */
export function writeFileChecked<G extends ScratchState>(g: G, target: string, content: string, append: boolean, cfg: ScratchConfig): WriteProblem | null {
  const name = fileName(target.replace(/\\/g, '/'));
  if (!validName(name)) return 'badname';
  if (cfg.readonly.includes(name) || (cfg.binary ?? []).includes(name)) return 'readonly';
  if (!(name in g.files) && Object.keys(g.files).length >= (cfg.max ?? 12)) return 'full';
  g.files = { ...g.files, [name]: append ? (g.files[name] ?? '') + content : content };
  g.focus = name;
  return null;
}

export const lineCountOf = (content: string) => content.split('\n').length - (content.endsWith('\n') ? 1 : 0);

export const asLines = (text: string, type: ScratchLine['type'] = 'output'): ScratchLine[] =>
  text.replace(/\n$/, '').split('\n').map((t) => ({ text: t || ' ', type }));

// ---- running a lab command ----

/** Working state of one submitted input. `g` is a private copy, so builtins may change it in place. */
export interface Ctx<G extends ShellState> {
  g: G;
  host: Host<G>;
  depth: number;
  inline: number;
}

export interface Ran {
  lines: ScratchLine[];
  ok: boolean;
}

export const hasError = (lines: ScratchLine[]) => lines.some((l) => l.type === 'error');

/**
 * Hands one command to the lab. Inline JSON arguments ('{...}' or '[...]') become hidden scratch files and are passed
 * as @<inline-N>, so every lab reads them through the same code that reads @file.json.
 * The lab's output comes back as lines instead of landing in the history.
 */
export function runEngine<G extends ShellState>(ctx: Ctx<G>, argv: string[]): Ran {
  const g0 = ctx.g;
  if (argv[0] === 'clear') {
    ctx.g = { ...g0, history: [] };
    return { lines: [], ok: true };
  }
  if (argv[0] === 'restart') {
    ctx.g = ctx.host.execute(g0, 'restart', null);
    return { lines: [], ok: true };
  }
  const added: string[] = [];
  const args = argv.map((a) => {
    if (!/^\s*[{[]/.test(a)) return a;
    const key = `<inline-${++ctx.inline}>`;
    added.push(key);
    g0.files[key] = a;
    return `@${key}`;
  });
  const base = g0.history.length;
  const next = ctx.host.execute(g0, args.map(quoteArg).join(' '), null);
  for (const k of added) delete next.files[k];
  next.sh = g0.sh;
  const lines = next.history.length >= base ? next.history.slice(base) : [];
  next.history = next.history.slice(0, base);
  ctx.g = next;
  return { lines, ok: !hasError(lines) };
}

export const emit = <G extends ShellState>(ctx: Ctx<G>, lines: ScratchLine[]) => {
  ctx.g.history.push(...lines);
};

export const SHELL_HELP: [string, string][] = [
  ['multi-line', 'End a line with \\, leave a quote open, or use Shift+Enter. Pasted blocks run as typed'],
  ["cat > f.json <<'EOF' … EOF", 'Write a file from the terminal with a heredoc (quote EOF or $schema gets expanded). echo \'{"a":1}\' > f.json works too'],
  ['--parameters @f.json · \'{"a":1}\' · "$(cat f.json)"', 'JSON can come from a file, inline, or a command substitution'],
  ['bash script.sh · ./script.sh', 'Run a script you wrote in the editor'],
];

export const out1 = (text: string, type: LineType = 'output'): ScratchLine => ({ text, type });
export const err1 = (text: string) => out1(text, 'error');
