// A faithful port of Python's textwrap.TextWrapper (3.14), which knack uses to lay out az help.
// Only the options knack sets are supported: replace_whitespace=False, everything else default.

const WS = '[\\t\\n\\x0b\\x0c\\r ]';
const NWS = '[^\\t\\n\\x0b\\x0c\\r ]';
const WORD_PUNCT = '[\\p{L}\\p{N}_!"\'&.,?]';
const LETTER = '[\\p{L}_]';
const WORD = '[\\p{L}\\p{N}_]';

/** textwrap.TextWrapper.wordsep_re: whitespace, em-dashes, and words split after hyphens. */
const WORDSEP = new RegExp(
  `(${WS}+` +
    `|(?<=${WORD_PUNCT})-{2,}(?=${WORD})` +
    `|${NWS}+?(?:-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})|(?=${WS}|$)|(?<=${WORD_PUNCT})(?=-{2,}${WORD})))`,
  'gu'
);

const isBlank = (s: string) => s.replace(/[\t\n\x0b\x0c\r ]/g, '') === '';

function expandTabs(s: string, size = 8): string {
  let out = '';
  let col = 0;
  for (const ch of s) {
    if (ch === '\t') {
      const n = size - (col % size);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col = ch === '\n' || ch === '\r' ? 0 : col + 1;
    }
  }
  return out;
}

/** re.split(wordsep_re, text) without the empty strings. Matches run over the whole text so lookbehinds see it all. */
function split(text: string): string[] {
  const chunks: string[] = [];
  let at = 0;
  for (const m of text.matchAll(WORDSEP)) {
    if (m.index > at) chunks.push(text.slice(at, m.index));
    chunks.push(m[0]);
    at = m.index + m[0].length;
  }
  if (at < text.length) chunks.push(text.slice(at));
  return chunks.filter(Boolean);
}

export interface WrapOptions {
  width: number;
  initialIndent?: string;
  subsequentIndent?: string;
}

/** textwrap.wrap: the lines of one paragraph. */
export function wrap(text: string, { width, initialIndent = '', subsequentIndent = '' }: WrapOptions): string[] {
  const chunks = split(expandTabs(text)).reverse();
  const lines: string[] = [];
  while (chunks.length) {
    const cur: string[] = [];
    let curLen = 0;
    const indent = lines.length ? subsequentIndent : initialIndent;
    const room = width - indent.length;
    if (isBlank(chunks[chunks.length - 1]) && lines.length) chunks.pop();
    while (chunks.length) {
      const l = chunks[chunks.length - 1].length;
      if (curLen + l <= room) {
        cur.push(chunks.pop()!);
        curLen += l;
      } else break;
    }
    if (chunks.length && chunks[chunks.length - 1].length > room) {
      // _handle_long_word with break_long_words=True, break_on_hyphens=True
      const spaceLeft = room < 1 ? 1 : room - curLen;
      if (spaceLeft > 0) {
        const chunk = chunks[chunks.length - 1];
        let end = spaceLeft;
        if (chunk.length > spaceLeft) {
          const hyphen = chunk.lastIndexOf('-', spaceLeft - 1);
          if (hyphen > 0 && /[^-]/.test(chunk.slice(0, hyphen))) end = hyphen + 1;
        }
        cur.push(chunk.slice(0, end));
        chunks[chunks.length - 1] = chunk.slice(end);
      } else if (!cur.length) cur.push(chunks.pop()!);
      curLen = cur.reduce((n, c) => n + c.length, 0);
    }
    if (cur.length && isBlank(cur[cur.length - 1])) {
      curLen -= cur[cur.length - 1].length;
      cur.pop();
    }
    if (cur.length) lines.push(indent + cur.join(''));
  }
  return lines;
}

/** knack's _print_indent: every paragraph wrapped on its own, indented in steps of four spaces. */
export function printIndent(s: string, indent = 0, subsequentSpaces = -1, width = 100): string[] {
  const initialIndent = '    '.repeat(indent);
  const subsequentIndent = subsequentSpaces === -1 ? initialIndent : ' '.repeat(subsequentSpaces);
  return s.split('\n').map((p) => wrap(p, { width, initialIndent, subsequentIndent }).join('\n'));
}
