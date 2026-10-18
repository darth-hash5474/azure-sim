// A small PowerShell for the simulators: lexer, parser, evaluator, the usual file/JSON cmdlets, and the hook for each
// lab's Az cmdlets (see CmdletDef in shellcore.ts). It is a subset: enough to read JSON, edit it as an object, write it
// back, loop over resources and call Az cmdlets or az.
import { fileName, type LineType, type ScratchLine } from './scratch';
import {
  MODE_BANNER,
  PsLine,
  SHELL_HELP,
  cmdletList,
  customObjects,
  emit,
  err1,
  isObj,
  keyOf,
  lineCountOf,
  out1,
  prop,
  runEngine,
  toStr,
  wildcard,
  writeFileChecked,
  type Bound,
  type Build,
  type CmdletDef,
  type Ctx,
  type Ran,
  type ShellState,
} from './shellcore';

class PsError extends Error {}
class PsParseError extends Error {}

// ---- lexer ----

type StrPart = string | { v: string } | { sub: string };

interface Tok {
  k: 'num' | 'str' | 'estr' | 'var' | 'word' | 'dash' | 'op' | 'nl' | 'eof' | 'splat' | 'badsplat';
  v: string;
  sp: boolean;
  parts?: StrPart[];
  colon?: boolean;
}

const NAMEY = /[A-Za-z_]/;
const STOP = new Set([' ', '\t', '\r', '\n', ';', '|', '(', ')', '{', '}', "'", '"', ',', ']', '>', '`']);

function lex(src: string): { toks: Tok[]; open: boolean; cont: boolean } {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  let sp = true;
  let open = false;
  let cont = false;
  const push = (t: Omit<Tok, 'sp'>) => {
    toks.push({ ...t, sp });
    sp = false;
  };
  const prev = () => toks[toks.length - 1];
  const operandEnd = () => {
    const p = prev();
    return !!p && (p.k === 'var' || p.k === 'str' || p.k === 'estr' || (p.k === 'op' && (p.v === ')' || p.v === ']')) || (p.k === 'word' && p.v !== '%'));
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      sp = true;
      i++;
    } else if (c === '`' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      i += src[i + 1] === '\n' ? 2 : 3;
      sp = true;
      cont = i >= n;
    } else if (c === '`' && i + 1 >= n) {
      cont = true;
      i++;
    } else if (c === '\n') {
      push({ k: 'nl', v: '\n' });
      i++;
      sp = true;
    } else if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '<' && src[i + 1] === '#') {
      const e = src.indexOf('#>', i + 2);
      if (e < 0) {
        open = true;
        i = n;
      } else i = e + 2;
      sp = true;
    } else if (c === "'") {
      let s = '';
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        s += src[j++];
      }
      if (!closed) open = true;
      push({ k: 'str', v: s });
      i = j + 1;
    } else if (c === '"') {
      const r = lexDq(src, i);
      if (r.open) open = true;
      push({ k: 'estr', v: '', parts: r.parts });
      i = r.end;
    } else if (c === '@' && (src[i + 1] === "'" || src[i + 1] === '"') && /^[ \t]*\r?\n/.test(src.slice(i + 2))) {
      const q = src[i + 1];
      const bodyStart = src.indexOf('\n', i + 2) + 1;
      const term = src.indexOf(`\n${q}@`, bodyStart - 1);
      const endAtStart = src.startsWith(`${q}@`, bodyStart);
      if (!endAtStart && term < 0) {
        open = true;
        i = n;
        push({ k: 'str', v: '' });
      } else {
        const body = endAtStart ? '' : src.slice(bodyStart, term).replace(/\r$/, '');
        if (q === "'") push({ k: 'str', v: body });
        else push({ k: 'estr', v: '', parts: lexDq(`"${body.replace(/"/g, '""')}"`, 0).parts });
        i = (endAtStart ? bodyStart : term + 1) + 2;
      }
    } else if (c === '@' && src[i + 1] === '(') {
      push({ k: 'op', v: '@(' });
      i += 2;
    } else if (c === '@' && src[i + 1] === '{') {
      push({ k: 'op', v: '@{' });
      i += 2;
    } else if (c === '@' && NAMEY.test(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && !STOP.has(src[j])) j++;
      const run = src.slice(i, j);
      push(/^@\w+$/.test(run) ? { k: 'splat', v: run.slice(1) } : { k: 'badsplat', v: run });
      i = j;
    } else if (c === '$' && src[i + 1] === '(') {
      push({ k: 'op', v: '$(' });
      i += 2;
    } else if (c === '$') {
      const m = /^\$(?:\{([^}]*)\}|(\w+(?::\w+)?)|([?$^]))/.exec(src.slice(i));
      if (m) {
        push({ k: 'var', v: m[1] ?? m[2] ?? m[3] });
        i += m[0].length;
      } else {
        push({ k: 'word', v: '$' });
        i++;
      }
    } else if (c === '.' && !sp && operandEnd() && NAMEY.test(src[i + 1] ?? '')) {
      push({ k: 'op', v: '.' });
      i++;
      let j = i;
      while (j < n && /\w/.test(src[j])) j++;
      push({ k: 'word', v: src.slice(i, j) });
      sp = false;
      i = j;
    } else if (c === ':' && src[i + 1] === ':') {
      push({ k: 'op', v: '::' });
      i += 2;
    } else if (c === ';') {
      push({ k: 'nl', v: ';' });
      i++;
    } else if ('(){}[],|&!='.includes(c)) {
      push({ k: 'op', v: c });
      i++;
    } else if (c === '>') {
      const v = src[i + 1] === '>' ? '>>' : '>';
      push({ k: 'op', v });
      i += v.length;
    } else if (c === '+' && src[i + 1] === '=') {
      push({ k: 'op', v: '+=' });
      i += 2;
    } else if (c === '-' && /^--?[A-Za-z]/.test(src.slice(i, i + 3)) && !(operandEnd() && !sp)) {
      const m = /^--?[A-Za-z][\w-]*/.exec(src.slice(i)) as RegExpExecArray;
      i += m[0].length;
      const colon = src[i] === ':' && !/\s/.test(src[i + 1] ?? ' ');
      if (colon) i++;
      push({ k: 'dash', v: m[0], colon });
    } else if ((c === '+' || c === '-' || c === '*' || c === '/' || c === '%') && /[\s$(]/.test(src[i + 1] ?? ' ')) {
      push({ k: 'op', v: c });
      i++;
    } else {
      let j = i;
      while (j < n) {
        const d = src[j];
        if (STOP.has(d)) break;
        if (d === '=' && (j + 1 >= n || /[\s'"$@(]/.test(src[j + 1]))) break;
        j++;
      }
      if (j === i) j = i + 1;
      push({ k: 'word', v: src.slice(i, j) });
      i = j;
    }
  }
  push({ k: 'eof', v: '' });
  return { toks, open, cont };
}

function lexDq(src: string, start: number): { parts: StrPart[]; end: number; open: boolean } {
  const parts: StrPart[] = [];
  const n = src.length;
  let lit = '';
  let i = start + 1;
  let closed = false;
  const flush = () => {
    if (lit) parts.push(lit);
    lit = '';
  };
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      if (src[i + 1] === '"') {
        lit += '"';
        i += 2;
        continue;
      }
      closed = true;
      i++;
      break;
    }
    if (c === '`') {
      const d = src[i + 1] ?? '';
      lit += d === 'n' ? '\n' : d === 't' ? '\t' : d === 'r' ? '\r' : d === '0' ? '\0' : d;
      i += 2;
      continue;
    }
    if (c === '$') {
      if (src[i + 1] === '(') {
        let depth = 0;
        let j = i + 1;
        for (; j < n; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')' && --depth === 0) break;
        }
        flush();
        parts.push({ sub: src.slice(i + 2, j) });
        i = j + 1;
        continue;
      }
      const m = /^\$(?:\{([^}]*)\}|(\w+(?::\w+)?)|([?]))/.exec(src.slice(i));
      if (m) {
        flush();
        parts.push({ v: m[1] ?? m[2] ?? m[3] });
        i += m[0].length;
        continue;
      }
    }
    lit += c;
    i++;
  }
  flush();
  return { parts, end: i, open: !closed };
}

/** True while the typed text is not a finished PowerShell command yet. */
export function pwshIncomplete(src: string): boolean {
  const { toks, open, cont } = lex(src);
  if (open || cont) return true;
  let depth = 0;
  for (const t of toks) {
    if (t.k !== 'op') continue;
    if (['(', '{', '[', '@(', '@{', '$('].includes(t.v)) depth++;
    else if ([')', '}', ']'].includes(t.v)) depth--;
  }
  if (depth > 0) return true;
  const last = [...toks].reverse().find((t) => t.k !== 'eof' && t.k !== 'nl');
  const end = toks[toks.length - 2];
  return !!last && end?.k !== 'nl' && last.k === 'op' && ['|', ',', '='].includes(last.v);
}

// ---- parser ----

type Expr =
  | { t: 'lit'; v: unknown }
  | { t: 'str'; parts: StrPart[] }
  | { t: 'var'; name: string }
  | { t: 'arr'; items: Expr[] }
  | { t: 'hash'; entries: [Expr, Expr][] }
  | { t: 'sub'; body: Stmt[]; array: boolean }
  | { t: 'paren'; body: Pipe }
  | { t: 'member'; obj: Expr; name: Expr; call?: Expr[] }
  | { t: 'index'; obj: Expr; idx: Expr }
  | { t: 'static'; type: string; name: string; call?: Expr[] }
  | { t: 'type'; name: string }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'un'; op: string; e: Expr }
  | { t: 'cast'; type: string; e: Expr }
  | { t: 'block'; body: Stmt[] };

type Arg = { p: string; colon?: Expr } | { v: Expr } | { splat: string };
type Elem = { t: 'expr'; e: Expr } | { t: 'cmd'; name: string; args: Arg[] };
type Pipe = { t: 'pipe'; els: Elem[]; redir?: { append: boolean; target: Expr } };
type Stmt =
  | Pipe
  | { t: 'assign'; lhs: Expr; op: string; rhs: Pipe }
  | { t: 'foreach'; v: string; src: Pipe; body: Stmt[] }
  | { t: 'if'; branches: [Pipe, Stmt[]][]; other?: Stmt[] }
  | { t: 'try'; body: Stmt[]; catchBody?: Stmt[]; fin?: Stmt[] };

const CMP = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'notlike', 'match', 'notmatch', 'contains', 'notcontains', 'in', 'notin', 'is', 'isnot', 'replace', 'split', 'ceq', 'cne', 'ieq', 'ine']);

class Parser {
  toks: Tok[];
  pos = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(o = 0): Tok {
    return this.toks[Math.min(this.pos + o, this.toks.length - 1)];
  }
  next(): Tok {
    const t = this.peek();
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }
  isOp(v: string, o = 0) {
    const t = this.peek(o);
    return t.k === 'op' && t.v === v;
  }
  isDash(v: string) {
    const t = this.peek();
    return t.k === 'dash' && t.v.toLowerCase() === `-${v}`;
  }
  isWord(v: string, o = 0) {
    const t = this.peek(o);
    return t.k === 'word' && t.v.toLowerCase() === v;
  }
  expect(v: string) {
    if (!this.isOp(v)) throw new PsParseError(`Missing closing '${v}' or unexpected token '${this.peek().v || 'end of input'}'.`);
    this.next();
  }
  skipNl() {
    while (this.peek().k === 'nl') this.next();
  }

  program(until?: string): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      this.skipNl();
      const t = this.peek();
      if (t.k === 'eof') {
        if (until) throw new PsParseError(`Missing closing '${until}'.`);
        return out;
      }
      if (until && this.isOp(until)) {
        this.next();
        return out;
      }
      out.push(this.statement());
      const e = this.peek();
      if (e.k !== 'nl' && e.k !== 'eof' && !(until && this.isOp(until))) throw new PsParseError(`Unexpected token '${e.v}' in expression or statement.`);
    }
  }

  block(): Stmt[] {
    this.skipNl();
    this.expect('{');
    return this.program('}');
  }

  statement(): Stmt {
    const t = this.peek();
    if (t.k === 'word') {
      const w = t.v.toLowerCase();
      if (w === 'foreach' && this.isOp('(', 1)) {
        this.next();
        this.next();
        const v = this.next();
        if (v.k !== 'var') throw new PsParseError("Missing variable name after 'foreach'.");
        if (!this.isWord('in')) throw new PsParseError("Missing 'in' after variable in foreach loop.");
        this.next();
        const src = this.pipeline();
        this.expect(')');
        return { t: 'foreach', v: v.v, src, body: this.block() };
      }
      if (w === 'if' && this.isOp('(', 1)) {
        const branches: [Pipe, Stmt[]][] = [];
        let other: Stmt[] | undefined;
        this.next();
        this.next();
        let cond = this.pipeline();
        this.expect(')');
        branches.push([cond, this.block()]);
        for (;;) {
          const save = this.pos;
          this.skipNl();
          if (this.isWord('elseif') && this.isOp('(', 1)) {
            this.next();
            this.next();
            cond = this.pipeline();
            this.expect(')');
            branches.push([cond, this.block()]);
          } else if (this.isWord('else')) {
            this.next();
            other = this.block();
            break;
          } else {
            this.pos = save;
            break;
          }
        }
        return { t: 'if', branches, other };
      }
      if (w === 'try' && this.isOp('{', 1)) {
        this.next();
        const body = this.block();
        let catchBody: Stmt[] | undefined;
        let fin: Stmt[] | undefined;
        for (;;) {
          const save = this.pos;
          this.skipNl();
          if (this.isWord('catch')) {
            this.next();
            while (!this.isOp('{') && this.peek().k !== 'eof') this.next();
            catchBody = this.block();
          } else if (this.isWord('finally')) {
            this.next();
            fin = this.block();
          } else {
            this.pos = save;
            break;
          }
        }
        return { t: 'try', body, catchBody, fin };
      }
    }
    if (t.k === 'var') {
      const save = this.pos;
      const lhs = this.postfix();
      if (this.isOp('=') || this.isOp('+=')) {
        const op = this.next().v;
        this.skipNl();
        return { t: 'assign', lhs, op, rhs: this.pipeline() };
      }
      this.pos = save;
    }
    return this.pipeline();
  }

  pipeline(): Pipe {
    const els: Elem[] = [this.element()];
    while (this.isOp('|')) {
      this.next();
      this.skipNl();
      els.push(this.element());
    }
    let redir: Pipe['redir'];
    if (this.isOp('>') || this.isOp('>>')) {
      const append = this.next().v === '>>';
      redir = { append, target: this.argAtom() };
    }
    return { t: 'pipe', els, redir };
  }

  element(): Elem {
    let t = this.peek();
    if (t.k === 'op' && t.v === '&') {
      this.next();
      t = this.peek();
      if (t.k === 'str' || t.k === 'word') return this.command();
      throw new PsParseError("The ampersand (&) character is not allowed here. Use '& name' to call a command.");
    }
    if (t.k === 'word' && !/^-?\d+(\.\d+)?$/.test(t.v)) return this.command();
    return { t: 'expr', e: this.expr() };
  }

  command(): Elem {
    const nameTok = this.next();
    const args: Arg[] = [];
    for (;;) {
      const t = this.peek();
      if (t.k === 'nl' || t.k === 'eof') break;
      if (t.k === 'op' && [')', '}', '|', '>', '>>'].includes(t.v)) break;
      if (t.k === 'dash') {
        this.next();
        args.push(t.colon ? { p: t.v, colon: this.argValue() } : { p: t.v });
      } else if (t.k === 'splat') {
        this.next();
        args.push({ splat: t.v });
      } else if (t.k === 'badsplat') {
        const name = t.v.split(/[^\w@]/)[0];
        throw new PsParseError(`The splatting operator '@' cannot be used to reference variables in an expression. '${name}' can be used only as an argument to a command. To reference variables in an expression use '$${name.slice(1)}'. (In PowerShell, quote it: '${t.v}')`);
      } else args.push({ v: this.argValue() });
    }
    return { t: 'cmd', name: nameTok.v, args };
  }

  argValue(): Expr {
    const first = this.argAtom();
    if (!this.isOp(',')) return first;
    const items = [first];
    while (this.isOp(',')) {
      this.next();
      items.push(this.argAtom());
    }
    return { t: 'arr', items };
  }

  argAtom(): Expr {
    const t = this.peek();
    if (t.k === 'word') {
      this.next();
      return { t: 'lit', v: /^-?\d+(\.\d+)?$/.test(t.v) ? Number(t.v) : t.v };
    }
    return this.postfix();
  }

  // expression grammar, loosest first
  expr(): Expr {
    return this.orExpr();
  }
  orExpr(): Expr {
    let l = this.andExpr();
    while (this.isDash('or') || this.isDash('xor')) {
      const op = this.next().v.slice(1).toLowerCase();
      l = { t: 'bin', op, l, r: this.andExpr() };
    }
    return l;
  }
  andExpr(): Expr {
    let l = this.notExpr();
    while (this.isDash('and')) {
      this.next();
      l = { t: 'bin', op: 'and', l, r: this.notExpr() };
    }
    return l;
  }
  notExpr(): Expr {
    if (this.isDash('not') || this.isOp('!')) {
      this.next();
      return { t: 'un', op: 'not', e: this.notExpr() };
    }
    return this.cmpExpr();
  }
  cmpExpr(): Expr {
    let l = this.addExpr();
    for (;;) {
      const t = this.peek();
      const name = t.k === 'dash' ? t.v.slice(1).toLowerCase() : '';
      if (t.k === 'dash' && (CMP.has(name) || name === 'join')) {
        this.next();
        l = { t: 'bin', op: name, l, r: this.addExpr() };
      } else return l;
    }
  }
  addExpr(): Expr {
    let l = this.mulExpr();
    while (this.isOp('+') || (this.peek().k === 'op' && this.peek().v === '-')) {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.mulExpr() };
    }
    return l;
  }
  mulExpr(): Expr {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if ((t.k === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) || (t.k === 'word' && t.v === '%')) {
        this.next();
        l = { t: 'bin', op: t.v, l, r: this.unary() };
      } else if (this.isDash('f')) {
        this.next();
        l = { t: 'bin', op: 'f', l, r: this.unary() };
      } else return l;
    }
  }
  unary(): Expr {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.next().v;
      return { t: 'un', op: op === '-' ? 'neg' : 'pos', e: this.unary() };
    }
    if (this.isDash('join') || this.isDash('split')) {
      const op = this.next().v.slice(1).toLowerCase();
      return { t: 'un', op, e: this.unary() };
    }
    if (this.isOp('!') || this.isDash('not')) {
      this.next();
      return { t: 'un', op: 'not', e: this.unary() };
    }
    return this.commaExpr();
  }
  commaExpr(): Expr {
    const first = this.postfix();
    if (!this.isOp(',')) return first;
    const items = [first];
    while (this.isOp(',')) {
      this.next();
      items.push(this.postfix());
    }
    return { t: 'arr', items };
  }

  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && t.v === '.' && !t.sp) {
        this.next();
        const nt = this.next();
        const name: Expr = nt.k === 'var' ? { t: 'var', name: nt.v } : nt.k === 'estr' ? { t: 'str', parts: nt.parts ?? [] } : { t: 'lit', v: nt.v };
        if (this.isOp('(') && !this.peek().sp) {
          this.next();
          e = { t: 'member', obj: e, name, call: this.callArgs() };
        } else e = { t: 'member', obj: e, name };
      } else if (t.k === 'op' && t.v === '[' && !t.sp) {
        this.next();
        const idx = this.expr();
        this.expect(']');
        e = { t: 'index', obj: e, idx };
      } else if (t.k === 'op' && t.v === '::' && e.t === 'type') {
        this.next();
        const nt = this.next();
        if (this.isOp('(')) {
          this.next();
          e = { t: 'static', type: e.name, name: nt.v, call: this.callArgs() };
        } else e = { t: 'static', type: e.name, name: nt.v };
      } else return e;
    }
  }

  callArgs(): Expr[] {
    const args: Expr[] = [];
    this.skipNl();
    while (!this.isOp(')')) {
      args.push(this.expr());
      this.skipNl();
      if (this.isOp(',')) this.next();
      this.skipNl();
      if (this.peek().k === 'eof') throw new PsParseError("Missing ')' in method call.");
    }
    this.next();
    return args;
  }

  primary(): Expr {
    const t = this.next();
    switch (t.k) {
      case 'word':
        return { t: 'lit', v: /^-?\d+(\.\d+)?$/.test(t.v) ? Number(t.v) : t.v };
      case 'str':
        return { t: 'lit', v: t.v };
      case 'estr':
        return { t: 'str', parts: t.parts ?? [] };
      case 'var':
        return { t: 'var', name: t.v };
      case 'splat':
        return { t: 'var', name: t.v };
      case 'badsplat':
        throw new PsParseError(`The splatting operator '@' cannot be used to reference variables in an expression. '${t.v.split(/[^\w@]/)[0]}' can be used only as an argument to a command.`);
      case 'op':
        break;
      default:
        throw new PsParseError(`Unexpected token '${t.v || 'end of input'}' in expression or statement.`);
    }
    switch (t.v) {
      case '(': {
        this.skipNl();
        const body = this.pipeline();
        this.skipNl();
        this.expect(')');
        return { t: 'paren', body };
      }
      case '$(':
        return { t: 'sub', body: this.program(')'), array: false };
      case '@(':
        return { t: 'sub', body: this.program(')'), array: true };
      case '@{': {
        const entries: [Expr, Expr][] = [];
        for (;;) {
          this.skipNl();
          if (this.isOp('}')) {
            this.next();
            break;
          }
          const kt = this.next();
          let key: Expr;
          let valueNow: Expr | undefined;
          if (kt.k === 'word' && kt.v.includes('=')) {
            const eq = kt.v.indexOf('=');
            key = { t: 'lit', v: kt.v.slice(0, eq) };
            const rest = kt.v.slice(eq + 1);
            if (rest) valueNow = { t: 'lit', v: /^-?\d+(\.\d+)?$/.test(rest) ? Number(rest) : rest };
          } else if (kt.k === 'word' || kt.k === 'str') key = { t: 'lit', v: kt.v };
          else if (kt.k === 'estr') key = { t: 'str', parts: kt.parts ?? [] };
          else if (kt.k === 'var') key = { t: 'var', name: kt.v };
          else throw new PsParseError(`Invalid hash literal: unexpected '${kt.v}'.`);
          if (!valueNow) {
            if (!(kt.k === 'word' && kt.v.includes('=') && !valueNow)) this.expect('=');
            this.skipNl();
            valueNow = this.statementValue();
          }
          entries.push([key, valueNow]);
          if (this.peek().k !== 'nl' && !this.isOp('}')) throw new PsParseError(`Unexpected token '${this.peek().v}' in hash literal.`);
        }
        return { t: 'hash', entries };
      }
      case '{':
        return { t: 'block', body: this.program('}') };
      case '[': {
        let name = '';
        while (!this.isOp(']') && this.peek().k !== 'eof') name += this.next().v;
        this.expect(']');
        const type: Expr = { t: 'type', name };
        if (this.isOp('::')) return type;
        return { t: 'cast', type: name, e: this.unary() };
      }
      default:
        throw new PsParseError(`Unexpected token '${t.v}' in expression or statement.`);
    }
  }

  /** A hashtable value: an expression, or a pipeline such as (Get-Content ...) | ConvertFrom-Json. */
  statementValue(): Expr {
    const p = this.pipeline();
    return p.els.length === 1 && p.els[0].t === 'expr' && !p.redir ? p.els[0].e : { t: 'paren', body: p };
  }
}

function parse(src: string): Stmt[] {
  const { toks, open } = lex(src);
  if (open) throw new PsParseError('The string is missing the terminator or a block comment is not closed.');
  return new Parser(toks).program();
}

// ---- runtime ----

interface Rt<G extends ShellState = ShellState> {
  ctx: Ctx<G>;
  capture: ScratchLine[] | null;
  cmdlets: Map<string, { name: string; def: CmdletDef }>;
}

const vars = (rt: Rt) => rt.ctx.g.sh.pwsh;
const home = (rt: Rt) => '/home/' + rt.ctx.host.prompt(rt.ctx.g).split('@')[0];
const say = (rt: Rt, lines: ScratchLine[]) => (rt.capture ? rt.capture.push(...lines) : emit(rt.ctx, lines));

const truthy = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '';
  if (v instanceof PsLine) return v.text !== '';
  if (Array.isArray(v)) return v.length === 0 ? false : v.length === 1 ? truthy(v[0]) : true;
  return true;
};

const collapse = (items: unknown[]): unknown => (items.length === 0 ? null : items.length === 1 ? items[0] : items);
const unroll = (v: unknown): unknown[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(toStr(v));
  if (Number.isNaN(n)) throw new PsError(`Cannot convert value "${toStr(v)}" to type "System.Int32". Error: "The input string '${toStr(v)}' was not in a correct format."`);
  return n;
};

const getVar = (rt: Rt, name: string): unknown => {
  const low = name.toLowerCase();
  switch (low) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'null':
      return null;
    case 'psitem':
      return vars(rt)._ ?? null;
    case 'home':
    case 'env:home':
      return home(rt);
    case 'pwd':
      return home(rt);
    case 'psversiontable':
      return { PSVersion: '7.4.5', PSEdition: 'Core', Platform: 'Unix' };
    default:
      return vars(rt)[low] ?? null;
  }
};

const psEq = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'string' || a instanceof PsLine) return toStr(a).toLowerCase() === toStr(b).toLowerCase();
  if (typeof a === 'number') return a === Number(toStr(b));
  if (typeof a === 'boolean') return a === truthy(b);
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
};

const likeRe = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|\\[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

function binop(op: string, l: unknown, r: unknown): unknown {
  const filter = (f: (x: unknown) => boolean) => (Array.isArray(l) ? l.filter(f) : f(l));
  switch (op) {
    case '+':
      if (typeof l === 'number' && (typeof r === 'number' || /^-?\d+(\.\d+)?$/.test(toStr(r)))) return l + Number(toStr(r));
      if (Array.isArray(l)) return [...l, ...unroll(r)];
      if (l === null || l === undefined) return r;
      if (isObj(l) && isObj(r)) return { ...l, ...r };
      return toStr(l) + toStr(r);
    case '-':
      return num(l) - num(r);
    case '*':
      return typeof l === 'string' ? l.repeat(num(r)) : num(l) * num(r);
    case '/':
      return num(l) / num(r);
    case '%':
      return num(l) % num(r);
    case 'f':
      return toStr(l).replace(/\{(\d+)\}/g, (_, k) => toStr(unroll(r)[Number(k)]));
    case 'eq':
    case 'ceq':
    case 'ieq':
      return filter((x) => psEq(x, r));
    case 'ne':
    case 'cne':
    case 'ine':
      return filter((x) => !psEq(x, r));
    case 'gt':
      return filter((x) => (typeof x === 'number' || !Number.isNaN(Number(toStr(x))) ? num(x) > num(r) : toStr(x).toLowerCase() > toStr(r).toLowerCase()));
    case 'ge':
      return filter((x) => num(x) >= num(r));
    case 'lt':
      return filter((x) => num(x) < num(r));
    case 'le':
      return filter((x) => num(x) <= num(r));
    case 'like':
      return filter((x) => likeRe(toStr(r)).test(toStr(x)));
    case 'notlike':
      return filter((x) => !likeRe(toStr(r)).test(toStr(x)));
    case 'match':
      return filter((x) => new RegExp(toStr(r), 'i').test(toStr(x)));
    case 'notmatch':
      return filter((x) => !new RegExp(toStr(r), 'i').test(toStr(x)));
    case 'contains':
      return unroll(l).some((x) => psEq(x, r));
    case 'notcontains':
      return !unroll(l).some((x) => psEq(x, r));
    case 'in':
      return unroll(r).some((x) => psEq(x, l));
    case 'notin':
      return !unroll(r).some((x) => psEq(x, l));
    case 'replace': {
      const [from, to] = unroll(r);
      return toStr(l).replace(new RegExp(toStr(from), 'gi'), toStr(to ?? ''));
    }
    case 'split':
      return toStr(l).split(new RegExp(toStr(r), 'i'));
    case 'join':
      return unroll(l).map(toStr).join(toStr(r));
    case 'is':
    case 'isnot':
      return op === 'isnot';
    case 'and':
      return truthy(l) && truthy(r);
    case 'or':
      return truthy(l) || truthy(r);
    case 'xor':
      return truthy(l) !== truthy(r);
    default:
      throw new PsError(`Operator '${op}' is not supported in this simulator.`);
  }
}

function getMember(rt: Rt, obj: unknown, name: string): unknown {
  const low = name.toLowerCase();
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) {
    if (low === 'count' || low === 'length') return obj.length;
    return obj.map((x) => getMember(rt, x, name)).filter((x) => x !== null);
  }
  if (typeof obj === 'string') return low === 'length' ? obj.length : null;
  if (obj instanceof PsLine) return low === 'length' ? obj.text.length : null;
  if (isObj(obj)) {
    const k = keyOf(obj, name);
    if (k !== undefined) return obj[k];
    if (!customObjects.has(obj)) {
      if (low === 'keys') return Object.keys(obj);
      if (low === 'values') return Object.values(obj);
      if (low === 'count') return Object.keys(obj).length;
    }
    return null;
  }
  return null;
}

function callMethod(_rt: Rt, obj: unknown, name: string, args: unknown[]): unknown {
  const low = name.toLowerCase();
  const s = toStr(obj);
  if (low === 'tostring') return s;
  if (typeof obj === 'string' || obj instanceof PsLine) {
    const a0 = toStr(args[0]);
    switch (low) {
      case 'trim':
        return s.trim();
      case 'trimend':
        return s.replace(/\s+$/, '');
      case 'trimstart':
        return s.replace(/^\s+/, '');
      case 'tolower':
      case 'tolowerinvariant':
        return s.toLowerCase();
      case 'toupper':
      case 'toupperinvariant':
        return s.toUpperCase();
      case 'replace':
        return s.split(a0).join(toStr(args[1]));
      case 'contains':
        return s.includes(a0);
      case 'startswith':
        return s.toLowerCase().startsWith(a0.toLowerCase());
      case 'endswith':
        return s.toLowerCase().endsWith(a0.toLowerCase());
      case 'split':
        return s.split(a0);
      case 'substring':
        return args[1] === undefined ? s.slice(num(args[0])) : s.substr(num(args[0]), num(args[1]));
      case 'indexof':
        return s.indexOf(a0);
    }
  }
  if (Array.isArray(obj)) {
    if (low === 'contains') return obj.some((x) => psEq(x, args[0]));
    if (low === 'indexof') return obj.findIndex((x) => psEq(x, args[0]));
    if (low === 'add' || low === 'remove') throw new PsError(`Exception calling "${name}" with "1" argument(s): "Collection was of a fixed size." (use $a += $x to grow an array)`);
  }
  if (isObj(obj)) {
    if (low === 'containskey') return keyOf(obj, toStr(args[0])) !== undefined;
    if (low === 'add') {
      if (keyOf(obj, toStr(args[0])) !== undefined) throw new PsError(`MethodInvocationException: Exception calling "Add" with "2" argument(s): "Item has already been added. Key in dictionary: '${toStr(args[0])}'  Key being added: '${toStr(args[0])}'"`);
      obj[toStr(args[0])] = args[1];
      return null;
    }
    if (low === 'remove') {
      const k = keyOf(obj, toStr(args[0]));
      if (k !== undefined) delete obj[k];
      return null;
    }
  }
  throw new PsError(`MethodNotFound: Method invocation failed because [${typeof obj === 'object' ? 'System.Object' : 'System.String'}] does not contain a method named '${name}'.`);
}

const mark = (v: unknown, asHash: boolean): unknown => {
  if (Array.isArray(v)) return v.map((x) => mark(x, asHash));
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = mark(x, asHash);
    if (!asHash) customObjects.add(o);
    return o;
  }
  return v;
};

const pathOf = (rt: Rt, p: string) => {
  const name = fileName(p.replace(/\\/g, '/').replace(/^\/home\/[^/]+\/(scratch\/)?/, ''));
  return { name, full: `${home(rt)}/${name}` };
};

function staticCall(rt: Rt, type: string, name: string, args: unknown[]): unknown {
  const t = type.toLowerCase().replace(/^system\./, '');
  const n = name.toLowerCase();
  if (t === 'io.file' || t === 'file') {
    const { name: f, full } = pathOf(rt, toStr(args[0]));
    if (n === 'exists') return f in rt.ctx.g.files;
    if (n === 'readalltext' || n === 'readalllines') {
      if (!(f in rt.ctx.g.files)) throw new PsError(`MethodInvocationException: Exception calling "${name}" with "1" argument(s): "Could not find file '${full}'."`);
      const text = rt.ctx.g.files[f];
      return n === 'readalltext' ? text : text.replace(/\n$/, '').split('\n');
    }
    if (n === 'writealltext') {
      const why = writeFileChecked(rt.ctx.g, f, toStr(args[1]), false, rt.ctx.host.cfg);
      if (why) throw new PsError(`MethodInvocationException: Exception calling "WriteAllText" with "2" argument(s): "Access to the path '${full}' is denied."`);
      return null;
    }
  }
  if (t === 'string') {
    if (n === 'join') return unroll(args[1]).map(toStr).join(toStr(args[0]));
    if (n === 'isnullorempty') return toStr(args[0]) === '';
  }
  if (t === 'int' || t === 'int32') if (n === 'parse') return num(args[0]);
  if (t === 'math') {
    if (n === 'round') return Math.round(num(args[0]));
    if (n === 'max') return Math.max(...args.map(num));
    if (n === 'min') return Math.min(...args.map(num));
    if (n === 'floor') return Math.floor(num(args[0]));
  }
  throw new PsError(`InvalidOperation: Unable to find type or method [${type}]::${name}. This simulator knows [System.IO.File]::ReadAllText/ReadAllLines/WriteAllText/Exists, [string]::Join/IsNullOrEmpty, [int]::Parse, [math].`);
}

function castTo(type: string, v: unknown): unknown {
  switch (type.toLowerCase()) {
    case 'string':
      return toStr(v);
    case 'int':
    case 'int32':
    case 'long':
      return Math.trunc(num(v));
    case 'double':
    case 'float':
    case 'decimal':
      return num(v);
    case 'bool':
    case 'boolean':
      return truthy(v);
    case 'array':
      return unroll(v);
    case 'string[]':
      return unroll(v).map(toStr);
    case 'pscustomobject':
      return isObj(v) ? mark({ ...v }, false) : v;
    default:
      return v;
  }
}

function evalExpr(rt: Rt, e: Expr): unknown {
  switch (e.t) {
    case 'lit':
      return e.v;
    case 'str':
      return expandStr(rt, e.parts);
    case 'var':
      return getVar(rt, e.name);
    case 'arr':
      return e.items.flatMap((x) => {
        const v = evalExpr(rt, x);
        return [v];
      });
    case 'hash': {
      const h: Record<string, unknown> = {};
      for (const [k, v] of e.entries) h[toStr(evalExpr(rt, k))] = evalExpr(rt, v);
      return h;
    }
    case 'sub': {
      const items = execStmts(rt, e.body);
      return e.array ? items : collapse(items);
    }
    case 'paren':
      return collapse(execPipe(rt, e.body));
    case 'member': {
      const obj = evalExpr(rt, e.obj);
      const name = toStr(evalExpr(rt, e.name));
      return e.call ? callMethod(rt, obj, name, e.call.map((a) => evalExpr(rt, a))) : getMember(rt, obj, name);
    }
    case 'index': {
      const obj = evalExpr(rt, e.obj);
      const idx = evalExpr(rt, e.idx);
      if (Array.isArray(obj)) {
        const i = num(idx);
        return obj[i < 0 ? obj.length + i : i] ?? null;
      }
      if (typeof obj === 'string') return obj[num(idx)] ?? null;
      if (isObj(obj)) return getMember(rt, obj, toStr(idx));
      return null;
    }
    case 'static':
      return staticCall(rt, e.type, e.name, (e.call ?? []).map((a) => evalExpr(rt, a)));
    case 'type':
      return `[${e.name}]`;
    case 'cast':
      return castTo(e.type, evalExpr(rt, e.e));
    case 'un': {
      const v = evalExpr(rt, e.e);
      if (e.op === 'not') return !truthy(v);
      if (e.op === 'neg') return -num(v);
      if (e.op === 'pos') return num(v);
      if (e.op === 'join') return unroll(v).map(toStr).join('');
      return toStr(v).split(/\s+/);
    }
    case 'bin': {
      if (e.op === 'and') return truthy(evalExpr(rt, e.l)) && truthy(evalExpr(rt, e.r));
      if (e.op === 'or') return truthy(evalExpr(rt, e.l)) || truthy(evalExpr(rt, e.r));
      return binop(e.op, evalExpr(rt, e.l), evalExpr(rt, e.r));
    }
    case 'block':
      return { __block: e.body };
  }
}

function expandStr(rt: Rt, parts: StrPart[]): string {
  return parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if ('v' in p) return toStr(getVar(rt, p.v));
      return toStr(collapse(execStmts(rt, parse(p.sub))));
    })
    .join('');
}

const isBlock = (v: unknown): v is { __block: Stmt[] } => isObj(v) && '__block' in v;

function callBlock(rt: Rt, block: unknown, item: unknown): unknown[] {
  if (!isBlock(block)) throw new PsError('Cannot convert the argument to a script block. Use { ... }.');
  const saved = vars(rt)._;
  vars(rt)._ = item;
  try {
    return execStmts(rt, block.__block);
  } finally {
    vars(rt)._ = saved;
  }
}

function setTarget(rt: Rt, lhs: Expr, op: string, value: unknown) {
  const combine = (cur: unknown) => (op === '+=' ? binop('+', cur, value) : value);
  if (lhs.t === 'var') {
    const low = lhs.name.toLowerCase();
    vars(rt)[low] = combine(vars(rt)[low] ?? null);
  } else if (lhs.t === 'member') {
    const obj = evalExpr(rt, lhs.obj);
    const name = toStr(evalExpr(rt, lhs.name));
    if (!isObj(obj)) throw new PsError(`InvalidOperation: The property '${name}' cannot be found on this object. Verify that the property exists and can be set.`);
    const k = keyOf(obj, name) ?? name;
    obj[k] = combine(obj[k] ?? null);
  } else if (lhs.t === 'index') {
    const obj = evalExpr(rt, lhs.obj);
    const idx = evalExpr(rt, lhs.idx);
    if (Array.isArray(obj)) obj[num(idx)] = combine(obj[num(idx)] ?? null);
    else if (isObj(obj)) {
      const k = keyOf(obj, toStr(idx)) ?? toStr(idx);
      obj[k] = combine(obj[k] ?? null);
    } else throw new PsError('InvalidOperation: Unable to index into this value.');
  } else throw new PsError('InvalidOperation: The assignment target is not valid.');
}

function execStmts(rt: Rt, body: Stmt[]): unknown[] {
  const out: unknown[] = [];
  for (const s of body) out.push(...execStmt(rt, s));
  return out;
}

function execStmt(rt: Rt, s: Stmt): unknown[] {
  switch (s.t) {
    case 'pipe':
      return execPipe(rt, s);
    case 'assign': {
      const value = collapse(execPipe(rt, s.rhs));
      setTarget(rt, s.lhs, s.op, value);
      return [];
    }
    case 'foreach': {
      const out: unknown[] = [];
      for (const item of execPipe(rt, s.src)) {
        vars(rt)[s.v.toLowerCase()] = item;
        out.push(...execStmts(rt, s.body));
      }
      return out;
    }
    case 'if': {
      for (const [cond, body] of s.branches) if (truthy(collapse(execPipe(rt, cond)))) return execStmts(rt, body);
      return s.other ? execStmts(rt, s.other) : [];
    }
    case 'try': {
      try {
        return execStmts(rt, s.body);
      } catch (e) {
        if (!(e instanceof PsError) || !s.catchBody) throw e;
        const msg = e.message;
        const rec = { Exception: { Message: msg }, Message: msg, ToString: msg };
        const saved = vars(rt)._;
        vars(rt)._ = rec;
        try {
          return execStmts(rt, s.catchBody);
        } finally {
          vars(rt)._ = saved;
        }
      } finally {
        if (s.fin) execStmts(rt, s.fin);
      }
    }
  }
}

function execPipe(rt: Rt, p: Pipe): unknown[] {
  let items: unknown[] = [];
  p.els.forEach((el, i) => {
    items = el.t === 'expr' ? unroll(evalExpr(rt, el.e)) : evalCmd(rt, el, i === 0 ? [] : items);
  });
  if (p.redir) {
    const target = toStr(evalExpr(rt, p.redir.target));
    const text = fmtItems(items).map((l) => (l.text === ' ' ? '' : l.text)).join('\n') + '\n';
    writeOut(rt, '>', target, text, p.redir.append);
    return [];
  }
  return items;
}

function writeOut(rt: Rt, cmd: string, target: string, text: string, append: boolean) {
  const { name, full } = pathOf(rt, target);
  const why = writeFileChecked(rt.ctx.g, name, text, append, rt.ctx.host.cfg);
  if (why === 'readonly') throw new PsError(`${cmd}: Access to the path '${full}' is denied.`);
  if (why === 'badname') throw new PsError(`${cmd}: Could not find a part of the path '${full}'. (Scratch files live directly in ~/scratch: letters, digits, . _ -)`);
  if (why === 'full') throw new PsError(`${cmd}: ~/scratch is full (${rt.ctx.host.cfg.max ?? 12} files). Remove one with Remove-Item.`);
  say(rt, [out1(`OK  wrote ${lineCountOf(text)} line${lineCountOf(text) === 1 ? '' : 's'} to ~/scratch/${name}`, 'success')]);
}

// ---- command binding ----

type ArgItem = { kind: 'param'; name: string; has: boolean; value?: unknown } | { kind: 'val'; value: unknown };

function evalArgs(rt: Rt, args: Arg[]): ArgItem[] {
  const out: ArgItem[] = [];
  for (const a of args) {
    if ('p' in a) out.push(a.colon ? { kind: 'param', name: a.p, has: true, value: evalExpr(rt, a.colon) } : { kind: 'param', name: a.p, has: false });
    else if ('splat' in a) {
      const v = getVar(rt, a.splat);
      if (isObj(v)) Object.entries(v).forEach(([k, x]) => out.push({ kind: 'param', name: `-${k}`, has: true, value: x }));
      else unroll(v).forEach((x) => out.push({ kind: 'val', value: x }));
    } else out.push({ kind: 'val', value: evalExpr(rt, a.v) });
  }
  return out;
}

interface Spec {
  params: string[];
  switches?: string[];
  positional?: string[];
  rest?: boolean;
}

const COMMON_VALUE = ['erroraction', 'errorvariable', 'warningaction', 'warningvariable', 'outvariable', 'informationaction', 'outbuffer', 'pipelinevariable'];
const COMMON_SWITCH = ['verbose', 'debug', 'whatif', 'confirm'];

function bind(cmd: string, spec: Spec, items: ArgItem[]): Bound {
  const table: { canon: string; names: string[]; sw: boolean }[] = [
    ...spec.params.map((p) => {
      const [canon, ...al] = p.split('|');
      return { canon: canon.toLowerCase(), names: [canon.toLowerCase(), ...al.map((x) => x.toLowerCase())], sw: false };
    }),
    ...(spec.switches ?? []).map((p) => {
      const [canon, ...al] = p.split('|');
      return { canon: canon.toLowerCase(), names: [canon.toLowerCase(), ...al.map((x) => x.toLowerCase())], sw: true };
    }),
    ...COMMON_VALUE.map((c) => ({ canon: `~${c}`, names: [c], sw: false })),
    ...COMMON_SWITCH.map((c) => ({ canon: `~${c}`, names: [c], sw: true })),
  ];
  const bound: Bound = {};
  const loose: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'val') {
      loose.push(it.value);
      continue;
    }
    const want = it.name.replace(/^-+/, '').toLowerCase();
    let hit = table.find((t) => t.names.includes(want));
    if (!hit) {
      const pre = table.filter((t) => t.names.some((nm) => nm.startsWith(want)));
      if (pre.length === 1) hit = pre[0];
      else if (pre.length > 1) throw new PsError(`${cmd}: Parameter cannot be processed because the parameter name '${it.name.replace(/^-+/, '')}' is ambiguous. Possible matches include: ${pre.map((t) => '-' + t.names[0]).join(' ')}.`);
    }
    if (!hit) throw new PsError(`${cmd}: A parameter cannot be found that matches parameter name '${it.name.replace(/^-+/, '')}'.`);
    if (hit.sw) bound[hit.canon] = it.has ? truthy(it.value) : true;
    else if (it.has) bound[hit.canon] = it.value;
    else {
      const nx = items[i + 1];
      if (!nx || nx.kind !== 'val') throw new PsError(`${cmd}: Missing an argument for parameter '${it.name.replace(/^-+/, '')}'. Specify a parameter of type 'System.String' and try again.`);
      bound[hit.canon] = nx.value;
      i++;
    }
  }
  const slots = (spec.positional ?? []).map((p) => p.toLowerCase()).filter((p) => !(p in bound));
  loose.forEach((v, k) => {
    if (k < slots.length - (spec.rest ? 1 : 0) || (!spec.rest && k < slots.length)) bound[slots[k]] = v;
    else if (spec.rest && slots.length) {
      const last = slots[slots.length - 1];
      bound[last] = [...unroll(bound[last]), v];
    } else throw new PsError(`${cmd}: A positional parameter cannot be found that accepts argument '${toStr(v)}'.`);
  });
  return bound;
}

// ---- display ----

const clip = (t: string, n = 70) => (t.length > n ? t.slice(0, n - 3) + '...' : t);

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return `{${v.map((x) => (isObj(x) ? toStr(prop(x, 'Name') ?? prop(x, 'name') ?? '...') : cell(x))).join(', ')}}`;
  if (isObj(v)) return clip(`{${Object.entries(v).map(([k, x]) => `${k}=${cell(x)}`).join(', ')}}`);
  return toStr(v);
};

function fmtList(o: Record<string, unknown>): string[] {
  const w = Math.max(...Object.keys(o).map((k) => k.length));
  return Object.entries(o).map(([k, v]) => `${k.padEnd(w)} : ${cell(v)}`);
}

function fmtTable(rows: Record<string, unknown>[]): string[] {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (cells: string[]) => cells.map((x, i) => x.padEnd(widths[i])).join(' ').trimEnd();
  return ['', line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))];
}

function fmtItems(items: unknown[]): ScratchLine[] {
  const out: ScratchLine[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it instanceof PsLine) {
      out.push({ text: it.text, type: it.type });
      i++;
    } else if (isObj(it)) {
      const run: Record<string, unknown>[] = [];
      while (i < items.length && isObj(items[i])) run.push(items[i++] as Record<string, unknown>);
      const cols = new Set(run.flatMap((r) => Object.keys(r))).size;
      const flat = run.every((r) => Object.values(r).every((v) => !isObj(v) && !(Array.isArray(v) && v.some(isObj)) && cell(v).length <= 50));
      const table = cols <= 4 && flat;
      const lines = table ? fmtTable(run) : run.flatMap((r, k) => [...(k ? [''] : []), ...fmtList(r)]);
      lines.forEach((l, k) => out.push({ text: l || ' ', type: table && (k === 1 || k === 2) ? 'heading' : 'output' }));
    } else if (Array.isArray(it)) {
      out.push(...fmtItems(it));
      i++;
    } else {
      toStr(it)
        .split('\n')
        .forEach((l) => out.push({ text: l || ' ', type: 'output' }));
      i++;
    }
  }
  return out;
}

function toJson(v: unknown, depth: number, level: number, hit: { truncated: boolean }): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof PsLine) return v.text;
  if (typeof v !== 'object') return v;
  if (level > depth) {
    hit.truncated = true;
    return toStr(v);
  }
  if (Array.isArray(v)) return v.map((x) => toJson(x, depth, level + 1, hit));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = toJson(x, depth, level + 1, hit);
  return o;
}

// ---- builtin cmdlets ----

type Builtin = Spec & { run: (rt: Rt, a: Bound, input: unknown[], name: string) => unknown[] };

const homeLines = (rt: Rt) => Object.entries(rt.ctx.g.files).map(([n, t]) => ({ Mode: rt.ctx.host.cfg.readonly.includes(n) ? '-ar--' : '-a---', Length: t.length, Name: n }));

function readFiles(rt: Rt, cmd: string, paths: unknown): { name: string; text: string }[] {
  return unroll(paths).map((p) => {
    const { name, full } = pathOf(rt, toStr(p));
    const bin = rt.ctx.host.cfg.binary ?? [];
    if (bin.includes(name)) throw new PsError(`${cmd}: '${full}' is a binary file.`);
    if (!(name in rt.ctx.g.files)) throw new PsError(`${cmd}: Cannot find path '${full}' because it does not exist.`);
    return { name, text: rt.ctx.g.files[name] };
  });
}

const sortKey = (v: unknown) => (typeof v === 'number' ? v : toStr(v).toLowerCase());

const BUILTINS: Record<string, Builtin> = {
  'get-content': {
    params: ['Path|FilePath|LiteralPath|PSPath', 'TotalCount|First|Head', 'Tail', 'Encoding'],
    switches: ['Raw'],
    positional: ['path'],
    run: (rt, a, _in, name) => {
      if (a.path === undefined) throw new PsError(`${name}: Cannot process command because of one or more missing mandatory parameters: Path.`);
      return readFiles(rt, name, a.path).flatMap((f) => {
        if (a.raw) return [f.text];
        let lines = f.text.replace(/\n$/, '').split('\n');
        if (f.text === '') lines = [];
        if (a.totalcount !== undefined) lines = lines.slice(0, num(a.totalcount));
        if (a.tail !== undefined) lines = lines.slice(-num(a.tail));
        return lines;
      });
    },
  },
  'set-content': { ...writer(false) },
  'add-content': { ...writer(true) },
  'out-file': { ...writer(false, true) },
  'new-item': {
    params: ['Path', 'Name', 'ItemType|Type', 'Value'],
    switches: ['Force'],
    positional: ['path'],
    run: (rt, a, _in, name) => {
      const target = toStr(a.name ?? a.path);
      if (!target) throw new PsError(`${name}: Cannot process command because of one or more missing mandatory parameters: Path.`);
      if (a.name !== undefined && a.path !== undefined && !/^(\.|~|\/home)/.test(toStr(a.path))) throw new PsError(`${name}: Cannot find path '${toStr(a.path)}' because it does not exist.`);
      const { name: f, full } = pathOf(rt, target);
      if (f in rt.ctx.g.files && !a.force) throw new PsError(`${name}: The file '${full}' already exists.`);
      if (String(a.itemtype ?? 'File').toLowerCase().startsWith('dir')) throw new PsError(`${name}: ~/scratch is a flat folder; create files only (-ItemType File).`);
      const why = writeFileChecked(rt.ctx.g, f, a.value === undefined ? '' : unroll(a.value).map(toStr).join('\n') + '\n', false, rt.ctx.host.cfg);
      if (why) throw new PsError(`${name}: ${why === 'readonly' ? `Access to the path '${full}' is denied.` : `'${f}' is not a usable scratch file name.`}`);
      return [{ Mode: '-a---', Length: toStr(a.value ?? '').length, Name: f }];
    },
  },
  'remove-item': {
    params: ['Path|LiteralPath'],
    switches: ['Force', 'Recurse'],
    positional: ['path'],
    run: (rt, a, _in, name) => {
      for (const p of unroll(a.path)) {
        const { name: f, full } = pathOf(rt, toStr(p));
        const g = rt.ctx.g;
        if (rt.ctx.host.cfg.readonly.includes(f) || (rt.ctx.host.cfg.binary ?? []).includes(f)) throw new PsError(`${name}: Access to the path '${full}' is denied.`);
        if (!(f in g.files)) throw new PsError(`${name}: Cannot find path '${full}' because it does not exist.`);
        const files = { ...g.files };
        delete files[f];
        g.files = files;
        if (g.focus === f) g.focus = null;
      }
      return [];
    },
  },
  'get-childitem': {
    params: ['Path|LiteralPath', 'Filter|Include'],
    switches: ['Recurse', 'Force', 'Name'],
    positional: ['path'],
    run: (rt, a) => {
      const pat = toStr(a.filter ?? (a.path !== undefined && /[*?]/.test(toStr(a.path)) ? fileName(toStr(a.path).replace(/\\/g, '/')) : '*'));
      const rows = homeLines(rt).filter((r) => wildcard(pat, r.Name));
      (rt.ctx.host.cfg.binary ?? []).forEach((b) => wildcard(pat, b) && rows.push({ Mode: '-ar--', Length: 0, Name: b }));
      return a.name ? rows.map((r) => r.Name) : rows;
    },
  },
  'test-path': {
    params: ['Path|LiteralPath'],
    positional: ['path'],
    run: (rt, a) => {
      const { name } = pathOf(rt, toStr(a.path));
      return [name in rt.ctx.g.files || (rt.ctx.host.cfg.binary ?? []).includes(name) || name === ''];
    },
  },
  'convertfrom-json': {
    params: ['InputObject', 'Depth'],
    switches: ['AsHashtable', 'NoEnumerate'],
    positional: ['inputobject'],
    run: (_rt, a, input, name) => {
      const src = a.inputobject !== undefined ? unroll(a.inputobject) : input;
      const text = src.map(toStr).join('\n');
      if (!text.trim()) throw new PsError(`${name}: Cannot process argument because the input is empty. (Get-Content returned nothing - is the file empty?)`);
      try {
        return unroll(mark(JSON.parse(text), !!a.ashashtable));
      } catch (e) {
        throw new PsError(`${name}: Conversion from JSON failed with error: ${(e as Error).message}`);
      }
    },
  },
  'convertto-json': {
    params: ['InputObject', 'Depth'],
    switches: ['Compress', 'AsArray', 'EnumsAsStrings'],
    positional: ['inputobject'],
    run: (rt, a, input) => {
      const src = a.inputobject !== undefined ? unroll(a.inputobject) : input;
      const value = a.asarray ? src : collapse(src);
      const depth = a.depth === undefined ? 2 : num(a.depth);
      const hit = { truncated: false };
      const text = JSON.stringify(toJson(value, depth, 0, hit), null, a.compress ? 0 : 2);
      if (hit.truncated) say(rt, [out1(`WARNING: Resulting JSON is truncated as serialization has exceeded the set depth of ${depth}.`, 'alert')]);
      return [text];
    },
  },
  'select-object': {
    params: ['Property', 'ExpandProperty', 'First', 'Last', 'Skip'],
    switches: ['Unique'],
    positional: ['property'],
    run: (_rt, a, input) => {
      let items = input;
      if (a.skip !== undefined) items = items.slice(num(a.skip));
      if (a.first !== undefined) items = items.slice(0, num(a.first));
      if (a.last !== undefined) items = items.slice(-num(a.last));
      if (a.expandproperty !== undefined) return items.flatMap((x) => unroll(getMember(null as never, x, toStr(a.expandproperty))));
      if (a.property !== undefined) {
        const names = unroll(a.property).map(toStr);
        items = items.map((x) => {
          const o: Record<string, unknown> = {};
          for (const nm of names) {
            if (nm.includes('*') && isObj(x)) Object.keys(x).filter((k) => wildcard(nm, k)).forEach((k) => (o[k] = x[k]));
            else o[nm] = getMember(null as never, x, nm);
          }
          return mark(o, false);
        });
      }
      if (a.unique) items = items.filter((x, i) => items.findIndex((y) => toStr(y) === toStr(x)) === i);
      return items;
    },
  },
  'where-object': {
    params: ['FilterScript', 'Property', 'Value', 'EQ', 'NE', 'GT', 'LT', 'GE', 'LE', 'Like', 'NotLike', 'Match', 'NotMatch', 'Contains', 'NotContains', 'In', 'NotIn'],
    switches: ['Not'],
    positional: ['filterscript', 'property'],
    run: (rt, a, input) => {
      if (isBlock(a.filterscript)) return input.filter((x) => truthy(collapse(callBlock(rt, a.filterscript, x))));
      const prop = toStr(a.filterscript ?? a.property);
      const ops = ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'like', 'notlike', 'match', 'notmatch', 'contains', 'notcontains', 'in', 'notin'];
      const op = ops.find((o) => o in a);
      if (!op) return input.filter((x) => truthy(getMember(rt, x, prop)));
      return input.filter((x) => truthy(binop(op, getMember(rt, x, prop), a[op])));
    },
  },
  'foreach-object': {
    params: ['Process|MemberName', 'Begin', 'End'],
    positional: ['process'],
    run: (rt, a, input) => {
      if (!isBlock(a.process)) return input.map((x) => getMember(rt, x, toStr(a.process)));
      return input.flatMap((x) => callBlock(rt, a.process, x));
    },
  },
  'sort-object': {
    params: ['Property'],
    switches: ['Descending', 'Unique'],
    positional: ['property'],
    run: (rt, a, input) => {
      const key = a.property === undefined ? null : toStr(unroll(a.property)[0]);
      const sorted = [...input].sort((x, y) => {
        const kx = sortKey(key ? getMember(rt, x, key) : x);
        const ky = sortKey(key ? getMember(rt, y, key) : y);
        return kx < ky ? -1 : kx > ky ? 1 : 0;
      });
      return a.descending ? sorted.reverse() : sorted;
    },
  },
  'measure-object': {
    params: ['Property'],
    switches: ['Sum', 'Average', 'Maximum', 'Minimum'],
    run: (rt, a, input) => {
      const o: Record<string, unknown> = { Count: input.length };
      if (a.property !== undefined) {
        const vals = input.map((x) => num(getMember(rt, x, toStr(a.property))));
        if (a.sum) o.Sum = vals.reduce((s, v) => s + v, 0);
      }
      return [mark(o, false)];
    },
  },
  'format-table': { params: ['Property'], switches: ['AutoSize', 'Wrap'], positional: ['property'], run: (_rt, a, input) => formatRun(a, input, false) },
  'format-list': { params: ['Property'], switches: ['Force'], positional: ['property'], run: (_rt, a, input) => formatRun(a, input, true) },
  'out-string': { params: [], switches: ['Stream'], run: (_rt, _a, input) => [fmtItems(input).map((l) => (l.text === ' ' ? '' : l.text)).join('\n')] },
  'out-null': { params: [], run: () => [] },
  'out-host': { params: [], run: (_rt, _a, input) => input },
  'write-output': { params: ['InputObject'], positional: ['inputobject'], rest: true, run: (_rt, a, input) => (a.inputobject !== undefined ? unroll(a.inputobject) : input) },
  'write-host': {
    params: ['Object', 'ForegroundColor', 'BackgroundColor', 'Separator'],
    switches: ['NoNewline'],
    positional: ['object'],
    rest: true,
    run: (rt, a, input) => {
      const text = (a.object !== undefined ? unroll(a.object) : input).map(toStr).join(toStr(a.separator ?? ' '));
      say(rt, text.split('\n').map((l) => out1(l || ' ')));
      return [];
    },
  },
  'write-warning': { params: ['Message'], positional: ['message'], run: (rt, a) => (say(rt, [out1(`WARNING: ${toStr(a.message)}`, 'alert')]), []) },
  'write-error': { params: ['Message'], positional: ['message'], run: (rt, a) => (say(rt, [err1(`Write-Error: ${toStr(a.message)}`)]), []) },
  'write-verbose': { params: ['Message'], positional: ['message'], run: () => [] },
  throw: {
    params: ['Message'],
    positional: ['message'],
    rest: true,
    run: (_rt, a) => {
      throw new PsError(toStr(a.message));
    },
  },
  'join-path': { params: ['Path', 'ChildPath'], positional: ['path', 'childpath'], run: (_rt, a) => [`${toStr(a.path).replace(/[\\/]+$/, '')}/${toStr(a.childpath)}`] },
  'new-timespan': {
    params: ['Days', 'Hours', 'Minutes', 'Seconds'],
    run: (_rt, a) => {
      const total = ((num(a.days ?? 0) * 24 + num(a.hours ?? 0)) * 60 + num(a.minutes ?? 0)) * 60 + num(a.seconds ?? 0);
      const d = Math.floor(total / 86400);
      const pad = (n: number) => String(n).padStart(2, '0');
      return [`${d ? d + '.' : ''}${pad(Math.floor((total % 86400) / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`];
    },
  },
  'start-sleep': { params: ['Seconds|Milliseconds'], positional: ['seconds'], run: () => [] },
  'import-module': { params: ['Name'], switches: ['Force'], positional: ['name'], rest: true, run: () => [] },
  'get-location': { params: [], run: (rt) => [home(rt)] },
  'set-location': {
    params: ['Path'],
    positional: ['path'],
    run: (_rt, a, _i, name) => {
      if (a.path && !/^(~|\.|\/home\/\S*|~\/scratch)\/?$/.test(toStr(a.path))) throw new PsError(`${name}: Cannot find path '${toStr(a.path)}' because it does not exist.`);
      return [];
    },
  },
  'select-string': {
    params: ['Pattern', 'Path'],
    switches: ['SimpleMatch', 'CaseSensitive', 'Quiet'],
    positional: ['pattern', 'path'],
    run: (rt, a, input) => {
      const src = a.path !== undefined ? readFiles(rt, 'Select-String', a.path).flatMap((f) => f.text.replace(/\n$/, '').split('\n')) : input.flatMap((x) => toStr(x).split('\n'));
      const re = new RegExp(a.simplematch ? toStr(a.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : toStr(a.pattern), a.casesensitive ? '' : 'i');
      return src.filter((l) => re.test(l));
    },
  },
  'get-command': { params: ['Name', 'Module'], positional: ['name'], run: (rt) => (say(rt, cmdletList(rt.ctx)), []) },
  'clear-host': { params: [], run: (rt) => ((rt.ctx.g = { ...rt.ctx.g, history: [] }), []) },
};

function writer(append: boolean, outFile = false): Builtin {
  return {
    params: ['Path|FilePath|LiteralPath', 'Value|InputObject', 'Encoding'],
    switches: ['NoNewline', 'Append', 'Force', 'NoClobber'],
    positional: outFile ? ['path'] : ['path', 'value'],
    run: (rt, a, input, name) => {
      if (a.path === undefined) throw new PsError(`${name}: Cannot process command because of one or more missing mandatory parameters: Path.`);
      const src = a.value !== undefined ? unroll(a.value) : input;
      const text = outFile ? fmtItems(src).map((l) => (l.text === ' ' ? '' : l.text)).join('\n') : src.map((x) => toStr(x)).join('\n');
      const body = a.nonewline ? text : text + (text || src.length ? '\n' : '');
      writeOut(rt, name, toStr(a.path), body, append || !!a.append);
      return [];
    },
  };
}

function formatRun(a: Bound, input: unknown[], list: boolean): unknown[] {
  let rows = input.filter(isObj) as Record<string, unknown>[];
  if (a.property !== undefined) {
    const names = unroll(a.property).map(toStr);
    rows = rows.map((r) => Object.fromEntries(names.map((n) => [n, r[keyOf(r, n) ?? n]])));
  }
  if (!rows.length) return input;
  const lines = list ? rows.flatMap((r, k) => [...(k ? [''] : []), ...fmtList(r)]) : fmtTable(rows);
  return [lines.join('\n')];
}

const ALIASES: Record<string, string> = {
  cat: 'get-content',
  type: 'get-content',
  gc: 'get-content',
  ls: 'get-childitem',
  dir: 'get-childitem',
  gci: 'get-childitem',
  rm: 'remove-item',
  del: 'remove-item',
  ri: 'remove-item',
  echo: 'write-output',
  write: 'write-output',
  sc: 'set-content',
  ac: 'add-content',
  ni: 'new-item',
  select: 'select-object',
  where: 'where-object',
  foreach: 'foreach-object',
  '%': 'foreach-object',
  '?': 'where-object',
  sort: 'sort-object',
  ft: 'format-table',
  fl: 'format-list',
  measure: 'measure-object',
  sleep: 'start-sleep',
  pwd: 'get-location',
  cd: 'set-location',
  sl: 'set-location',
  clear: 'clear-host',
  cls: 'clear-host',
  gcm: 'get-command',
  sls: 'select-string',
  ipmo: 'import-module',
  convertfrom_json: 'convertfrom-json',
  oh: 'out-host',
};

const NATIVE = new Set(['az', 'hint', 'submit', 'wait', 'ticket', 'queue', 'skip', 'curl', 'restart', 'sed']);

function toNative(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(toNative);
  if (isObj(v)) return [JSON.stringify(v)];
  return [toStr(v)];
}

function runNative(rt: Rt, name: string, items: ArgItem[]): unknown[] {
  const argv = [name, ...items.flatMap((it) => (it.kind === 'param' ? [it.name, ...(it.has ? toNative(it.value) : [])] : toNative(it.value)))];
  const ran = runEngine(rt.ctx, argv);
  vars(rt).lastexitcode = ran.ok ? 0 : 1;
  vars(rt)['?'] = ran.ok;
  return ran.lines.map((l) => new PsLine(l));
}

function fromItem(it: unknown, def: CmdletDef, canon: string): unknown {
  const names = (def.params.find((p) => p.split('|')[0].toLowerCase() === canon) ?? canon).split('|');
  if (isObj(it)) for (const nm of names) {
    const k = keyOf(it, nm);
    if (k !== undefined) return it[k];
  }
  // an object (or a string) piped into a cmdlet with a single pipeline parameter binds by value
  return def.pipe?.length === 1 && (typeof it === 'string' || isObj(it)) ? it : undefined;
}

const looksJson = (lines: ScratchLine[]) => /^\s*[{[]/.test(lines.map((l) => l.text).join('\n'));

/** Runs what a cmdlet's build() asked for: a value, a read-then-decide step, or one or more az commands. */
function execPlan(rt: Rt, name: string, first: Build, stop: boolean): unknown[] {
  const failed = (ran: { lines: ScratchLine[] }): unknown[] => {
    const at = ran.lines.findIndex((x) => x.type === 'error');
    const lines = ran.lines.map((l, i) => (i === at ? { ...l, text: `${name}: ${l.text}` } : l));
    if (stop) throw new PsError(lines[at].text);
    return lines.map((l) => new PsLine(l));
  };
  let plan: Build = first;
  for (let hops = 0; hops < 4; hops++) {
    if ('error' in plan) throw new PsError(`${name}: ${plan.error}`);
    if ('value' in plan) return unroll(plan.value);
    if (!('read' in plan)) break;
    const ran = runEngine(rt.ctx, ['az', ...plan.read, '-o', 'json']);
    if (!ran.ok) return failed(ran);
    let current: unknown;
    try {
      current = mark(JSON.parse(ran.lines.map((l) => l.text).join('\n')), false);
    } catch {
      current = ran.lines.map((l) => l.text);
    }
    plan = plan.then(current);
  }
  if (!('steps' in plan || 'az' in plan)) throw new PsError(`${name}: internal error: unresolved cmdlet plan`);
  const steps = plan.steps ?? (plan.az ? [plan.az] : []);
  let last: Ran | null = null;
  for (let i = 0; i < steps.length; i++) {
    const isLast = i === steps.length - 1;
    const argv = plan.native ? steps[i] : ['az', ...steps[i], ...(plan.json && isLast ? ['--output', 'json'] : [])];
    last = runEngine(rt.ctx, argv);
    // some labs print a JSON verdict in the error colour (a failed connectivity test is a result, not a failure)
    if (!last.ok && !(isLast && plan.json && looksJson(last.lines))) return failed(last);
  }
  if (!last) return [];
  if (plan.json) {
    try {
      const parsed = mark(JSON.parse(last.lines.map((l) => l.text).join('\n')), false);
      return unroll(plan.shape ? plan.shape(parsed) : parsed);
    } catch {
      /* not JSON: show the text */
    }
  }
  return last.lines.map((l) => new PsLine(l));
}

function runCmdlet(rt: Rt, name: string, def: CmdletDef, items: ArgItem[], input: unknown[]): unknown[] {
  const bound = bind(name, { params: def.params, switches: def.switches, positional: def.positional }, items);
  const runs: Bound[] = [];
  const pipeNames: string[] = def.pipe ?? [];
  if (pipeNames.length && input.length) {
    const lists: Record<string, unknown[]> = {};
    for (const it of input) {
      const b: Bound = { ...bound };
      for (const pname of pipeNames) {
        const key = pname.toLowerCase();
        if (key in bound) continue;
        const v = fromItem(it, def, key);
        if (v !== undefined) b[key] = v;
      }
      if (def.collect) def.collect.forEach((c) => b[c.toLowerCase()] !== undefined && (lists[c.toLowerCase()] ??= []).push(...unroll(b[c.toLowerCase()])));
      else runs.push(b);
    }
    if (def.collect) runs.push({ ...bound, ...lists });
  } else runs.push(bound);

  const results: unknown[] = [];
  for (const b of runs) {
    const missing = (def.mandatory ?? []).filter((m) => b[m.toLowerCase()] === undefined);
    if (missing.length) throw new PsError(`${name}: Cannot process command because of one or more missing mandatory parameters: ${missing.join(', ')}.`);
    const stop = String(b['~erroraction'] ?? vars(rt).erroractionpreference ?? '').toLowerCase() === 'stop';
    results.push(...execPlan(rt, name, def.build(b), stop));
  }
  return results;
}

function evalCmd(rt: Rt, el: Extract<Elem, { t: 'cmd' }>, input: unknown[]): unknown[] {
  const name = el.name;
  let low = name.toLowerCase();
  const items = evalArgs(rt, el.args);
  const g = rt.ctx.g;

  if (/^(\.\/|\.\\|~\/)/.test(name) || low.endsWith('.ps1')) {
    const { name: f } = pathOf(rt, name);
    if (!(f in g.files)) throw new PsError(`${name}: The term '${name}' is not recognized as a name of a cmdlet, function, script file, or executable program.\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.`);
    if (rt.ctx.depth >= 4) throw new PsError(`${name}: too many nested scripts`);
    rt.ctx.depth++;
    try {
      return execStmts(rt, parse(g.files[f]));
    } finally {
      rt.ctx.depth--;
    }
  }
  if (low === 'exit' || low === 'bash' || low === 'sh') {
    g.sh.mode = 'bash';
    say(rt, MODE_BANNER.bash);
    return [];
  }
  if (low === 'pwsh' || low === 'powershell') return [];
  if (low === 'cmdlets') return (say(rt, cmdletList(rt.ctx)), []);
  if (low === 'help' && !items.length) {
    const ran = runEngine(rt.ctx, ['help']);
    say(rt, [...ran.lines, out1('# shell', 'heading'), ...SHELL_HELP.map(([c, d]) => out1(`  ${c}\n      ${d}`))]);
    return [];
  }
  const az = rt.cmdlets.get(low);
  if (az) return runCmdlet(rt, az.name, az.def, items, input);
  low = ALIASES[low] ?? low;
  const b = BUILTINS[low];
  if (b) {
    const canon = low.replace(/(^|-)(\w)/g, (_m, d, c) => d + c.toUpperCase());
    return b.run(rt, bind(canon, b, items), input, canon);
  }
  if (NATIVE.has(low)) return runNative(rt, low, items);
  throw new PsError(`${name}: The term '${name}' is not recognized as a name of a cmdlet, function, script file, or executable program.\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.`);
}

// ---- entry point ----

/** Runs PowerShell text. Output goes to the history, or into `capture` when given. */
export function runPwshText<G extends ShellState>(ctx: Ctx<G>, src: string, capture: ScratchLine[] | null): void {
  const rt: Rt<G> = {
    ctx,
    capture,
    cmdlets: new Map(Object.entries(ctx.host.cmdlets).map(([n, def]) => [n.toLowerCase(), { name: n, def }])),
  };
  const r = rt as unknown as Rt;
  let prog: Stmt[];
  try {
    prog = parse(src);
  } catch (e) {
    if (e instanceof PsParseError) {
      say(r, [err1(`ParserError: ${e.message}`), out1('# nothing ran: PowerShell parses the whole input before running any of it', 'heading')]);
      return;
    }
    throw e;
  }
  const mode = ctx.g.sh.mode;
  for (const st of prog) {
    try {
      say(r, fmtItems(execStmt(r, st)));
    } catch (e) {
      if (!(e instanceof PsError)) throw e;
      say(r, e.message.split('\n').map((l, i) => ({ text: l, type: (i === 0 ? 'error' : 'output') as LineType })));
    }
    if (ctx.g.sh.mode !== mode) return;
  }
}
