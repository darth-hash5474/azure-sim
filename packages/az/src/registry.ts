// The az command registry: generated from the real Azure CLI by scripts/generate.sh, never edited by hand.
import data from './registry.json';

export interface Status {
  tag: 'Deprecated' | 'Preview' | 'Experimental';
  message: string | null;
}

export type ValueSource = { command: string } | { string: string } | { url: string };

export interface AzArg {
  /** As the help lists them: long name first, e.g. ["--name", "-n"]. */
  names: string[];
  /** As the parser holds them, which is the order its error messages use, e.g. ["-n", "--name"]. */
  options: string[];
  group: string | null;
  required: boolean;
  /** flag: takes no value · optional: may take one · value: takes one · list: takes one or more */
  kind: 'flag' | 'optional' | 'value' | 'list';
  /** Each use adds to the list instead of replacing it (argparse 'append'). */
  repeat: boolean;
  choices: string[] | null;
  default: string | null;
  defaultSource?: string | null;
  summary: string;
  long: string;
  valueSources: ValueSource[];
  status: Status | null;
  /** Accepted by the parser but left out of --help (deprecated aliases and the like). */
  hidden?: boolean;
}

export interface AzExample {
  summary: string;
  long: string;
  command: string;
}

export interface AzCommand {
  summary: string;
  long: string;
  status: Status | null;
  links: string[];
  args: AzArg[];
  /** Indexes into `args` in the parser's own order. */
  parserOrder: number[];
  examples: AzExample[];
}

export interface AzGroup {
  summary: string;
  long: string;
  status: Status | null;
}

interface RawCommand extends Omit<AzCommand, 'args'> {
  args: number[];
}

interface RawRegistry {
  cliVersion: string;
  width: number;
  groups: Record<string, AzGroup>;
  commands: Record<string, RawCommand>;
  args: AzArg[];
}

const raw = data as unknown as RawRegistry;

/** Version of the Azure CLI the registry was generated from. */
export const CLI_VERSION = raw.cliVersion;

/** Help is wrapped at this many columns, like knack does. */
export const HELP_WIDTH = raw.width;

export const GROUPS: Readonly<Record<string, AzGroup>> = raw.groups;

export const COMMANDS: Readonly<Record<string, AzCommand>> = Object.fromEntries(
  Object.entries(raw.commands).map(([name, c]) => [name, { ...c, args: c.args.map((i) => raw.args[i]) }])
);

export interface Child {
  name: string;
  kind: 'group' | 'command';
  summary: string;
  status: Status | null;
}

/** The subgroups and commands directly under a group ('' is the root). */
export function childrenOf(group: string): Child[] {
  const depth = group ? group.split(' ').length : 0;
  const under = (path: string) => (group ? path.startsWith(group + ' ') : true) && path.split(' ').length === depth + 1;
  const last = (path: string) => path.split(' ')[depth];
  return [
    ...Object.entries(GROUPS)
      .filter(([p]) => under(p))
      .map(([p, g]): Child => ({ name: last(p), kind: 'group', summary: g.summary, status: g.status })),
    ...Object.entries(COMMANDS)
      .filter(([p]) => under(p))
      .map(([p, c]): Child => ({ name: last(p), kind: 'command', summary: c.summary, status: c.status })),
  ];
}
