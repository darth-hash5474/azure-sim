// Game engine for Manage Resources: a simulated slice of ARM + the Azure CLI. No React in here.
import { readScratchJson, type ScratchConfig } from './scratch';
import { newShell, runShell, type Host, type ShellEnv } from './shell';
import { splitWords } from './shellcore';

export type LineType = 'input' | 'output' | 'error' | 'success' | 'heading' | 'alert';

export interface Line {
  text: string;
  type: LineType;
}

export type Actor = 'intern' | 'ops-admin' | 'sub-owner';
export type Role = 'Reader' | 'Contributor' | 'Owner';
export type LockLevel = 'CanNotDelete' | 'ReadOnly';
export type Tags = Record<string, string>;
type Op = 'read' | 'write' | 'move' | 'delete' | 'lockDelete';

export interface Lock {
  name: string;
  level: LockLevel;
  rg: string;
}

export interface Res {
  name: string;
  type: string;
  rg: string;
  tags: Tags;
}

export interface Group {
  location: string;
  tags: Tags;
}

export interface Game {
  user: Actor | null;
  groups: Record<string, Group>;
  locks: Lock[];
  resources: Res[];
  lost: string[]; // names of resources destroyed with a deleted group
  solved: boolean;
  /** The scratch folder (~/scratch): small text/JSON files the player edits and feeds to the CLI. Reset on restart. */
  files: Record<string, string>;
  /** File the editor panel should show (set by "edit <file>"). */
  focus: string | null;
  history: Line[];
  /** bash session (variables). */
  sh: ShellEnv;
}

type Out = (text: string, type?: LineType) => void;

export const TENANT = 'contoso.onmicrosoft.com';
export const SUB_ID = '6b1e9d3a-2f7c-4a58-b0e4-8c3d5f1a7e92';
export const SUB_SCOPE = `/subscriptions/${SUB_ID}`;
export const LOCATION = 'eastus';
export const SOURCE_RG = 'sprawl-rg';
export const TAG_KEY = 'CostCenter';

export const PRINCIPALS: Record<Actor, { upn: string; oid: string; role: Role }> = {
  intern: { upn: `intern@${TENANT}`, oid: '7a1c3e5f-9b2d-4c68-8e04-1f6a2d9b5c73', role: 'Reader' },
  'ops-admin': { upn: `ops-admin@${TENANT}`, oid: '4f8a2c6e-1d9b-4e73-a5c0-7b2e9f4d1a36', role: 'Contributor' },
  'sub-owner': { upn: `sub-owner@${TENANT}`, oid: 'b3d7e1f9-5a2c-4b86-9e0d-2c6f8a4b7d15', role: 'Owner' },
};

export const ACTORS = Object.keys(PRINCIPALS) as Actor[];

// Built-in roles reduced to what this game needs. Contributor has NotActions Microsoft.Authorization/*/Delete,
// so it can move and delete resources but not remove locks.
const ROLE_PERMS: Record<Role, Op[]> = {
  Reader: ['read'],
  Contributor: ['read', 'write', 'move', 'delete'],
  Owner: ['read', 'write', 'move', 'delete', 'lockDelete'],
};

/** Where each resource has to end up, and its audit tags. */
interface Spec {
  name: string;
  type: string;
  env: string;
  rg: string;
  cc: string;
  /** Resources that must be moved in the same request. */
  bundle?: string;
}

export const SPECS: Spec[] = [
  { name: 'shop-web', type: 'Microsoft.Web/sites', env: 'prod', rg: 'app-rg', cc: '2210' },
  { name: 'shop-plan', type: 'Microsoft.Web/serverfarms', env: 'prod', rg: 'app-rg', cc: '2210' },
  { name: 'shopdata', type: 'Microsoft.Storage/storageAccounts', env: 'prod', rg: 'data-rg', cc: '2210' },
  { name: 'shop-vnet', type: 'Microsoft.Network/virtualNetworks', env: 'prod', rg: 'net-rg', cc: '1100' },
  { name: 'jump-vm', type: 'Microsoft.Compute/virtualMachines', env: 'ops', rg: 'net-rg', cc: '1100', bundle: 'jump' },
  { name: 'jump-nic', type: 'Microsoft.Network/networkInterfaces', env: 'ops', rg: 'net-rg', cc: '1100', bundle: 'jump' },
  { name: 'jump-osdisk', type: 'Microsoft.Compute/disks', env: 'ops', rg: 'net-rg', cc: '1100', bundle: 'jump' },
];

export const specOf = (name: string): Spec => SPECS.find((s) => s.name === name)!;
const bundleOf = (name: string) => specOf(name).bundle;

export const rgScope = (rg: string) => `${SUB_SCOPE}/resourceGroups/${rg}`;
export const resId = (r: Res) => `${rgScope(r.rg)}/providers/${r.type}/${r.name}`;

export const fmtTags = (t: Tags) => {
  const parts = Object.entries(t).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : '(none)';
};

// ---- ARM request pipeline: existence, then RBAC, then locks ----

const authFailed = (actor: Actor, action: string, scope: string) =>
  `(AuthorizationFailed) The client '${PRINCIPALS[actor].upn}' with object id '${PRINCIPALS[actor].oid}' does not have ` +
  `authorization to perform action '${action}' over scope '${scope}' or the scope is invalid.`;

const groupNotFound = (rg: string) => `(ResourceGroupNotFound) Resource group '${rg}' could not be found.`;

const resourceNotFound = (token: string) => `(ResourceNotFound) The Resource '${token}' under subscription '${SUB_ID}' was not found.`;

/** ReadOnly blocks every write; CanNotDelete blocks delete and move (a move deletes from the source group). */
const lockBlocks = (l: Lock, op: Op) => (l.level === 'ReadOnly' ? op !== 'read' : op === 'delete' || op === 'move');

function guard(g: Game, actor: Actor, action: string, rg: string, op: Op, scope = rgScope(rg)): string | null {
  if (!g.groups[rg]) return groupNotFound(rg);
  if (!ROLE_PERMS[PRINCIPALS[actor].role].includes(op)) return authFailed(actor, action, scope);
  const blocking = g.locks.filter((l) => l.rg === rg && lockBlocks(l, op));
  if (blocking.length) {
    return (
      `(ScopeLocked) The scope '${scope}' cannot perform ${op} operation because following scope(s) are locked: ` +
      `${blocking.map(() => `'${rgScope(rg)}'`).join(', ')}. Please remove the lock and try again.`
    );
  }
  return null;
}

/** Accepts a resource name or its full resource ID. */
function resolve(g: Game, token: string): Res | undefined {
  const t = token.toLowerCase();
  return g.resources.find((r) => r.name.toLowerCase() === t || resId(r).toLowerCase() === t);
}

// ---- audit ----

export interface Check {
  label: string;
  ok: boolean;
  count: number;
  of: number;
}

export function audit(g: Game): Check[] {
  const total = SPECS.length;
  const mine = SPECS.map((s) => ({ s, r: g.resources.find((r) => r.name === s.name) }));
  const count = (pred: (s: Spec, r: Res) => boolean) => mine.filter(({ s, r }) => r && pred(s, r)).length;
  const tagged = count((s, r) => r.tags[TAG_KEY] === s.cc);
  const env = count((s, r) => r.tags.Env === s.env);
  const placed = count((s, r) => r.rg === s.rg);
  return [
    { label: `${TAG_KEY} on every resource`, ok: tagged === total, count: tagged, of: total },
    { label: 'Env tags preserved', ok: env === total, count: env, of: total },
    { label: 'Resources in their team group', ok: placed === total, count: placed, of: total },
    { label: `${SOURCE_RG} retired`, ok: !g.groups[SOURCE_RG], count: g.groups[SOURCE_RG] ? 0 : 1, of: 1 },
    { label: 'Nothing lost', ok: g.lost.length === 0, count: total - g.lost.length, of: total },
  ];
}

const AUDIT_BRIEF = [
  'FINANCE AUDIT FA-26-Q4 · resource hygiene · due end of day',
  '',
  `1. Every resource carries a ${TAG_KEY} tag. The audit reads tags on the resources themselves, not on groups.`,
  '     2210  shop team     shop-web, shop-plan, shopdata',
  '     1100  network team  shop-vnet, jump-vm, jump-nic, jump-osdisk',
  '2. Existing tags survive the cleanup (Env stays exactly as it is).',
  '3. Each resource lives in its team group, created in eastus if it does not exist yet:',
  '     app-rg   shop-web, shop-plan',
  '     data-rg  shopdata',
  '     net-rg   shop-vnet, jump-vm, jump-nic, jump-osdisk',
  `4. ${SOURCE_RG} is retired: delete it once it is empty.`,
  '5. Nothing may be lost along the way.',
  '',
  'File the audit with: submit',
];

// ---- scratch folder: a tiny in-memory ~/scratch the player edits live and feeds to the CLI with @file ----

export const READONLY_FILES = ['audit.txt'];
export const SCRATCH: ScratchConfig = { readonly: READONLY_FILES };

export const initialFiles = (): Record<string, string> => ({
  'audit.txt': AUDIT_BRIEF.join('\n'),
  'tags.json': '{\n  "CostCenter": "TODO"\n}\n',
  'ids.json': '[\n]\n',
});

const parseJsonFile = readScratchJson;

/** --tags k=v ... or --tags @file.json. Prints its own error and returns null on failure. */
function tagsArg(g: Game, out: Out, vals: string[] | null, usage: string): Tags | null {
  if (vals?.length === 1 && vals[0].startsWith('@')) {
    const parsed = parseJsonFile(g, out, vals[0]);
    if (!parsed) return null;
    const v = parsed.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      out(`ERR '${parsed.name}' must hold one JSON object of tag names and values, e.g. { "CostCenter": "2210" }`, 'error');
      return null;
    }
    const tags: Tags = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
        out(`ERR Tag '${k}' in '${parsed.name}' must be a plain value, not ${val === null ? 'null' : Array.isArray(val) ? 'an array' : 'an object'}.`, 'error');
        return null;
      }
      tags[k] = String(val);
    }
    if (!Object.keys(tags).length) {
      out(`ERR '${parsed.name}' has no tags in it.`, 'error');
      return null;
    }
    return tags;
  }
  const tags = parseTags(vals);
  if (!tags) out(usage, 'error');
  return tags;
}

/** --ids a b c or --ids @file.json (a JSON array of names or IDs). Prints its own error and returns null on failure. */
function idsArg(g: Game, out: Out, vals: string[] | null, usage: string): string[] | null {
  if (!vals?.length) {
    out(usage, 'error');
    return null;
  }
  if (vals.length === 1 && vals[0].startsWith('@')) {
    const parsed = parseJsonFile(g, out, vals[0]);
    if (!parsed) return null;
    const v = parsed.value;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      out(`ERR '${parsed.name}' must hold a JSON array of resource names or IDs, e.g. ["shop-web", "shop-plan"]`, 'error');
      return null;
    }
    if (!v.length) {
      out(`ERR '${parsed.name}' is an empty list: add the resources to act on, then run the command again.`, 'error');
      return null;
    }
    return v as string[];
  }
  return vals;
}

function nextHint(g: Game): string {
  if (!g.user) return 'Sign in first: az login --username <id>. "az role assignment list" shows who can do what.';
  const mine = g.resources;
  if (mine.some((r) => r.tags[TAG_KEY] !== specOf(r.name).cc)) {
    return `Check 1 reads tags on each resource, so tagging a group does not help. Try: az resource tag --ids <name> ... --tags ${TAG_KEY}=<n> --is-incremental (read "az resource tag" in help for why the flag matters). Or put the tag in tags.json and pass --tags @tags.json.`;
  }
  const misplaced = mine.filter((r) => r.rg !== specOf(r.name).rg);
  if (misplaced.length) {
    const missing = [...new Set(misplaced.map((r) => specOf(r.name).rg))].filter((rg) => !g.groups[rg]);
    if (missing.length) return `Destination groups must exist before a move: az group create -n ${missing[0]} -l ${LOCATION}`;
    const locked = misplaced.find((r) => g.locks.some((l) => l.rg === r.rg && lockBlocks(l, 'move')));
    if (locked) return `A lock on ${locked.rg} blocks moves. Removing locks needs lock-delete rights, which Contributor does not have: compare "az role assignment list", then "az lock delete".`;
    return 'Move with: az resource move --destination-group <rg> --ids <name> ... (or list them in ids.json and pass --ids @ids.json). Some resources only move together with the ones they depend on.';
  }
  if (g.groups[SOURCE_RG]) {
    return g.locks.some((l) => l.rg === SOURCE_RG)
      ? `${SOURCE_RG} is empty but still locked. Who may remove the lock?`
      : `${SOURCE_RG} is empty: az group delete -n ${SOURCE_RG} --yes`;
  }
  return 'Everything looks in place. Type "submit".';
}

function debrief(g: Game, out: Out) {
  const checks = audit(g);
  out('# audit FA-26-Q4 · filed', 'heading');
  checks.forEach((c) => out(`  ${c.ok ? '[PASS]' : '[FAIL]'} ${c.label} (${c.count}/${c.of})`, c.ok ? 'success' : 'error'));
  if (!checks.every((c) => c.ok)) {
    out('  Audit rejected. Fix the failing items and submit again.', 'alert');
    if (!checks[0].ok) out(`  · ${TAG_KEY} must match the brief on every resource. Group tags are not inherited by resources.`);
    if (!checks[1].ok) out('  · An Env tag went missing. A plain "az resource tag" replaces the whole tag set. Re-add the original value (web, plan, data and vnet were prod; the jump box trio was ops), or restart.');
    if (!checks[2].ok) out('  · Some resources are not in their team group yet. "az resource list" shows where everything sits.');
    if (!checks[3].ok) out(`  · ${SOURCE_RG} still exists.`);
    if (!checks[4].ok) out(`  · Lost: ${g.lost.join(', ')}. Deleting a resource group deletes everything in it. Type "restart" to try again.`, 'error');
    return;
  }
  g.solved = true;
  out('  PASSED. Estate tidy, tagged and the old group retired.', 'success');
  out('# what to take away', 'heading');
  out('  · Tags belong to the resource they are set on. A resource group tag is not inherited by its resources;');
  out('    Azure Policy (the Modify effect, "Inherit a tag from the resource group") is how you automate that.');
  out('  · "az resource tag" replaces the whole tag set unless you add --is-incremental. "az tag update --operation Merge" merges.');
  out('  · A move changes the resource group (and so the resource ID) but never the region. Tags travel with the resource.');
  out('  · Both groups are write-locked while a move runs. You need move rights on the source group and write on the destination.');
  out('  · A VM, its NIC and its managed disk are moved together: leave one behind and the request is rejected.');
  out('  · Locks apply to every principal. CanNotDelete blocks moving or deleting out of the group, and only Owner or');
  out('    User Access Administrator can remove it. Contributor can move resources but cannot remove locks.');
  out('  · Deleting a resource group deletes everything in it. Empty it first, then retire it.');
  out('Type "restart" to play again.');
}

// ---- state ----

const intro = (): Line[] => [
  { text: 'Azure Cloud Shell (simulated) · subscription contoso-prod', type: 'output' },
  { text: `TICKET FA-26-Q4: finance audits resource hygiene at end of day. The shop team's dev estate is piled into ${SOURCE_RG}.`, type: 'alert' },
  { text: 'Tag it, sort it into proper groups and retire the old one without breaking anything.', type: 'output' },
  { text: 'BRIEF: read what the auditors want with: cat audit.txt', type: 'output' },
  { text: 'SCRATCH: ~/scratch holds files you can edit live in the panel under the terminal (tags.json, ids.json). "ls" lists them.', type: 'output' },
  { text: 'Type "help" for commands, "hint" if you get stuck and "submit" when you think you are done.', type: 'output' },
];

export const initialGame = (): Game => ({
  user: null,
  groups: { [SOURCE_RG]: { location: LOCATION, tags: { [TAG_KEY]: '2210', Purpose: 'dev' } } },
  locks: [{ name: 'legacy-hold', level: 'CanNotDelete', rg: SOURCE_RG }],
  resources: SPECS.map((s) => ({ name: s.name, type: s.type, rg: SOURCE_RG, tags: { Env: s.env } })),
  lost: [],
  solved: false,
  files: initialFiles(),
  focus: null,
  history: intro(),
  sh: newShell(),
});

const draft = (g: Game): Game => ({
  ...g,
  groups: Object.fromEntries(Object.entries(g.groups).map(([k, v]) => [k, { ...v, tags: { ...v.tags } }])),
  locks: [...g.locks],
  resources: g.resources.map((r) => ({ ...r, tags: { ...r.tags } })),
  lost: [...g.lost],
  files: { ...g.files },
  history: [...g.history],
});

const writer =
  (g: Game): Out =>
  (text, type = 'output') =>
    g.history.push({ text, type });

export const userPrompt = (user: Actor | null) => `${user ?? 'anon'}@contoso-prod:~$`;

// ---- command parsing ----

const words = splitWords;

/** The tokens after the first matching flag, up to the next flag. Null if the flag is absent. */
const values = (cmd: string, ...names: string[]): string[] | null => {
  const parts = words(cmd);
  const idx = parts.findIndex((p) => names.includes(p));
  if (idx < 0) return null;
  const vals: string[] = [];
  for (let i = idx + 1; i < parts.length && !parts[i].startsWith('-'); i++) vals.push(parts[i]);
  return vals;
};

const flagValue = (cmd: string, ...names: string[]): string | null => values(cmd, ...names)?.[0] ?? null;

const hasFlag = (cmd: string, ...names: string[]) => words(cmd).some((p) => names.includes(p));

/** Parses key=value pairs. Returns null if any pair is malformed. */
function parseTags(vals: string[] | null): Tags | null {
  if (!vals?.length) return null;
  const tags: Tags = {};
  for (const v of vals) {
    const eq = v.indexOf('=');
    if (eq <= 0) return null;
    tags[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return tags;
}

// ---- commands ----

const HELP_COMMANDS: [string, string][] = [
  ['help · clear · restart', 'This guide · flush output · reset the puzzle'],
  ['cat audit.txt', 'Read the auditors\' brief'],
  ['hint', 'Nudge toward the next step'],
  ['submit', 'File the audit: checks everything and tells you what is still wrong'],
  ['az login --username <intern|ops-admin|sub-owner>', 'Sign in'],
  ['az account show · az role assignment list', 'Who you are · who holds which role'],
  ['az group list · az group show -n <rg>', 'Resource groups'],
  ['az group create -n <rg> -l <location> [--tags k=v ...]', 'Create a resource group'],
  ['az group update -n <rg> --tags k=v ...', 'Set the tags of a resource group (group only)'],
  ['az group delete -n <rg> --yes', 'Delete a group and everything in it'],
  ['az resource list [-g <rg>] [--tag <k>[=<v>]]', 'List resources with their tags, optionally filtered'],
  ['az resource show --ids <name|id>', 'Show one resource'],
  ['az resource tag --ids <name|id> ... --tags k=v ... [--is-incremental]', 'Tag resources. Without --is-incremental the tag set is REPLACED'],
  ['az tag update --resource-id <name|id> --operation <Merge|Replace|Delete> --tags k=v ...', 'Tag operations on one resource'],
  ['az resource move --destination-group <rg> --ids <name|id> ...', 'Move resources into another group in this subscription'],
  ['--tags @tags.json · --ids @ids.json', 'Any tags or ids argument can come from a JSON file in ~/scratch (object of tags · array of names or IDs)'],
  ['az resource list [...] -o json', 'Same listing as JSON'],
  ['<command> > <file>', 'Save a command\'s output to a scratch file, e.g. az resource list -o json > inventory.json'],
  ['ls · cat <file> · edit <file> · touch <file> · rm <file>', 'The ~/scratch folder. Files open in the editor below the terminal and save as you type'],
  ['az lock list [-g <rg>] · az lock delete --name <n> -g <rg>', 'Inspect and remove locks'],
];

function showResource(g: Game, out: Out, r: Res) {
  out(
    JSON.stringify({ id: resId(r), name: r.name, type: r.type, location: g.groups[r.rg]?.location ?? LOCATION, resourceGroup: r.rg, tags: r.tags }, null, 2),
    'success'
  );
}

function groupCmd(g: Game, out: Out, user: Actor, cmd: string) {
  const sub = words(cmd)[2];
  const name = flagValue(cmd, '--name', '-n');
  if (sub === 'list') {
    if (flagValue(cmd, '--output', '-o')?.toLowerCase() === 'json')
      return out(JSON.stringify(Object.entries(g.groups).map(([n, grp]) => ({ id: rgScope(n), name: n, location: grp.location, tags: grp.tags })), null, 2), 'success');
    out(`${'Name'.padEnd(12)}${'Location'.padEnd(10)}Tags`, 'heading');
    Object.entries(g.groups).forEach(([n, grp]) => out(`${n.padEnd(12)}${grp.location.padEnd(10)}${fmtTags(grp.tags)}`));
  } else if (sub === 'show') {
    if (!name) out('ERR Usage: az group show -n <rg>', 'error');
    else if (!g.groups[name]) out(groupNotFound(name), 'error');
    else out(JSON.stringify({ id: rgScope(name), name, location: g.groups[name].location, tags: g.groups[name].tags }, null, 2), 'success');
  } else if (sub === 'create') {
    const loc = flagValue(cmd, '--location', '-l');
    if (!name || !loc) return out('ERR Usage: az group create -n <rg> -l <location> [--tags k=v ...]', 'error');
    const tagVals = values(cmd, '--tags');
    const tags = tagVals ? tagsArg(g, out, tagVals, 'ERR --tags expects key=value pairs or @file.json') : {};
    if (!tags) return;
    const existing = g.groups[name];
    if (existing && existing.location !== loc) {
      return out(`(InvalidResourceGroupLocation) Invalid parameter: location. The resource group '${name}' already exists in location '${existing.location}'.`, 'error');
    }
    if (!ROLE_PERMS[PRINCIPALS[user].role].includes('write')) {
      return out(authFailed(user, 'Microsoft.Resources/subscriptions/resourcegroups/write', rgScope(name)), 'error');
    }
    g.groups[name] = { location: loc, tags: existing ? { ...existing.tags, ...tags } : tags };
    out(JSON.stringify({ id: rgScope(name), name, location: loc, tags: g.groups[name].tags, properties: { provisioningState: 'Succeeded' } }, null, 2), 'success');
  } else if (sub === 'update') {
    const usage = 'ERR Usage: az group update -n <rg> --tags k=v ... | @file.json';
    const tags = tagsArg(g, out, values(cmd, '--tags'), usage);
    if (!tags) return;
    if (!name) return out(usage, 'error');
    const err = guard(g, user, 'Microsoft.Resources/subscriptions/resourcegroups/write', name, 'write');
    if (err) return out(err, 'error');
    g.groups[name].tags = tags;
    out(JSON.stringify({ id: rgScope(name), name, tags }, null, 2), 'success');
    out('# these are tags on the group only. Resources inside do not inherit them', 'heading');
  } else if (sub === 'delete') {
    if (!name) return out('ERR Usage: az group delete -n <rg> --yes', 'error');
    if (!hasFlag(cmd, '--yes', '-y')) return out('Are you sure you want to perform this operation? Re-run with --yes to confirm.', 'error');
    const err = guard(g, user, 'Microsoft.Resources/subscriptions/resourceGroups/delete', name, 'delete');
    if (err) {
      out(err, 'error');
      if (err.startsWith('(ScopeLocked)')) out('# your RBAC role allows this delete; the lock overrides it', 'heading');
      return;
    }
    const doomed = g.resources.filter((r) => r.rg === name);
    g.resources = g.resources.filter((r) => r.rg !== name);
    g.locks = g.locks.filter((l) => l.rg !== name);
    delete g.groups[name];
    if (doomed.length) {
      g.lost.push(...doomed.map((r) => r.name));
      out(`✗ ${name} deleted along with ${doomed.length} resource${doomed.length > 1 ? 's' : ''}: ${doomed.map((r) => r.name).join(', ')}`, 'error');
    } else out(`OK  ${name} deleted.`, 'success');
  } else out('ERR Usage: az group <list|show|create|update|delete> ...', 'error');
}

function resourceCmd(g: Game, out: Out, user: Actor, cmd: string) {
  const sub = words(cmd)[2];
  if (sub === 'list') {
    const rg = flagValue(cmd, '--resource-group', '-g');
    if (rg && !g.groups[rg]) return out(groupNotFound(rg), 'error');
    const tagFilter = flagValue(cmd, '--tag');
    const [fk, fv] = tagFilter ? tagFilter.split('=') : [];
    const shown = g.resources.filter((r) => (!rg || r.rg === rg) && (!tagFilter || (fk in r.tags && (fv === undefined || r.tags[fk] === fv))));
    const fmt = flagValue(cmd, '--output', '-o')?.toLowerCase();
    if (fmt === 'json') {
      const rows = shown.map((r) => ({ id: resId(r), name: r.name, type: r.type, location: g.groups[r.rg]?.location ?? LOCATION, resourceGroup: r.rg, tags: r.tags }));
      return out(JSON.stringify(rows, null, 2), 'success');
    }
    if (!shown.length) return out('[]');
    out(`${'Name'.padEnd(13)}${'Group'.padEnd(11)}${'Type'.padEnd(35)}Tags`, 'heading');
    shown.forEach((r) => out(`${r.name.padEnd(13)}${r.rg.padEnd(11)}${r.type.padEnd(35)}${fmtTags(r.tags)}`));
  } else if (sub === 'show') {
    const token = values(cmd, '--ids')?.[0];
    if (!token) return out('ERR Usage: az resource show --ids <name|id>', 'error');
    const r = resolve(g, token);
    if (!r) return out(resourceNotFound(token), 'error');
    showResource(g, out, r);
  } else if (sub === 'tag') {
    const usage = 'ERR Usage: az resource tag --ids <name|id> [<name|id> ...] | @file.json --tags <key=value> [...] | @file.json [--is-incremental]';
    const tags = tagsArg(g, out, values(cmd, '--tags'), usage);
    if (!tags) return;
    const ids = idsArg(g, out, values(cmd, '--ids'), usage);
    if (!ids) return;
    const incremental = hasFlag(cmd, '--is-incremental', '-i');
    for (const token of ids) {
      const r = resolve(g, token);
      if (!r) return out(resourceNotFound(token), 'error');
      const err = guard(g, user, 'Microsoft.Resources/tags/write', r.rg, 'write', resId(r));
      if (err) return out(err, 'error');
      const before = r.tags;
      r.tags = incremental ? { ...before, ...tags } : { ...tags };
      out(`OK  ${r.name}: ${fmtTags(r.tags)}`, 'success');
      const dropped = Object.keys(before).filter((k) => !(k in r.tags));
      if (dropped.length) out(`  ! no --is-incremental: the existing tag set was replaced, dropping ${dropped.join(', ')}`, 'alert');
    }
  } else if (sub === 'move') {
    moveCmd(g, out, user, cmd);
  } else out('ERR Usage: az resource <list|show|tag|move> ...', 'error');
}

function moveCmd(g: Game, out: Out, user: Actor, cmd: string) {
  const dest = flagValue(cmd, '--destination-group');
  const usage = 'ERR Usage: az resource move --destination-group <rg> --ids <name|id> [<name|id> ...] | @file.json';
  if (!dest) return out(usage, 'error');
  const ids = idsArg(g, out, values(cmd, '--ids'), usage);
  if (!ids) return;

  const items: Res[] = [];
  for (const token of ids) {
    const r = resolve(g, token);
    if (!r) return out(resourceNotFound(token), 'error');
    if (!items.includes(r)) items.push(r);
  }
  const source = items[0].rg;
  if (items.some((r) => r.rg !== source)) {
    return out('(InvalidMoveResourcesRequest) All resources in a move request must be in the same source resource group.', 'error');
  }
  if (!g.groups[dest]) return out(groupNotFound(dest), 'error');
  if (dest === source) return out('(InvalidMoveResourcesRequest) The source and destination resource groups must be different.', 'error');

  const err = guard(g, user, 'Microsoft.Resources/subscriptions/resourceGroups/moveResources/action', source, 'move');
  if (err) {
    out(err, 'error');
    if (err.startsWith('(ScopeLocked)')) out('# a move deletes the resource from the source group, so a lock on it blocks the move', 'heading');
    return;
  }

  const missing = g.resources.filter((r) => r.rg === source && !items.includes(r) && items.some((i) => bundleOf(i.name) && bundleOf(i.name) === bundleOf(r.name)));
  if (missing.length) {
    out(`(MissingMoveDependentResources) The move resources request does not contain all the dependent resources. Missing: ${missing.map(resId).join(', ')}.`, 'error');
    return;
  }

  out(`Validating move of ${items.length} resource${items.length > 1 ? 's' : ''} from ${source} to ${dest} ... both groups are write-locked while it runs.`);
  items.forEach((r) => {
    r.rg = dest;
    out(`OK  ${r.name} → ${dest}`, 'success');
  });
  out(`# tags came along; location is still ${g.groups[dest].location}. A move never changes region, and the resource IDs changed`, 'heading');
}

function tagUpdateCmd(g: Game, out: Out, user: Actor, cmd: string) {
  const token = flagValue(cmd, '--resource-id');
  const op = flagValue(cmd, '--operation')?.toLowerCase();
  const vals = values(cmd, '--tags');
  if (!token || !op || !vals?.length || !['merge', 'replace', 'delete'].includes(op)) {
    return out('ERR Usage: az tag update --resource-id <name|id> --operation <Merge|Replace|Delete> --tags <key=value> [...]', 'error');
  }
  const r = resolve(g, token);
  if (!r) return out(resourceNotFound(token), 'error');
  const err = guard(g, user, 'Microsoft.Resources/tags/write', r.rg, 'write', resId(r));
  if (err) return out(err, 'error');
  if (op === 'delete') {
    let keys = vals.map((v) => v.split('=')[0]);
    if (vals[0].startsWith('@')) {
      const fileTags = tagsArg(g, out, vals, 'ERR --tags expects key=value pairs or @file.json');
      if (!fileTags) return;
      keys = Object.keys(fileTags);
    }
    r.tags = Object.fromEntries(Object.entries(r.tags).filter(([k]) => !keys.includes(k)));
  } else {
    const tags = tagsArg(g, out, vals, 'ERR --tags expects key=value pairs, e.g. CostCenter=2210 (or @file.json)');
    if (!tags) return;
    r.tags = op === 'merge' ? { ...r.tags, ...tags } : tags;
  }
  out(JSON.stringify({ id: `${resId(r)}/providers/Microsoft.Resources/tags/default`, properties: { tags: r.tags } }, null, 2), 'success');
}

function lockCmd(g: Game, out: Out, user: Actor, cmd: string) {
  const sub = words(cmd)[2];
  const rg = flagValue(cmd, '--resource-group', '-g');
  if (rg && !g.groups[rg]) return out(groupNotFound(rg), 'error');
  if (sub === 'list') {
    const shown = rg ? g.locks.filter((l) => l.rg === rg) : g.locks;
    if (flagValue(cmd, '--output', '-o')?.toLowerCase() === 'json')
      return out(JSON.stringify(shown.map((l) => ({ id: `${rgScope(l.rg)}/providers/Microsoft.Authorization/locks/${l.name}`, name: l.name, level: l.level, resourceGroup: l.rg })), null, 2), 'success');
    if (!shown.length) return out('[]');
    out(`${'Name'.padEnd(16)}${'Level'.padEnd(14)}Scope`, 'heading');
    shown.forEach((l) => out(`${l.name.padEnd(16)}${l.level.padEnd(14)}${rgScope(l.rg)}`));
  } else if (sub === 'delete') {
    const name = flagValue(cmd, '--name', '-n');
    if (!name || !rg) return out('ERR Usage: az lock delete --name <n> -g <rg>', 'error');
    const lock = g.locks.find((l) => l.name === name && l.rg === rg);
    if (!lock) return out(`(LockNotFound) The lock '${name}' could not be found at scope '${rgScope(rg)}'.`, 'error');
    const scope = `${rgScope(rg)}/providers/Microsoft.Authorization/locks/${name}`;
    if (!ROLE_PERMS[PRINCIPALS[user].role].includes('lockDelete')) {
      out(authFailed(user, 'Microsoft.Authorization/locks/delete', scope), 'error');
      out(`# ${PRINCIPALS[user].role} cannot remove locks (Microsoft.Authorization/*/Delete is a NotAction)`, 'heading');
      return;
    }
    g.locks = g.locks.filter((l) => l !== lock);
    out(`OK  Lock '${name}' removed.`, 'success');
  } else out('ERR Usage: az lock <list|delete> ...', 'error');
}

function execute(prev: Game, cmd: string, _echo: string | null): Game {
  if (cmd === 'clear') return { ...prev, history: [] };
  if (cmd === 'restart') return initialGame();

  const g = draft(prev);
  const out = writer(g);

  const requireLogin = (): Actor | null => {
    if (!g.user) out("ERR Please run 'az login' to setup account.", 'error');
    return g.user;
  };

  if (cmd === 'help') {
    out('# accounts you hold credentials for', 'heading');
    out(`  ${ACTORS.join('  ')}`);
    out('# commands (resource names work wherever a resource ID is expected)', 'heading');
    HELP_COMMANDS.forEach(([c, d]) => out(`  ${c}\n      ${d}`));
  } else if (cmd === 'hint') {
    out(`HINT ${nextHint(g)}`, 'alert');
  } else if (cmd === 'submit') {
    debrief(g, out);
  } else if (cmd.startsWith('az login')) {
    const id = flagValue(cmd, '--username', '-u');
    if (ACTORS.includes(id as Actor)) {
      g.user = id as Actor;
      out(`OK  Signed in as ${PRINCIPALS[g.user].upn}.`, 'success');
    } else out(`ERR invalid arguments. Usage: az login --username <${ACTORS.join(' | ')}>`, 'error');
  } else if (cmd.startsWith('az account show')) {
    const user = requireLogin();
    if (user) out(JSON.stringify({ name: 'contoso-prod', id: SUB_ID, tenantId: TENANT, user: { name: PRINCIPALS[user].upn, type: 'user' } }, null, 2), 'success');
  } else if (cmd.startsWith('az role assignment list')) {
    if (requireLogin()) {
      if (flagValue(cmd, '--output', '-o')?.toLowerCase() === 'json')
        out(JSON.stringify(ACTORS.map((a) => ({ principalName: PRINCIPALS[a].upn, roleDefinitionName: PRINCIPALS[a].role, scope: SUB_SCOPE })), null, 2), 'success');
      else {
        out(`${'Principal'.padEnd(34)}${'Role'.padEnd(14)}Scope`, 'heading');
        ACTORS.forEach((a) => out(`${PRINCIPALS[a].upn.padEnd(34)}${PRINCIPALS[a].role.padEnd(14)}${SUB_SCOPE}`));
      }
    }
  } else if (/^az (group|resource|tag|lock)\b/.test(cmd)) {
    const user = requireLogin();
    if (user) {
      if (cmd.startsWith('az group')) groupCmd(g, out, user, cmd);
      else if (cmd.startsWith('az resource')) resourceCmd(g, out, user, cmd);
      else if (cmd.startsWith('az tag update')) tagUpdateCmd(g, out, user, cmd);
      else if (cmd.startsWith('az lock')) lockCmd(g, out, user, cmd);
      else out('ERR Usage: az tag update --resource-id <name|id> --operation <Merge|Replace|Delete> --tags k=v ...', 'error');
    }
  } else {
    out(`bash: ${cmd.split(' ')[0]}: command not recognized. Type "help" for usage.`, 'error');
  }
  return g;
}

export const HOST: Host<Game> = { execute, prompt: (g) => userPrompt(g.user), cfg: SCRATCH };
export const runCommand = (prev: Game, text: string): Game => runShell(prev, text, HOST);
export const livePrompt = (g: Game): string => HOST.prompt(g);
