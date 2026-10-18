// Shared pieces of the simulated shell: types, quoting, the checked file writer. No React in here.
import { fileName, validName, type LineType, type ScratchConfig, type ScratchLine, type ScratchState } from './scratch';

export type Mode = 'bash' | 'pwsh';

/** Session state of the simulated shell. Lives on every game as `sh`. */
export interface ShellEnv {
  mode: Mode;
  bash: Record<string, string>;
  pwsh: Record<string, unknown>;
}

export const newShell = (): ShellEnv => ({ mode: 'bash', bash: {}, pwsh: {} });

export interface ShellState extends ScratchState {
  sh: ShellEnv;
}

// ---- Az cmdlets (the part each lab supplies) ----

/** Named arguments after binding, keyed by lower-case canonical parameter name. Switches are booleans. */
export type Bound = Record<string, unknown>;

export type Build =
  | { error: string }
  /** Answer without running anything (objects the lab fakes locally, or edits of an object passed in). */
  | { value: unknown }
  /** Read the current state with `az ... -o json`, then decide what to do about it. */
  | { read: string[]; then: (current: unknown) => Build }
  | {
      /** The az CLI words this cmdlet maps to... */
      az?: string[];
      /** ...or several commands to run in order; the last one gives the result. */
      steps?: string[][];
      /** The words are a full command rather than az arguments (e.g. curl). */
      native?: boolean;
      /** Ask the engine for JSON (on the last command) and hand PowerShell objects back instead of text. */
      json?: boolean;
      /** Reshape the parsed JSON into what the Az cmdlet would return (PascalCase names, etc.). */
      shape?: (value: unknown) => unknown;
    };

export interface CmdletDef {
  /** Parameters; "Name|ResourceGroupName|n" is the canonical name followed by aliases. */
  params: string[];
  switches?: string[];
  /** Canonical names in positional order. */
  positional?: string[];
  mandatory?: string[];
  /** Pipeline input binds by property name to these parameters (matched case-insensitively). */
  pipe?: string[];
  /** Parameters that collect every piped item into a list instead of running once per item. */
  collect?: string[];
  build: (a: Bound) => Build;
}

export type CmdletTable = Record<string, CmdletDef>;

export interface Host<G extends ShellState> {
  /** Runs one canonical command (see quoteArg) in the lab. `echo` is always null: the shell prints the typed line itself. */
  execute: (prev: G, cmd: string, echo: string | null) => G;
  /** The bash prompt of the current user, e.g. "release-eng@contoso-prod:~$". */
  prompt: (g: G) => string;
  cfg: ScratchConfig;
  cmdlets: CmdletTable;
}

export const promptFor = (bashPrompt: string, mode: Mode) =>
  mode === 'bash' ? bashPrompt : `PS /home/${bashPrompt.split('@')[0]}>`;

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

/** Wildcard match for -like and Get-ChildItem patterns. */
export const wildcard = (pattern: string, text: string) =>
  new RegExp('^' + pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(text);

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
  ['pwsh · bash', 'Switch between PowerShell and bash (the tabs above the terminal do the same). az works in both; PowerShell also has Az cmdlets'],
  ['cmdlets', 'List the Az cmdlets this lab understands'],
  ['multi-line', 'End a line with \\ (bash) or ` (PowerShell), leave a quote open, or use Shift+Enter. Pasted blocks run as typed'],
  ["cat > f.json <<'EOF' … EOF", 'Write a file from the terminal with a heredoc (quote EOF or $schema gets expanded). echo \'{"a":1}\' > f.json works too'],
  ['--parameters @f.json · \'{"a":1}\' · "$(cat f.json)"', 'JSON can come from a file, inline, or a command substitution'],
  ['Get-Content f.json -Raw | ConvertFrom-Json', 'PowerShell: read JSON into an object, edit it ($p.a.b = 1), then ConvertTo-Json -Depth 10 | Set-Content f.json'],
  ['bash script.sh · pwsh -File script.ps1', 'Run a script you wrote in the editor (./script.ps1 works in PowerShell)'],
];

export const out1 = (text: string, type: LineType = 'output'): ScratchLine => ({ text, type });
export const err1 = (text: string) => out1(text, 'error');

export const MODE_BANNER: Record<Mode, ScratchLine[]> = {
  pwsh: [
    out1('PowerShell 7.4.5 · Az 12.3.0', 'heading'),
    out1('Az cmdlets and the az CLI both work here. "cmdlets" lists them, "bash" or "exit" goes back.'),
  ],
  bash: [out1('bash — az CLI. "pwsh" switches to PowerShell.', 'heading')],
};

export function cmdletList<G extends ShellState>(ctx: Ctx<G>): ScratchLine[] {
  const names = Object.keys(ctx.host.cmdlets).sort();
  return [
    out1('# Az cmdlets in this lab (PowerShell). Everything else goes through az, which also works in PowerShell', 'heading'),
    ...names.map((n) => out1(`  ${n}`)),
    out1('  Get-Content · Set-Content · Add-Content · Out-File · New-Item · Remove-Item · Get-ChildItem · Test-Path'),
    out1('  ConvertFrom-Json · ConvertTo-Json · Select-Object · Where-Object · ForEach-Object · Sort-Object · Format-Table · Format-List'),
  ];
}

// ---- PowerShell values (shared with the lab cmdlet tables) ----

/** A line of native command output travelling through a PowerShell pipeline. It keeps its colour. */
export class PsLine {
  text: string;
  type: LineType;
  constructor(l: ScratchLine) {
    this.text = l.text;
    this.type = l.type;
  }
}

/** Objects that came from ConvertFrom-Json or [pscustomobject]; hashtables are plain objects not in this set. */
export const customObjects = new WeakSet<object>();

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PsLine);

export function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof PsLine) return v.text;
  if (Array.isArray(v)) return v.map(toStr).join(' ');
  if (isObj(v)) return customObjects.has(v) ? `@{${Object.entries(v).map(([k, x]) => `${k}=${toStr(x)}`).join('; ')}}` : 'System.Collections.Hashtable';
  return String(v);
}

export const toList = (v: unknown): unknown[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Case-insensitive property lookup, like PowerShell. */
export const keyOf = (o: Record<string, unknown>, name: string): string | undefined => {
  if (name in o) return name;
  const low = name.toLowerCase();
  return Object.keys(o).find((k) => k.toLowerCase() === low);
};

export const prop = (o: unknown, name: string): unknown => (isObj(o) ? o[keyOf(o, name) ?? '\u0000'] : undefined);

/** A tag argument as az words: a hashtable becomes k=v pairs, a string or list passes through. */
export function tagWords(v: unknown): string[] {
  if (isObj(v)) return Object.entries(v).map(([k, x]) => `${k}=${toStr(x)}`);
  return toList(v).map(toStr);
}

/** Upper-cases the first letter of every key (az JSON -> Az cmdlet objects), recursively. */
export function pascalKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pascalKeys);
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k.charAt(0).toUpperCase() + k.slice(1)] = pascalKeys(x);
    customObjects.add(o);
    return o;
  }
  return v;
}
