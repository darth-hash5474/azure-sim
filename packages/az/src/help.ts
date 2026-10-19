// `az ... --help`, laid out the way knack and azure-cli do it (knack/help.py, azure/cli/core/_help.py).
import { COMMANDS, GROUPS, HELP_WIDTH, childrenOf, type AzArg, type Child, type Status } from './registry';
import { printIndent } from './textwrap';

const FIRST_LINE_PREFIX = ' : ';
const REQUIRED_TAG = '[Required]';

const WELCOME = String.raw`
     /\
    /  \    _____   _ _  ___ _
   / /\ \  |_  / | | | \'__/ _\
  / ____ \  / /| |_| | | |  __/
 /_/    \_\/___|\__,_|_|  \___|


Welcome to the cool new Azure CLI!

Use ${'`'}az --version${'`'} to display the current version.
Here are the base commands:
`;

const hangingIndent = (maxLength: number, indent: number) => maxLength + indent * 4 + FIRST_LINE_PREFIX.length - 1;
const lineLen = (name: string, tagsLen: number) => name.length + tagsLen + (tagsLen ? 2 : 1);
const paddingLen = (maxLen: number, len: number, tags: string) => (tags ? maxLen - len + 1 : maxLen - len);

function tagsOf(status: Status | null, required = false): { tags: string; len: number } {
  const parts = [status ? `[${status.tag}]` : '', required ? REQUIRED_TAG : ''].filter(Boolean);
  const tags = parts.join(' ');
  return { tags, len: tags.length };
}

const statusMessage = (s: Status | null) => (s?.message ? [s.message] : []);

function header(kind: 'Command' | 'Group', path: string, summary: string, long: string, status: Status | null, links: string[] = []): string[] {
  const out: string[] = [...printIndent(''), ...printIndent(kind)];
  const line = `az${path ? ' ' + path : ''}${summary ? FIRST_LINE_PREFIX : ''}${summary}`;
  out.push(...printIndent(line, 1, -1, HELP_WIDTH));
  out.push(...printIndent([long, ...statusMessage(status)].filter(Boolean).join('\n'), 2, -1, HELP_WIDTH));
  if (links.length) {
    const text = links.length > 1 ? `${links.slice(0, -1).join(', ')} and ${links[links.length - 1]}` : links[0];
    out.push(...printIndent(`For more information, see: ${text}\n`, 2, -1, HELP_WIDTH));
  }
  if (long || status?.tag === 'Deprecated') out.push(...printIndent(''));
  return out;
}

function choicesDefaultsSources(a: AzArg): string {
  const choices = a.choices ? `  Allowed values: ${[...a.choices].sort().join(', ')}.` : '';
  const def = a.default ? `  ${a.defaultSource || 'Default'}: ${a.default}.` : '';
  const commands = a.valueSources.flatMap((v) => ('command' in v ? [v.command] : []));
  const strings = a.valueSources.flatMap((v) => ('string' in v ? [v.string] : []));
  const urls = a.valueSources.flatMap((v) => ('url' in v ? [v.url] : []));
  let sources = commands.length ? `  Values from: ${commands.join(', ')}.` : '';
  if (strings.length) {
    const s = `  ${strings.join(', ')}`;
    sources += s.endsWith('.') ? s : s + '.';
  }
  if (urls.length) sources += `  For more info, go to: ${urls.join(', ')}.`;
  return choices + def + sources;
}

function shortSummary(a: AzArg): string {
  const cut = a.summary.indexOf(' Possible values include');
  return ((cut >= 0 ? a.summary.slice(0, cut) : a.summary) + choicesDefaultsSources(a)).trim();
}

/**
 * knack's ArgumentGroupRegistry: ungrouped first, Global Arguments last, the rest alphabetical from 2.
 * (azure-cli subclasses it with more fixed slots, but knack's _print_arguments uses its own class.)
 */
function groupPriorities(args: AzArg[]): Map<string | null, number> {
  const fixed: [string | null, number][] = [
    [null, 0],
    ['Global Arguments', 1000],
  ];
  const map = new Map(fixed);
  let next = 2;
  for (const g of [...new Set(args.map((a) => a.group).filter((g): g is string => !!g))].sort()) {
    if (!map.has(g)) map.set(g, next++);
  }
  return map;
}

function argumentLines(args: AzArg[]): string[] {
  const shown = args.filter((a) => !a.hidden);
  if (!shown.length) return [...printIndent('None', 1), ...printIndent('')];
  const prio = groupPriorities(shown);
  const key = (a: AzArg) => `${String(prio.get(a.group) ?? 0).padStart(6, '0')}${a.required ? 'False' : 'True'}${a.names.join(' ')}`;
  const layouts = [...shown]
    .sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0))
    .map((a) => {
      const name = a.names.join(' ');
      const { tags, len } = tagsOf(a.status, a.required);
      const short = shortSummary(a);
      const long = [a.long, ...statusMessage(a.status)].filter(Boolean).join(' ');
      return { a, name, tags, short, long, len: lineLen(name, len) };
    });
  const maxLen = Math.max(0, ...layouts.map((l) => l.len));
  const out: string[] = [];
  let lastGroup: string | null = '';
  for (const l of layouts) {
    if (l.a.group !== lastGroup) {
      if (l.a.group) out.push('', l.a.group);
      lastGroup = l.a.group;
    }
    const line = `${l.name}${' '.repeat(paddingLen(maxLen, l.len, l.tags))}${l.tags}${l.short ? FIRST_LINE_PREFIX : ''}${l.short}`;
    out.push(...printIndent(line, 1, hangingIndent(maxLen, 1), HELP_WIDTH));
    if (l.long) out.push(...printIndent(l.long, 2, -1, HELP_WIDTH));
  }
  out.push(...printIndent(''));
  return out;
}

function childLines(title: string, items: Child[]): string[] {
  if (!items.length) return [];
  const layouts = [...items]
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .map((c) => {
      const { tags, len } = tagsOf(c.status);
      return { c, tags, len: lineLen(c.name, len), summary: c.summary.replace(/\n/g, ' ') };
    });
  const maxLen = Math.max(0, ...layouts.map((l) => l.len));
  const out = [...printIndent(title)];
  for (const l of layouts) {
    const line = `${l.c.name}${' '.repeat(paddingLen(maxLen, l.len, l.tags))}${l.tags}${l.summary ? FIRST_LINE_PREFIX : ''}${l.summary}`;
    out.push(...printIndent(line, 1, hangingIndent(maxLen, 1), HELP_WIDTH));
  }
  out.push(...printIndent(''));
  return out;
}

function exampleLines(examples: { summary: string; long: string; command: string }[]): string[] {
  if (!examples.length) return [];
  const out = [...printIndent('Examples', 0)];
  for (const e of examples) {
    out.push(...printIndent(e.summary, 1));
    if (e.long) out.push(...printIndent(e.long, 2));
    out.push(...printIndent(e.command, 2), '');
  }
  return out;
}

/** The welcome screen `az` and `az --help` print, listing the top-level groups and commands. */
function rootHelp(): string[] {
  const items = [...childrenOf('')].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const maxLength = Math.max(0, ...items.map((c) => c.name.length));
  const out = printIndent(WELCOME, 0, -1, HELP_WIDTH);
  for (const c of items) {
    const line = `${c.name}${' '.repeat(maxLength - c.name.length)}${c.summary ? FIRST_LINE_PREFIX + c.summary : ''}`;
    out.push(...printIndent(line, 1, hangingIndent(maxLength, 1)));
  }
  return out;
}

/** Help text for a command or group path ('' for the root), as lines. Null if the path is unknown. */
export function helpFor(path: string): string[] | null {
  const lines = render(path);
  return lines && lines.join('\n').split('\n');
}

function render(path: string): string[] | null {
  if (!path) return rootHelp();
  const cmd = COMMANDS[path];
  if (cmd) {
    return [
      ...header('Command', path, cmd.summary, cmd.long, cmd.status, cmd.links),
      ...printIndent('Arguments'),
      ...argumentLines(cmd.args),
      ...exampleLines(cmd.examples),
    ];
  }
  const group = GROUPS[path];
  if (!group) return null;
  const children = childrenOf(path);
  return [
    ...header('Group', path, group.summary, group.long, group.status),
    ...childLines('Subgroups:', children.filter((c) => c.kind === 'group')),
    ...childLines('Commands:', children.filter((c) => c.kind === 'command')),
  ];
}
