// The simulated shell: bash parsing and execution, the PowerShell switch, and the entry point the labs call.
// Pure TypeScript, no React.
import { fileName, scratchCommand, type ScratchLine } from './scratch';
import { pwshIncomplete, runPwshText } from './pwsh';
import {
  MODE_BANNER,
  SHELL_HELP,
  asLines,
  cmdletList,
  err1,
  out1,
  emit,
  hasError,
  lineCountOf,
  newShell,
  promptFor,
  runEngine,
  writeFileChecked,
  type Ctx,
  type Host,
  type Mode,
  type Ran,
  type ShellState,
} from './shellcore';

export { newShell, promptFor };
export type { Host, Mode, ShellEnv, ShellState, CmdletDef, CmdletTable, Bound, Build } from './shellcore';

// ---- phase A: split the typed text into statements (quotes, $( ), continuations, heredocs) ----

interface Heredoc {
  delim: string;
  quoted: boolean;
  strip: boolean;
  body: string;
}

interface RawStmt {
  text: string;
  heredocs: Heredoc[];
}

/** Index just after the ")" that closes the "(" at `open`, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) return -1;
      i = e;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

const HD = '\u0001';

export function splitBash(src: string): { stmts: (RawStmt & { sep: ';' | '&&' | '||' })[]; incomplete: boolean } {
  const stmts: (RawStmt & { sep: ';' | '&&' | '||' })[] = [];
  const n = src.length;
  let cur = '';
  let hds: Heredoc[] = [];
  let pending: Heredoc[] = [];
  let incomplete = false;
  let quote: '"' | "'" | null = null;
  let trailingOp = false;
  let i = 0;
  const push = (sep: ';' | '&&' | '||') => {
    if (cur.trim()) stmts.push({ text: cur.trim(), sep, heredocs: hds });
    cur = '';
    hds = [];
  };

  while (i < n) {
    const c = src[i];
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        if (i >= n) incomplete = true;
        continue;
      }
      if (i + 1 >= n) incomplete = true;
      cur += c + (src[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
      const end = matchParen(src, i + 1);
      if (end < 0) {
        incomplete = true;
        cur += src.slice(i);
        i = n;
      } else {
        cur += src.slice(i, end);
        i = end;
      }
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) {
        incomplete = true;
        cur += src.slice(i);
        i = n;
      } else {
        cur += src.slice(i, end + 1);
        i = end + 1;
      }
      continue;
    }
    if (quote === '"') {
      cur += c;
      if (c === '"') quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      trailingOp = false;
      i++;
      continue;
    }
    if (c === '#' && (cur === '' || /\s$/.test(cur))) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      i++;
      for (const h of pending) {
        const body: string[] = [];
        let found = false;
        while (i < n) {
          const j = src.indexOf('\n', i);
          const line = (j < 0 ? src.slice(i) : src.slice(i, j)).replace(/\r$/, '');
          i = j < 0 ? n : j + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) {
            found = true;
            break;
          }
          body.push(h.strip ? line.replace(/^\t+/, '') : line);
        }
        h.body = body.length ? body.join('\n') + '\n' : '';
        if (!found) incomplete = true;
      }
      pending = [];
      if (/[^|]\|\s*$/.test(cur)) {
        cur += ' ';
        continue;
      }
      push(';');
      continue;
    }
    if (c === ';') {
      push(';');
      i++;
      continue;
    }
    if ((c === '&' || c === '|') && src[i + 1] === c) {
      push(c === '&' ? '&&' : '||');
      trailingOp = true;
      i += 2;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      let j = i + 2;
      const strip = src[j] === '-';
      if (strip) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      let delim = '';
      let quoted = false;
      if (src[j] === "'" || src[j] === '"') {
        const e = src.indexOf(src[j], j + 1);
        delim = src.slice(j + 1, e < 0 ? n : e);
        quoted = true;
        j = e < 0 ? n : e + 1;
      } else {
        if (src[j] === '\\') {
          quoted = true;
          j++;
        }
        const m = /^[^\s;|&<>]+/.exec(src.slice(j));
        delim = m ? m[0] : '';
        j += delim.length;
      }
      const h: Heredoc = { delim, quoted, strip, body: '' };
      hds.push(h);
      pending.push(h);
      cur += `<<${HD}${hds.length - 1}${HD}`;
      i = j;
      continue;
    }
    if (!/\s/.test(c)) trailingOp = false;
    cur += c;
    i++;
  }
  if (quote) incomplete = true;
  if (pending.length) incomplete = true;
  if (trailingOp && !cur.trim()) incomplete = true;
  if (/[^|]\|\s*$/.test(cur)) incomplete = true;
  push(';');
  return { stmts, incomplete };
}

/** True while the typed text is not a finished command yet (open quote, trailing \ or |, unfinished heredoc...). */
export function needsMore(text: string, mode: Mode): boolean {
  return mode === 'bash' ? splitBash(text).incomplete : pwshIncomplete(text);
}

// ---- phase B: expand one statement into pipeline stages ----

interface Stage {
  argv: string[];
  out?: { file: string; append: boolean } | 'null';
  hideErr?: boolean;
  stdin?: string;
}

const varOf = <G extends ShellState>(ctx: Ctx<G>, name: string): string => {
  if (name === 'HOME') return '/home/' + ctx.host.prompt(ctx.g).split('@')[0];
  if (name === '?') return ctx.g.sh.bash['?'] ?? '0';
  return ctx.g.sh.bash[name] ?? '';
};

/** Runs a $( ) or `` body and returns what it printed. Errors still reach the terminal. */
function substitute<G extends ShellState>(ctx: Ctx<G>, inner: string): string {
  const grabbed: ScratchLine[] = [];
  if (ctx.depth < 6) {
    ctx.depth++;
    runBashText(ctx, inner, grabbed);
    ctx.depth--;
  }
  return grabbed.map((l) => (l.text === ' ' ? '' : l.text)).join('\n').replace(/\n+$/, '');
}

/** Expands the "$..." at s[i]. Null when it is just a literal dollar sign. */
function expandAt<G extends ShellState>(ctx: Ctx<G>, s: string, i: number): { text: string; end: number } | null {
  const next = s[i + 1];
  if (next === '(' && s[i + 2] !== '(') {
    const end = matchParen(s, i + 1);
    if (end < 0) return null;
    return { text: substitute(ctx, s.slice(i + 2, end - 1)), end };
  }
  if (next === '{') {
    const close = s.indexOf('}', i + 2);
    if (close < 0) return null;
    const body = s.slice(i + 2, close);
    const def = /^(\w+):-(.*)$/.exec(body);
    if (def) return { text: varOf(ctx, def[1]) || def[2], end: close + 1 };
    if (body.startsWith('#')) return { text: String(varOf(ctx, body.slice(1)).length), end: close + 1 };
    return { text: varOf(ctx, body), end: close + 1 };
  }
  if (next === '?') return { text: varOf(ctx, '?'), end: i + 2 };
  const m = /^[A-Za-z_]\w*/.exec(s.slice(i + 1));
  if (m) return { text: varOf(ctx, m[0]), end: i + 1 + m[0].length };
  return null;
}

/** Expansion of an unquoted heredoc body: $VAR, ${VAR}, $(cmd) and backslash escapes; quotes stay as they are. */
function expandHeredoc<G extends ShellState>(ctx: Ctx<G>, body: string): string {
  let out = '';
  for (let i = 0; i < body.length; ) {
    const c = body[i];
    if (c === '\\' && '$`\\'.includes(body[i + 1] ?? '')) {
      out += body[i + 1];
      i += 2;
    } else if (c === '$') {
      const e = expandAt(ctx, body, i);
      if (e) {
        out += e.text;
        i = e.end;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function tokenize<G extends ShellState>(ctx: Ctx<G>, raw: string, heredocs: Heredoc[]): { stages: Stage[]; error?: string } {
  const stages: Stage[] = [];
  let st: Stage = { argv: [] };
  let cur: string | null = null;
  let pend: { fd: number; append: boolean; input?: boolean; here?: boolean; both?: boolean } | null = null;
  let error: string | undefined;
  const n = raw.length;

  const place = (w: string) => {
    if (pend) {
      const p = pend;
      pend = null;
      if (p.here) st.stdin = w + '\n';
      else if (p.input) {
        const name = fileName(w);
        if (name in ctx.g.files) st.stdin = ctx.g.files[name];
        else error = `bash: ${w}: No such file or directory`;
      } else if (p.fd === 2) {
        if (w === '/dev/null') st.hideErr = true;
      } else {
        st.out = w === '/dev/null' ? 'null' : { file: w, append: p.append };
        if (p.both && w === '/dev/null') st.hideErr = true;
      }
    } else st.argv.push(w);
  };
  const flush = () => {
    if (cur !== null) place(cur);
    cur = null;
  };
  const addExpansion = (text: string, quoted: boolean) => {
    const assignment = st.argv.length === 0 && cur !== null && /^[A-Za-z_]\w*=/.test(cur);
    if (quoted || assignment) {
      cur = (cur ?? '') + text;
      return;
    }
    const parts = text.split(/\s+/).filter(Boolean);
    if (/^\s/.test(text)) flush();
    parts.forEach((p, k) => {
      if (k > 0) flush();
      cur = (cur ?? '') + p;
    });
    if (parts.length && /\s$/.test(text)) flush();
  };

  let i = 0;
  while (i < n) {
    const c = raw[i];
    if (c === "'") {
      const e = raw.indexOf("'", i + 1);
      cur = (cur ?? '') + raw.slice(i + 1, e < 0 ? n : e);
      i = e < 0 ? n : e + 1;
    } else if (c === '"') {
      cur = cur ?? '';
      i++;
      while (i < n && raw[i] !== '"') {
        const d = raw[i];
        if (d === '\\' && '"\\$`'.includes(raw[i + 1] ?? '')) {
          cur += raw[i + 1];
          i += 2;
        } else if (d === '$') {
          const e = expandAt(ctx, raw, i);
          if (e) {
            cur += e.text;
            i = e.end;
          } else {
            cur += d;
            i++;
          }
        } else if (d === '`') {
          const e = raw.indexOf('`', i + 1);
          cur += substitute(ctx, raw.slice(i + 1, e < 0 ? n : e));
          i = e < 0 ? n : e + 1;
        } else {
          cur += d;
          i++;
        }
      }
      i++;
    } else if (c === '\\') {
      cur = (cur ?? '') + (raw[i + 1] ?? '');
      i += 2;
    } else if (c === '$') {
      const e = expandAt(ctx, raw, i);
      if (e) {
        addExpansion(e.text, false);
        i = e.end;
      } else {
        cur = (cur ?? '') + c;
        i++;
      }
    } else if (c === '`') {
      const e = raw.indexOf('`', i + 1);
      addExpansion(substitute(ctx, raw.slice(i + 1, e < 0 ? n : e)), false);
      i = e < 0 ? n : e + 1;
    } else if (/\s/.test(c)) {
      flush();
      i++;
    } else if (c === '|') {
      flush();
      stages.push(st);
      st = { argv: [] };
      i++;
    } else if (c === '<' && raw[i + 1] === '<' && raw[i + 2] === HD) {
      flush();
      const close = raw.indexOf(HD, i + 3);
      const h = heredocs[Number(raw.slice(i + 3, close))];
      st.stdin = h ? (h.quoted ? h.body : expandHeredoc(ctx, h.body)) : '';
      i = close + 1;
    } else if (c === '<' && raw.startsWith('<<<', i)) {
      flush();
      pend = { fd: 0, append: false, here: true };
      i += 3;
    } else if (c === '<') {
      flush();
      pend = { fd: 0, append: false, input: true };
      i++;
    } else if (c === '>' || (c === '&' && raw[i + 1] === '>')) {
      let fd = 1;
      const both = c === '&';
      if (both) i++;
      else if (cur === '1' || cur === '2') {
        fd = Number(cur);
        cur = null;
      } else flush();
      i++;
      let append = false;
      if (raw[i] === '>') {
        append = true;
        i++;
      }
      if (raw[i] === '&') i += 1 + (/\d/.test(raw[i + 1] ?? '') ? 1 : 0); // 2>&1, >&2: both streams share the terminal here
      else pend = { fd, append, both };
    } else {
      cur = (cur ?? '') + c;
      i++;
    }
  }
  flush();
  if (pend) error = 'bash: syntax error near unexpected token `newline\'';
  stages.push(st);
  return { stages, error };
}

// ---- builtins ----

/** A small jq: paths (.a.b[0], .a[]), keys, length, and | between them. */
function jq(args: string[], stdin: string | null, files: Record<string, string>): Ran {
  const flags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join('');
  const rest = args.filter((a) => !/^-[a-zA-Z]+$/.test(a));
  const filter = rest[0] ?? '.';
  const text = rest[1] ? files[fileName(rest[1])] : stdin;
  if (text === undefined || text === null) return { lines: [err1(rest[1] ? `jq: error: Could not open ${rest[1]}: No such file or directory` : 'jq: no input (pipe something in or name a file)')], ok: false };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { lines: [err1(`jq: error (at <stdin>:${text.split('\n').length}): ${(e as Error).message}`)], ok: false };
  }
  let vals: unknown[] = [root];
  for (const stage of filter.split('|').map((s) => s.trim())) {
    if (stage === 'keys') vals = vals.map((v) => (v && typeof v === 'object' ? Object.keys(v).sort() : null));
    else if (stage === 'length') vals = vals.map((v) => (typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0));
    else if (stage.startsWith('.')) {
      const re = /\.([A-Za-z_]\w*)|\["([^"]+)"\]|\[(\d+)\]|\[\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stage))) {
        const key = m[1] ?? m[2];
        if (m[0] === '[]') vals = vals.flatMap((v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []));
        else if (m[3] !== undefined) vals = vals.map((v) => (Array.isArray(v) ? (v[Number(m![3])] ?? null) : null));
        else vals = vals.map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? ((v as Record<string, unknown>)[key] ?? null) : null));
      }
    } else return { lines: [err1(`jq: error: this simulator's jq knows paths like .a.b[0], .a[], keys and length (got: ${stage})`)], ok: false };
  }
  const lines = vals.flatMap((v) => (typeof v === 'string' && flags.includes('r') ? v.split('\n') : JSON.stringify(v, null, flags.includes('c') ? 0 : 2).split('\n')));
  return { lines: lines.map((l) => out1(l || ' ')), ok: true };
}

function printf(args: string[]): string {
  const fmt = args[0] ?? '';
  const rest = args.slice(1);
  let k = 0;
  let out = '';
  do {
    out += fmt
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/%[sd]|%%/g, (m) => (m === '%%' ? '%' : (rest[k++] ?? '')));
  } while (k < rest.length && /%[sd]/.test(fmt));
  return out;
}

function bashHelp<G extends ShellState>(ctx: Ctx<G>): ScratchLine[] {
  const ran = runEngine(ctx, ['help']);
  return [...ran.lines, out1('# shell', 'heading'), ...SHELL_HELP.flatMap(([c, d]) => [out1(`  ${c}\n      ${d}`)])];
}

function runCmd<G extends ShellState>(ctx: Ctx<G>, argv: string[], stdin: string | null): Ran {
  const [name, ...args] = argv;
  const g = ctx.g;
  const mk = (lines: ScratchLine[]): Ran => ({ lines, ok: !hasError(lines) });
  const scratch = (cmd: string): ScratchLine[] => {
    const lines: ScratchLine[] = [];
    scratchCommand(g, (t, type = 'output') => lines.push({ text: t, type }), cmd, ctx.host.cfg);
    return lines;
  };
  const plain = args.filter((a) => !a.startsWith('-'));

  switch (name) {
    case 'echo': {
      let text = args.filter((a) => !/^-[neE]+$/.test(a)).join(' ');
      if (args.some((a) => /^-[nE]*e[nE]*$/.test(a))) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      return mk(text.split('\n').map((l) => out1(l || ' ')));
    }
    case 'printf':
      return mk(asLines(printf(args)));
    case 'cat': {
      if (!plain.length) return stdin === null ? mk([err1('cat: reading standard input: nothing is piped in')]) : mk(asLines(stdin));
      return mk(plain.flatMap((f) => scratch(`cat ${f}`)));
    }
    case 'ls':
      return mk(scratch('ls'));
    case 'touch':
      return mk(plain.flatMap((f) => scratch(`touch ${f}`)));
    case 'rm':
      return mk(plain.flatMap((f) => scratch(`rm ${f}`)));
    case 'edit':
    case 'nano':
    case 'vi':
    case 'vim':
    case 'code':
      return plain.length ? mk(scratch(`edit ${plain[0]}`)) : mk([err1(`${name}: which file? e.g. ${name} params.json`)]);
    case 'pwd':
      return mk([out1(varOf(ctx, 'HOME'))]);
    case 'cd':
      return !plain.length || /^(~|~\/scratch|\.|\/home\/\S+)\/?$/.test(plain[0]) ? mk([]) : mk([err1(`bash: cd: ${plain[0]}: No such file or directory`)]);
    case 'true':
    case ':':
    case 'sleep':
      return mk([]);
    case 'false':
      return { lines: [], ok: false };
    case 'export':
    case 'declare':
    case 'local':
      args.forEach((a) => {
        const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(a);
        if (m) g.sh.bash[m[1]] = m[2];
      });
      return mk([]);
    case 'unset':
      args.forEach((a) => delete g.sh.bash[a]);
      return mk([]);
    case 'jq':
      return jq(args, stdin, g.files);
    case 'grep': {
      const ic = args.includes('-i');
      const inv = args.includes('-v');
      const count = args.includes('-c');
      const rest = args.filter((a) => !a.startsWith('-'));
      const text = rest[1] ? g.files[fileName(rest[1])] : stdin;
      if (text === undefined || text === null) return mk([err1(rest[1] ? `grep: ${rest[1]}: No such file or directory` : 'grep: nothing piped in')]);
      let re: RegExp;
      try {
        re = new RegExp(rest[0] ?? '', ic ? 'i' : '');
      } catch {
        return mk([err1(`grep: Invalid regular expression: ${rest[0]}`)]);
      }
      const hits = text.replace(/\n$/, '').split('\n').filter((l) => re.test(l) !== inv);
      return { lines: count ? [out1(String(hits.length))] : hits.map((l) => out1(l || ' ')), ok: hits.length > 0 };
    }
    case 'head': {
      const nArg = args.find((a) => /^-\d+$/.test(a))?.slice(1) ?? (args.includes('-n') ? args[args.indexOf('-n') + 1] : '10');
      const file = plain.filter((a) => a !== nArg).pop();
      const text = file ? g.files[fileName(file)] : stdin;
      if (text === undefined || text === null) return mk([err1(file ? `head: cannot open '${file}' for reading: No such file or directory` : 'head: nothing piped in')]);
      return mk(text.replace(/\n$/, '').split('\n').slice(0, Number(nArg) || 10).map((l) => out1(l || ' ')));
    }
    case 'wc': {
      const file = plain[0];
      const text = file ? g.files[fileName(file)] : stdin;
      if (text === undefined || text === null) return mk([err1(file ? `wc: ${file}: No such file or directory` : 'wc: nothing piped in')]);
      return mk([out1(String(lineCountOf(text)))]);
    }
    case 'tee': {
      if (stdin === null) return mk([err1('tee: nothing piped in')]);
      const f = plain[0];
      if (f) {
        const why = writeFileChecked(g, f, stdin, args.includes('-a'), ctx.host.cfg);
        if (why) return mk([err1(why === 'readonly' ? `tee: ${f}: Permission denied (read-only)` : `tee: ${f}: not a usable scratch file name`)]);
      }
      return mk(asLines(stdin));
    }
    case 'help':
      if (!args.length) return mk(bashHelp(ctx));
      break;
    case 'cmdlets':
      return mk(cmdletList(ctx));
    case 'pwsh':
    case 'powershell': {
      const ci = args.findIndex((a) => /^-(c|command)$/i.test(a));
      const fi = args.findIndex((a) => /^-file$/i.test(a));
      if (ci >= 0 || fi >= 0) {
        let script = args.slice(ci + 1).join(' ');
        if (fi >= 0) {
          const f = fileName(args[fi + 1] ?? '');
          if (!(f in g.files)) return mk([err1(`The argument '${args[fi + 1] ?? ''}' to the -File parameter does not exist. Provide the path to an existing '.ps1' file as an argument to the -File parameter.`)]);
          script = g.files[f];
        }
        const lines: ScratchLine[] = [];
        if (ctx.depth < 6) {
          ctx.depth++;
          runPwshText(ctx, script, lines);
          ctx.depth--;
        }
        return { lines, ok: !hasError(lines) };
      }
      g.sh.mode = 'pwsh';
      return mk(MODE_BANNER.pwsh);
    }
    case 'bash':
    case 'sh':
    case 'source':
    case '.': {
      const f = plain[0];
      if (!f) return mk([]);
      return runScript(ctx, f);
    }
    default:
      if (name?.startsWith('./') && name.endsWith('.sh')) return runScript(ctx, name);
  }
  return runEngine(ctx, argv);
}

function runScript<G extends ShellState>(ctx: Ctx<G>, file: string): Ran {
  const f = fileName(file);
  if (!(f in ctx.g.files)) return { lines: [err1(`bash: ${file}: No such file or directory`)], ok: false };
  if (ctx.depth >= 4) return { lines: [err1(`bash: ${file}: too many nested scripts`)], ok: false };
  const grabbed: ScratchLine[] = [];
  ctx.depth++;
  runBashText(ctx, ctx.g.files[f], grabbed);
  ctx.depth--;
  return { lines: grabbed, ok: !hasError(grabbed) };
}

// ---- running statements ----

function deliver<G extends ShellState>(ctx: Ctx<G>, st: Stage, ran: Ran, capture: ScratchLine[] | null) {
  const errs = ran.lines.filter((l) => l.type === 'error' && !st.hideErr);
  const body = ran.lines.filter((l) => l.type !== 'error');
  if (st.out === 'null') {
    emit(ctx, errs);
    return;
  }
  if (st.out) {
    emit(ctx, errs);
    if (errs.length) return; // a failed command writes nothing
    const content = body.map((l) => (l.text === ' ' ? '' : l.text)).join('\n') + (body.length ? '\n' : '');
    const why = writeFileChecked(ctx.g, st.out.file, content, st.out.append, ctx.host.cfg);
    const n = fileName(st.out.file);
    if (why === 'readonly') emit(ctx, [err1(`bash: ${n}: Permission denied (read-only)`)]);
    else if (why === 'badname') emit(ctx, [err1(`ERR '${st.out.file}' is not a usable file name. Use letters, digits, . _ - and stay in ~/scratch.`)]);
    else if (why === 'full') emit(ctx, [err1(`ERR ~/scratch is full (${ctx.host.cfg.max ?? 12} files). Remove one with: rm <file>`)]);
    else emit(ctx, [out1(`OK  wrote ${lineCountOf(content)} line${lineCountOf(content) === 1 ? '' : 's'} to ~/scratch/${n}`, 'success')]);
    return;
  }
  if (capture) {
    emit(ctx, errs);
    capture.push(...body);
  } else emit(ctx, [...errs, ...body]);
}

function runStatement<G extends ShellState>(ctx: Ctx<G>, s: RawStmt, capture: ScratchLine[] | null): boolean {
  const { stages, error } = tokenize(ctx, s.text, s.heredocs);
  if (error) {
    emit(ctx, [err1(error)]);
    ctx.g.sh.bash['?'] = '2';
    return false;
  }
  let stdin: string | null = null;
  let ok = true;
  for (let k = 0; k < stages.length; k++) {
    const st = stages[k];
    const assigns: [string, string][] = [];
    while (st.argv.length && /^[A-Za-z_]\w*=/.test(st.argv[0])) {
      const w = st.argv.shift() as string;
      const eq = w.indexOf('=');
      assigns.push([w.slice(0, eq), w.slice(eq + 1)]);
    }
    assigns.forEach(([key, val]) => (ctx.g.sh.bash[key] = val));
    if (!st.argv.length) {
      ok = true;
      continue;
    }
    if (st.stdin !== undefined) stdin = st.stdin;
    const modeBefore = ctx.g.sh.mode;
    const ran: Ran = runCmd(ctx, st.argv, stdin);
    ok = ran.ok;
    if (k < stages.length - 1) {
      emit(ctx, ran.lines.filter((l) => l.type === 'error'));
      stdin = ran.lines.filter((l) => l.type !== 'error').map((l) => (l.text === ' ' ? '' : l.text)).join('\n') + '\n';
    } else {
      deliver(ctx, st, ran, capture);
      stdin = null;
    }
    if (ctx.g.sh.mode !== modeBefore) break;
  }
  ctx.g.sh.bash['?'] = ok ? '0' : '1';
  return ok;
}

/** Runs bash text. With `capture`, normal output is collected there instead of printed (command substitution, scripts). */
export function runBashText<G extends ShellState>(ctx: Ctx<G>, src: string, capture: ScratchLine[] | null): void {
  const { stmts } = splitBash(src);
  const mode = ctx.g.sh.mode;
  let ok = true;
  let prevSep: ';' | '&&' | '||' = ';';
  for (const s of stmts) {
    const skip = (prevSep === '&&' && !ok) || (prevSep === '||' && ok);
    prevSep = s.sep;
    if (skip) continue;
    ok = runStatement(ctx, s, capture);
    if (ctx.g.sh.mode !== mode) return;
  }
}

// ---- entry points ----

/** Runs whatever was typed (one line or several) in the current shell and returns the new game state. */
export function runShell<G extends ShellState>(prev: G, text: string, host: Host<G>): G {
  const src = text.replace(/\s+$/, '');
  if (!src.trim()) return prev;
  const g: G = {
    ...prev,
    files: { ...prev.files },
    history: [...prev.history],
    sh: { mode: prev.sh.mode, bash: { ...prev.sh.bash }, pwsh: { ...prev.sh.pwsh } },
  };
  const mode = g.sh.mode;
  const base = host.prompt(g);
  src.split('\n').forEach((l, i) => g.history.push({ text: `${i === 0 ? promptFor(base, mode) : mode === 'bash' ? '>' : '>>'} ${l}`, type: 'input' }));
  const ctx: Ctx<G> = { g, host, depth: 0, inline: 0 };
  if (mode === 'bash') runBashText(ctx, src, null);
  else runPwshText(ctx, src, null);
  return ctx.g;
}

/** Switches shell from the UI tabs. */
export function setMode<G extends ShellState>(prev: G, mode: Mode): G {
  if (prev.sh.mode === mode) return prev;
  return { ...prev, sh: { ...prev.sh, mode }, history: [...prev.history, ...MODE_BANNER[mode]] };
}
