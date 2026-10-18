// Game engine for No Route: a simulated slice of Azure virtual networking and Network Watcher. No React in here.

import { type Host, isFileRef, newShell, readScratchJson, runShell, scratchCommand, type ScratchConfig, type ShellEnv, splitWords } from '@azure-sim/shell';

export type LineType = 'input' | 'output' | 'error' | 'success' | 'heading' | 'alert';

export interface Line {
  text: string;
  type: LineType;
}

export interface Rule {
  name: string;
  priority: number;
  direction: 'Inbound';
  access: 'Allow' | 'Deny';
  protocol: string; // Tcp | Udp | *
  src: string; // CIDR, address, '*', 'Internet', 'VirtualNetwork' or 'AzureLoadBalancer'
  dstPort: string; // '*', '1433' or '1000-2000'
}

export interface Peering {
  name: string;
  vnet: string;
  remote: string;
  allowVnetAccess: boolean;
}

export interface Route {
  name: string;
  prefix: string;
  hop: 'VirtualAppliance' | 'None';
  ip: string;
}

export interface Game {
  peerings: Peering[];
  rules: Rule[]; // nsg-db inbound custom rules
  routes: Route[]; // rt-web
  changes: number;
  solved: boolean;
  files: Record<string, string>; // ~/scratch: ticket.txt, rule.json, peering.json and whatever the player adds
  focus: string | null; // file the editor panel shows
  sh: ShellEnv; // bash variables
  history: Line[];
}

type Out = (text: string, type?: LineType) => void;

export const RG = 'net-rg';
export const SUB_ID = '6b1e9d3a-2f7c-4a58-b0e4-8c3d5f1a7e92';
export const VNETS: Record<string, string> = { 'vnet-web': '10.1.0.0/16', 'vnet-data': '10.2.0.0/16' };
export const WEB_IP = '10.1.1.4';
export const DB_IP = '10.2.1.4';
export const DB_PORT = 1433;
const OTHER_WEB_IP = '10.1.2.9'; // another host in vnet-web, outside the web subnet
const INTERNET_IP = '203.0.113.9';
export const DEAD_NVA = '10.1.9.4';
export const FIREWALL = '10.1.9.5';
export const MAX_CHANGES = 5;

const VMS: Record<string, { ip: string; nic: string; vnet: string; subnet: string }> = {
  'web-vm': { ip: WEB_IP, nic: 'web-vm-nic', vnet: 'vnet-web', subnet: 'web (10.1.1.0/24)' },
  'db-vm': { ip: DB_IP, nic: 'db-vm-nic', vnet: 'vnet-data', subnet: 'db (10.2.1.0/24)' },
};

const id = (path: string) => `/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/${path}`;

// ---- addresses ----

const toInt = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const isIp = (s: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((o) => Number(o) <= 255);
const isCidr = (s: string) => /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(s) && Number(s.split('/')[1]) <= 32;

function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.includes('/') ? cidr.split('/') : [cidr, '32'];
  const size = 2 ** (32 - Number(bits));
  return Math.floor(toInt(ip) / size) === Math.floor(toInt(base) / size);
}

const prefixLen = (cidr: string) => Number(cidr.split('/')[1] ?? 32);

// ---- network model ----

/** A peering is only usable when both halves exist and both allow virtual network access. */
export const peeringUp = (g: Game) => {
  const a = g.peerings.find((p) => p.vnet === 'vnet-web' && p.remote === 'vnet-data');
  const b = g.peerings.find((p) => p.vnet === 'vnet-data' && p.remote === 'vnet-web');
  return !!a && !!b && a.allowVnetAccess && b.allowVnetAccess;
};

export const peeringState = (g: Game, p: Peering) => {
  const other = g.peerings.find((q) => q.vnet === p.remote && q.remote === p.vnet);
  return other ? 'Connected' : 'Initiated';
};

interface EffRoute {
  source: 'Default' | 'User';
  prefix: string;
  hopType: string;
  hopIp: string;
  name?: string;
}

/** Routes in effect for the web subnet, system routes first. Overridden system routes are marked Invalid. */
function effectiveRoutes(g: Game): (EffRoute & { state: 'Active' | 'Invalid' })[] {
  const system: EffRoute[] = [
    { source: 'Default', prefix: VNETS['vnet-web'], hopType: 'VnetLocal', hopIp: '' },
    ...(peeringUp(g) ? [{ source: 'Default' as const, prefix: VNETS['vnet-data'], hopType: 'VNetPeering', hopIp: '' }] : []),
    { source: 'Default', prefix: '0.0.0.0/0', hopType: 'Internet', hopIp: '' },
  ];
  const user: EffRoute[] = g.routes.map((r) => ({ source: 'User', prefix: r.prefix, hopType: r.hop, hopIp: r.hop === 'None' ? '' : r.ip, name: r.name }));
  return [
    ...system.map((r) => ({ ...r, state: (user.some((u) => u.prefix === r.prefix) ? 'Invalid' : 'Active') as 'Active' | 'Invalid' })),
    ...user.map((r) => ({ ...r, state: 'Active' as const })),
  ];
}

function nextHop(g: Game, dest: string): EffRoute | null {
  const live = effectiveRoutes(g).filter((r) => r.state === 'Active' && inCidr(dest, r.prefix));
  live.sort((a, b) => prefixLen(b.prefix) - prefixLen(a.prefix));
  return live[0] ?? null;
}

const portMatch = (spec: string, port: number) => {
  if (spec === '*') return true;
  const [lo, hi] = spec.split('-').map(Number);
  return hi === undefined ? port === lo : port >= lo && port <= hi;
};

function tagMatch(g: Game, src: string, ip: string): boolean {
  if (src === '*') return true;
  if (src === 'Internet') return !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  if (src === 'VirtualNetwork') return inCidr(ip, VNETS['vnet-data']) || (peeringUp(g) && inCidr(ip, VNETS['vnet-web']));
  if (src === 'AzureLoadBalancer') return ip === '168.63.129.16';
  return inCidr(ip, src);
}

/** Inbound NSG evaluation at db-vm: lowest priority number wins, first match decides. */
function evalInbound(g: Game, srcIp: string, port: number): { access: 'Allow' | 'Deny'; rule: string } {
  const defaults: Rule[] = [
    { name: 'AllowVnetInBound', priority: 65000, direction: 'Inbound', access: 'Allow', protocol: '*', src: 'VirtualNetwork', dstPort: '*' },
    { name: 'AllowAzureLoadBalancerInBound', priority: 65001, direction: 'Inbound', access: 'Allow', protocol: '*', src: 'AzureLoadBalancer', dstPort: '*' },
    { name: 'DenyAllInBound', priority: 65500, direction: 'Inbound', access: 'Deny', protocol: '*', src: '*', dstPort: '*' },
  ];
  const all = [...g.rules, ...defaults].sort((a, b) => a.priority - b.priority);
  const hit = all.find((r) => (r.protocol === '*' || r.protocol === 'Tcp') && portMatch(r.dstPort, port) && tagMatch(g, r.src, srcIp))!;
  return { access: hit.access, rule: hit.name };
}

interface Trace {
  ok: boolean;
  layer: 'route' | 'peering' | 'nsg' | null;
  hop: EffRoute | null;
  rule?: string;
  message: string;
}

/** web-vm to db-vm:1433, layer by layer: routing first, then the destination NSG. */
export function trace(g: Game): Trace {
  const hop = nextHop(g, DB_IP);
  if (!hop) return { ok: false, layer: 'route', hop, message: 'no route to 10.2.1.4' };
  if (hop.hopType === 'VirtualAppliance') {
    if (hop.hopIp === DEAD_NVA) {
      return { ok: false, layer: 'route', hop, message: `user route '${hop.name}' sends 10.2.0.0/16 to the appliance ${DEAD_NVA}, which no longer exists` };
    }
    return { ok: false, layer: 'peering', hop, message: `no peering route: traffic follows ${hop.prefix} to the firewall ${hop.hopIp}, which has no rule for it` };
  }
  if (hop.hopType === 'None') return { ok: false, layer: 'route', hop, message: `route '${hop.name}' drops the traffic (next hop None)` };
  if (hop.hopType !== 'VNetPeering') return { ok: false, layer: 'peering', hop, message: `next hop ${hop.hopType}: the destination is not reachable that way` };
  const nsg = evalInbound(g, WEB_IP, DB_PORT);
  if (nsg.access === 'Deny') return { ok: false, layer: 'nsg', hop, rule: nsg.rule, message: `inbound NSG rule '${nsg.rule}' denies TCP ${DB_PORT} from ${WEB_IP}` };
  return { ok: true, layer: null, hop, rule: nsg.rule, message: 'reachable' };
}

// ---- audit ----

export interface Check {
  label: string;
  ok: boolean;
}

export function audit(g: Game): Check[] {
  const others = evalInbound(g, OTHER_WEB_IP, DB_PORT).access === 'Deny' && evalInbound(g, INTERNET_IP, DB_PORT).access === 'Deny';
  return [
    { label: `web-vm reaches db-vm:${DB_PORT}`, ok: trace(g).ok },
    { label: 'Peering connected both ways', ok: peeringUp(g) },
    { label: 'db still closed to everyone else', ok: others },
    { label: 'Firewall default route kept', ok: g.routes.some((r) => r.name === 'internet-via-fw') },
    { label: `Fixed in ${MAX_CHANGES} changes or fewer (used ${g.changes})`, ok: g.changes <= MAX_CHANGES },
  ];
}

function nextHint(g: Game): string {
  const t = trace(g);
  if (t.ok) return audit(g).every((c) => c.ok) ? 'Everything holds. Type "submit".' : 'It connects, but the review still fails something. Check what else your change opened or removed.';
  if (t.layer === 'route' && t.hop?.name) return 'Start with the path: "az network watcher show-next-hop" and the route table rt-web. One route is sending data traffic to a dead address.';
  if (t.layer === 'peering') return 'The route to vnet-data is gone or never appeared. Look at both halves with "az network vnet peering list" on each vnet. peering.json is a draft body for the missing half (az rest put), but check allowVirtualNetworkAccess.';
  return 'The path is fine now, so look at the destination: test-ip-flow names the NSG rule that decides, and the lowest priority number wins. rule.json holds the allow rule as a body you can edit and PUT again.';
}

function debrief(g: Game, out: Out) {
  const checks = audit(g);
  out('# connectivity review', 'heading');
  checks.forEach((c) => out(`  ${c.ok ? '[PASS]' : '[FAIL]'} ${c.label}`, c.ok ? 'success' : 'error'));
  if (!checks.every((c) => c.ok)) {
    out('  Not signed off. Fix the failing items and submit again.', 'alert');
    return;
  }
  g.solved = true;
  out('  CONNECTED. web-vm reaches the database and nothing else got in.', 'success');
  out('# what to take away', 'heading');
  out('  · Debug in packet order: routing (next hop), then NSGs. test-ip-flow only checks NSGs; test-connectivity and');
  out('    show-next-hop find routing faults. "Allowed" in one and "Unreachable" in the other points at the route.');
  out('  · A user-defined route beats a system route for the same prefix, and the longest prefix always wins first.');
  out('  · A peering needs both halves. One half stays Initiated. Created from the CLI, --allow-vnet-access must be set.');
  out('  · NSG rules are evaluated by priority number, lowest first, and the first match decides. A broad Deny at 200');
  out('    shadows a narrow Allow at 300. Re-prioritise or add a narrower rule above it; do not delete the Deny.');
  out('  · Peering makes the VirtualNetwork tag span both networks, so a rule written for the local vnet now covers the peer.');
  out('Type "restart" to play again.');
}

// ---- state ----

const intro = (): Line[] => [
  { text: 'Azure Cloud Shell (simulated) · subscription contoso-prod · resource group net-rg', type: 'output' },
  { text: `TICKET NET-2291: web-vm (${WEB_IP}, vnet-web) cannot reach SQL on db-vm (${DB_IP}:${DB_PORT}, vnet-data) since Monday's network change.`, type: 'alert' },
  { text: 'Find what broke and restore the connection with the smallest change. The firewall route must stay and the database must not be exposed.', type: 'output' },
  { text: 'TICKET: cat ticket.txt for the details. "az network watcher test-connectivity" is a good first move.', type: 'output' },
  { text: 'SCRATCH: ~/scratch holds ticket.txt, rule.json and peering.json. Edit them live in the panel under the terminal and send them with "az rest --body @file.json". "ls" lists them.', type: 'output' },
  { text: 'Type "help" for commands, "hint" if you get stuck and "submit" when you are done.', type: 'output' },
];

export const initialGame = (): Game => ({
  peerings: [{ name: 'web-to-data', vnet: 'vnet-web', remote: 'vnet-data', allowVnetAccess: true }],
  rules: [
    { name: 'allow-bastion-ssh', priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', src: '10.2.9.0/26', dstPort: '22' },
    { name: 'deny-vnet-in', priority: 200, direction: 'Inbound', access: 'Deny', protocol: '*', src: 'VirtualNetwork', dstPort: '*' },
    { name: 'allow-sql-web', priority: 300, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', src: '10.1.1.0/24', dstPort: String(DB_PORT) },
  ],
  routes: [
    { name: 'to-data', prefix: '10.2.0.0/16', hop: 'VirtualAppliance', ip: DEAD_NVA },
    { name: 'internet-via-fw', prefix: '0.0.0.0/0', hop: 'VirtualAppliance', ip: FIREWALL },
  ],
  changes: 0,
  solved: false,
  files: initialFiles(),
  focus: null,
  sh: newShell(),
  history: intro(),
});

const draft = (g: Game): Game => ({
  ...g,
  peerings: g.peerings.map((p) => ({ ...p })),
  rules: g.rules.map((r) => ({ ...r })),
  routes: g.routes.map((r) => ({ ...r })),
  files: { ...g.files },
  history: [...g.history],
});

const writer =
  (g: Game): Out =>
  (text, type = 'output') =>
    g.history.push({ text, type });

export const PROMPT = 'netops@contoso-prod:~$';

// ---- command parsing ----

const words = (cmd: string) => splitWords(cmd);

const flagValue = (cmd: string, ...names: string[]): string | null => {
  const parts = words(cmd);
  const idx = parts.findIndex((p) => names.includes(p));
  // a real shell strips surrounding quotes, so '*' arrives as *
  return idx >= 0 && parts[idx + 1] && !parts[idx + 1].startsWith('--') ? parts[idx + 1].replace(/^(['"])(.*)\1$/, '$2') : null;
};

const hasFlag = (cmd: string, name: string) => words(cmd).includes(name);

const rgError = (cmd: string): string | null => {
  const rg = flagValue(cmd, '--resource-group', '-g');
  return rg === RG ? null : rg ? `(ResourceGroupNotFound) Resource group '${rg}' could not be found.` : `ERR --resource-group is required (-g ${RG})`;
};

// ---- commands ----

const HELP_COMMANDS: [string, string][] = [
  ['help · clear · restart', 'This guide · flush output · reset the puzzle'],
  ['hint · submit', 'Nudge toward the next step · run the connectivity review'],
  ['ls · cat <file> · edit <file> · touch <file> · rm <file>', 'The ~/scratch folder (cat ticket.txt for the ticket). Files open in the editor below the terminal and save as you type'],
  ['az rest --method <get|put|delete> --url <ARM path> [--body @file.json]', 'Raw ARM call on a rule, route or peering, with a JSON body from ~/scratch. PUT replaces the whole resource'],
  ['az network nsg rule list|route list ... -o json · <command> > <file>', 'JSON output, and saving any output into ~/scratch'],
  [`az vm list -g ${RG} -d`, 'VMs and their private IPs'],
  ['az network vnet peering list --vnet-name <vnet> -g net-rg', 'Peerings on vnet-web or vnet-data'],
  ['az network vnet peering create -n <n> --vnet-name <vnet> --remote-vnet <vnet> [--allow-vnet-access] -g net-rg', 'Create one half of a peering'],
  ['az network vnet peering update -n <n> --vnet-name <vnet> --set allowVirtualNetworkAccess=true -g net-rg', 'Change a peering'],
  ['az network route-table route list|delete --route-table-name rt-web [-n <route>] -g net-rg', 'User-defined routes on the web subnet'],
  ['az network nic list-effective-route-table --name web-vm-nic -g net-rg', 'Routes actually in effect for web-vm'],
  ['az network nsg rule list|create|update|delete --nsg-name nsg-db [-n <rule>] -g net-rg', 'db subnet NSG. create takes --priority --access --protocol --source-address-prefixes --destination-port-ranges'],
  ['az network watcher show-next-hop --vm web-vm --source-ip <ip> --dest-ip <ip> -g net-rg', 'Where does the packet go next?'],
  ['az network watcher test-ip-flow --vm db-vm --direction Inbound --protocol TCP --local <ip>:<port> --remote <ip>:<port> -g net-rg', 'Would the NSGs allow this flow?'],
  ['az network watcher test-connectivity --source-resource web-vm --dest-resource db-vm --dest-port 1433 -g net-rg', 'End-to-end check with the failing hop'],
];

const TICKET = [
  'NET-2291 · web-vm cannot reach db-vm on 1433',
  '',
  '  since Monday: a network change decommissioned the old network virtual appliance at 10.1.9.4 and',
  '  re-peered the two vnets. The checkout app on web-vm (10.1.1.4) times out connecting to SQL on',
  '  db-vm (10.2.1.4:1433).',
  '',
  'Constraints',
  '  · the firewall at 10.1.9.5 stays in the path for internet-bound traffic from the web subnet',
  '  · SQL stays closed to everyone except the web subnet (10.1.1.0/24): not the rest of vnet-web, not the internet',
  `  · make the smallest change that works (${MAX_CHANGES} changes or fewer)`,
];

/** ~/scratch: the ticket is read-only; the JSON bodies are drafts the player edits and sends with az rest. */
export const SCRATCH: ScratchConfig = { readonly: ['ticket.txt'] };

const initialFiles = (): Record<string, string> => ({
  'ticket.txt': TICKET.join('\n'),
  'rule.json':
    '{\n  "properties": {\n    "priority": 300,\n    "access": "Allow",\n    "direction": "Inbound",\n    "protocol": "Tcp",\n    "sourceAddressPrefix": "10.1.1.0/24",\n    "sourcePortRange": "*",\n    "destinationAddressPrefix": "*",\n    "destinationPortRange": "1433"\n  }\n}\n',
  'peering.json': `{\n  "properties": {\n    "remoteVirtualNetwork": { "id": "${id('Microsoft.Network/virtualNetworks/vnet-web')}" },\n    "allowVirtualNetworkAccess": false\n  }\n}\n`,
});

function peeringShow(g: Game, p: Peering) {
  return { name: p.name, vnet: p.vnet, remoteVirtualNetwork: p.remote, peeringState: peeringState(g, p), allowVirtualNetworkAccess: p.allowVnetAccess };
}

function peeringCmd(g: Game, out: Out, cmd: string) {
  const err = rgError(cmd);
  if (err) return out(err, 'error');
  const sub = words(cmd)[4];
  const vnet = flagValue(cmd, '--vnet-name');
  if (!vnet || !VNETS[vnet]) return out(`ERR --vnet-name must be one of: ${Object.keys(VNETS).join(', ')}`, 'error');
  const name = flagValue(cmd, '--name', '-n');
  if (sub === 'list') {
    const mine = g.peerings.filter((p) => p.vnet === vnet);
    return mine.length ? out(JSON.stringify(mine.map((p) => peeringShow(g, p)), null, 2), 'success') : out('[]');
  }
  if (!name) return out('ERR --name/-n is required', 'error');
  if (sub === 'create') {
    const remote = flagValue(cmd, '--remote-vnet');
    if (!remote || !VNETS[remote] || remote === vnet) return out(`ERR --remote-vnet must be the other vnet (${Object.keys(VNETS).filter((v) => v !== vnet).join(', ')})`, 'error');
    if (g.peerings.some((p) => p.vnet === vnet && p.remote === remote)) return out(`(PeeringAlreadyExists) ${vnet} is already peered with ${remote}.`, 'error');
    const p: Peering = { name, vnet, remote, allowVnetAccess: hasFlag(cmd, '--allow-vnet-access') };
    g.peerings.push(p);
    g.changes++;
    out(JSON.stringify(peeringShow(g, p), null, 2), 'success');
    return;
  }
  const p = g.peerings.find((q) => q.vnet === vnet && q.name === name);
  if (!p) return out(`(ResourceNotFound) Peering '${name}' was not found on ${vnet}.`, 'error');
  if (sub === 'update') {
    const set = flagValue(cmd, '--set');
    const m = set?.match(/^allowVirtualNetworkAccess=(true|false)$/i);
    if (!m) return out('ERR Usage: az network vnet peering update -n <n> --vnet-name <vnet> --set allowVirtualNetworkAccess=true -g net-rg', 'error');
    p.allowVnetAccess = m[1].toLowerCase() === 'true';
    g.changes++;
    return out(JSON.stringify(peeringShow(g, p), null, 2), 'success');
  }
  if (sub === 'delete') {
    g.peerings = g.peerings.filter((q) => q !== p);
    g.changes++;
    return out(`OK  Peering '${name}' deleted.`, 'success');
  }
  out('ERR Usage: az network vnet peering <list|create|update|delete> ...', 'error');
}

function routeCmd(g: Game, out: Out, cmd: string) {
  const err = rgError(cmd);
  if (err) return out(err, 'error');
  if (flagValue(cmd, '--route-table-name') !== 'rt-web') return out('ERR --route-table-name rt-web is required', 'error');
  const sub = words(cmd)[4];
  if (sub === 'list' && flagValue(cmd, '--output', '-o')?.toLowerCase() === 'json') {
    return out(JSON.stringify(g.routes.map((r) => ({ name: r.name, addressPrefix: r.prefix, nextHopType: r.hop, nextHopIpAddress: r.hop === 'None' ? null : r.ip })), null, 2), 'success');
  }
  if (sub === 'list') {
    out(`${'Name'.padEnd(18)}${'Prefix'.padEnd(14)}${'NextHopType'.padEnd(18)}NextHopIp`, 'heading');
    g.routes.forEach((r) => out(`${r.name.padEnd(18)}${r.prefix.padEnd(14)}${r.hop.padEnd(18)}${r.hop === 'None' ? '' : r.ip}`));
    return;
  }
  if (sub === 'delete') {
    const name = flagValue(cmd, '--name', '-n');
    const route = g.routes.find((r) => r.name === name);
    if (!route) return out(`(ResourceNotFound) Route '${name ?? ''}' was not found in rt-web.`, 'error');
    g.routes = g.routes.filter((r) => r !== route);
    g.changes++;
    return out(`OK  Route '${route.name}' deleted.`, 'success');
  }
  out('ERR Usage: az network route-table route <list|delete> --route-table-name rt-web ...', 'error');
}

function nsgCmd(g: Game, out: Out, cmd: string) {
  const err = rgError(cmd);
  if (err) return out(err, 'error');
  const nsg = flagValue(cmd, '--nsg-name');
  if (nsg === 'nsg-web') return out(words(cmd)[4] === 'list' ? '[]' : 'ERR This drill only needs nsg-db.', words(cmd)[4] === 'list' ? 'output' : 'error');
  if (nsg !== 'nsg-db') return out('ERR --nsg-name must be nsg-db', 'error');
  const sub = words(cmd)[4];
  const name = flagValue(cmd, '--name', '-n');
  const show = (r: Rule) => ({ name: r.name, priority: r.priority, direction: r.direction, access: r.access, protocol: r.protocol, sourceAddressPrefix: r.src, destinationPortRange: r.dstPort });

  if (sub === 'list' && flagValue(cmd, '--output', '-o')?.toLowerCase() === 'json') {
    return out(JSON.stringify([...g.rules].sort((a, b) => a.priority - b.priority).map(show), null, 2), 'success');
  }
  if (sub === 'list') {
    out(`${'Name'.padEnd(20)}${'Priority'.padEnd(10)}${'Access'.padEnd(8)}${'Proto'.padEnd(7)}${'Source'.padEnd(18)}Port`, 'heading');
    [...g.rules].sort((a, b) => a.priority - b.priority).forEach((r) => out(`${r.name.padEnd(20)}${String(r.priority).padEnd(10)}${r.access.padEnd(8)}${r.protocol.padEnd(7)}${r.src.padEnd(18)}${r.dstPort}`));
    return;
  }
  if (!name) return out('ERR --name/-n is required', 'error');

  const setPriority = (r: Rule, raw: string | null): string | null => {
    if (raw === null) return null;
    const p = Number(raw);
    if (!Number.isInteger(p) || p < 100 || p > 4096) return '(InvalidSecurityRulePriority) Priority must be a whole number between 100 and 4096.';
    if (g.rules.some((o) => o !== r && o.priority === p)) return `(SecurityRuleConflict) Priority ${p} is already used by rule '${g.rules.find((o) => o.priority === p)!.name}'.`;
    r.priority = p;
    return null;
  };

  if (sub === 'create' || sub === 'update') {
    const existing = g.rules.find((r) => r.name === name);
    if (sub === 'create' && existing) return out(`(SecurityRuleConflict) A rule named '${name}' already exists.`, 'error');
    if (sub === 'update' && !existing) return out(`(ResourceNotFound) Rule '${name}' was not found on nsg-db.`, 'error');
    const r: Rule = existing ? { ...existing } : { name, priority: 0, direction: 'Inbound', access: 'Allow', protocol: '*', src: '*', dstPort: '*' };

    const priority = flagValue(cmd, '--priority');
    if (sub === 'create' && !priority) return out('ERR --priority is required', 'error');
    const perr = setPriority(r, priority);
    if (perr) return out(perr, 'error');
    const access = flagValue(cmd, '--access');
    if (access) {
      if (!['allow', 'deny'].includes(access.toLowerCase())) return out('ERR --access must be Allow or Deny', 'error');
      r.access = access.toLowerCase() === 'allow' ? 'Allow' : 'Deny';
    }
    const proto = flagValue(cmd, '--protocol');
    if (proto) {
      const found = ['Tcp', 'Udp', '*'].find((x) => x.toLowerCase() === proto.toLowerCase());
      if (!found) return out('ERR --protocol must be Tcp, Udp or *', 'error');
      r.protocol = found;
    }
    const src = flagValue(cmd, '--source-address-prefixes', '--source-address-prefix');
    if (src) {
      if (!(['*', 'Internet', 'VirtualNetwork', 'AzureLoadBalancer'].includes(src) || isCidr(src) || isIp(src))) return out(`ERR Invalid source '${src}'. Use a CIDR, an address, *, Internet or VirtualNetwork.`, 'error');
      r.src = src;
    }
    const port = flagValue(cmd, '--destination-port-ranges', '--destination-port-range');
    if (port) {
      if (!/^(\*|\d{1,5}(-\d{1,5})?)$/.test(port)) return out(`ERR Invalid port range '${port}'.`, 'error');
      r.dstPort = port;
    }
    if (existing) Object.assign(existing, r);
    else g.rules.push(r);
    g.changes++;
    return out(JSON.stringify(show(r), null, 2), 'success');
  }
  if (sub === 'delete') {
    const r = g.rules.find((x) => x.name === name);
    if (!r) return out(`(ResourceNotFound) Rule '${name}' was not found on nsg-db.`, 'error');
    g.rules = g.rules.filter((x) => x !== r);
    g.changes++;
    return out(`OK  Rule '${name}' deleted.`, 'success');
  }
  out('ERR Usage: az network nsg rule <list|create|update|delete> --nsg-name nsg-db ...', 'error');
}

function watcherCmd(g: Game, out: Out, cmd: string) {
  const err = rgError(cmd);
  if (err) return out(err, 'error');
  const sub = words(cmd)[3];

  if (sub === 'show-next-hop') {
    const vm = flagValue(cmd, '--vm');
    const src = flagValue(cmd, '--source-ip');
    const dst = flagValue(cmd, '--dest-ip');
    if (vm !== 'web-vm' || !src || !dst || !isIp(dst)) return out('ERR Usage: az network watcher show-next-hop --vm web-vm --source-ip 10.1.1.4 --dest-ip <ip> -g net-rg', 'error');
    const hop = nextHop(g, dst);
    out(
      JSON.stringify(
        { nextHopType: hop?.hopType ?? 'None', nextHopIpAddress: hop?.hopIp || null, routeTableId: hop?.source === 'User' ? id('Microsoft.Network/routeTables/rt-web') : null },
        null,
        2
      ),
      'success'
    );
    return;
  }

  if (sub === 'test-ip-flow') {
    const vm = flagValue(cmd, '--vm');
    const dir = flagValue(cmd, '--direction');
    const local = flagValue(cmd, '--local');
    const remote = flagValue(cmd, '--remote');
    const lm = local?.match(/^([\d.]+):(\d+|\*)$/);
    const rm = remote?.match(/^([\d.]+):(\d+|\*)$/);
    if (!vm || !VMS[vm] || !dir || !lm || !rm || !isIp(lm[1]) || !isIp(rm[1])) {
      return out('ERR Usage: az network watcher test-ip-flow --vm <vm> --direction <Inbound|Outbound> --protocol TCP --local <ip>:<port> --remote <ip>:<port> -g net-rg', 'error');
    }
    if (vm === 'db-vm' && dir.toLowerCase() === 'inbound') {
      const port = lm[2] === '*' ? 0 : Number(lm[2]);
      const r = evalInbound(g, rm[1], port);
      const custom = g.rules.some((x) => x.name === r.rule);
      return out(JSON.stringify({ access: r.access, ruleName: `${id('Microsoft.Network/networkSecurityGroups/nsg-db')}/${custom ? 'securityRules' : 'defaultSecurityRules'}/${r.rule}` }, null, 2), r.access === 'Allow' ? 'success' : 'error');
    }
    const name = dir.toLowerCase() === 'inbound' ? 'AllowVnetInBound' : 'AllowVnetOutBound';
    return out(JSON.stringify({ access: 'Allow', ruleName: `${id(`Microsoft.Network/networkSecurityGroups/nsg-${vm === 'web-vm' ? 'web' : 'db'}`)}/defaultSecurityRules/${name}` }, null, 2), 'success');
  }

  if (sub === 'test-connectivity') {
    const src = flagValue(cmd, '--source-resource');
    const port = Number(flagValue(cmd, '--dest-port'));
    const destRes = flagValue(cmd, '--dest-resource');
    const destAddr = flagValue(cmd, '--dest-address');
    if (src !== 'web-vm' || !port || (destRes !== 'db-vm' && destAddr !== DB_IP)) {
      return out('ERR Usage: az network watcher test-connectivity --source-resource web-vm --dest-resource db-vm --dest-port 1433 -g net-rg', 'error');
    }
    const t = trace(g);
    const hops: Record<string, unknown>[] = [{ type: 'Source', address: WEB_IP }];
    if (t.ok) {
      hops.push({ type: 'VNetPeering', address: DB_IP }, { type: 'VirtualMachine', address: DB_IP });
    } else if (t.layer === 'nsg') {
      hops.push({ type: 'VNetPeering' }, { type: 'VirtualMachine', address: DB_IP, issues: [{ origin: 'In', severity: 'Error', type: 'NetworkSecurityRule', context: [{ ruleName: t.rule }] }] });
    } else if (t.layer === 'route' && t.hop?.name) {
      hops.push({ type: 'VirtualAppliance', address: t.hop.hopIp, issues: [{ origin: 'Local', severity: 'Error', type: 'UserDefinedRoute', context: [{ routeName: t.hop.name }] }] });
    } else {
      hops.push({ type: 'VirtualAppliance', address: t.hop?.hopIp, issues: [{ origin: 'Local', severity: 'Error', type: 'Other', context: [{ message: 'no route to the destination virtual network; check the peering' }] }] });
    }
    out(JSON.stringify({ connectionStatus: t.ok ? 'Reachable' : 'Unreachable', hops, probesSent: 100, probesFailed: t.ok ? 0 : 100 }, null, 2), t.ok ? 'success' : 'error');
    return;
  }
  out('ERR Usage: az network watcher <show-next-hop|test-ip-flow|test-connectivity> ...', 'error');
}

// ---- az rest: raw ARM calls with a JSON body from ~/scratch ----

const ARM_ROOT = `/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/Microsoft.Network`;
const REST_USAGE = 'ERR Usage: az rest --method <get|put|delete> --url <ARM path> [--body @file.json]';
const REST_KINDS = `${ARM_ROOT}/networkSecurityGroups/nsg-db/securityRules/<rule>, ${ARM_ROOT}/routeTables/rt-web/routes/<route>, ${ARM_ROOT}/virtualNetworks/<vnet>/virtualNetworkPeerings/<peering>`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const ruleBody = (r: Rule): Obj => ({
  id: `${ARM_ROOT}/networkSecurityGroups/nsg-db/securityRules/${r.name}`,
  name: r.name,
  type: 'Microsoft.Network/networkSecurityGroups/securityRules',
  properties: { provisioningState: 'Succeeded', priority: r.priority, access: r.access, direction: r.direction, protocol: r.protocol, sourceAddressPrefix: r.src, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: r.dstPort },
});

const routeBody = (r: Route): Obj => ({
  id: `${ARM_ROOT}/routeTables/rt-web/routes/${r.name}`,
  name: r.name,
  type: 'Microsoft.Network/routeTables/routes',
  properties: { provisioningState: 'Succeeded', addressPrefix: r.prefix, nextHopType: r.hop, ...(r.hop === 'None' ? {} : { nextHopIpAddress: r.ip }) },
});

const peeringBody = (g: Game, p: Peering): Obj => ({
  id: `${ARM_ROOT}/virtualNetworks/${p.vnet}/virtualNetworkPeerings/${p.name}`,
  name: p.name,
  type: 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings',
  properties: { provisioningState: 'Succeeded', peeringState: peeringState(g, p), remoteVirtualNetwork: { id: `${ARM_ROOT}/virtualNetworks/${p.remote}` }, allowVirtualNetworkAccess: p.allowVnetAccess },
});

const bad = (msg: string) => `(InvalidRequestContent) The request content was invalid and could not be deserialized: ${msg}`;

function putRule(g: Game, name: string, body: Obj): { error: string } | { result: Obj; created: boolean } {
  const p = body.properties;
  if (!isObj(p)) return { error: bad('the body needs a "properties" object.') };
  for (const k of ['priority', 'access', 'direction', 'protocol', 'sourceAddressPrefix', 'destinationPortRange']) {
    if (p[k] === undefined) return { error: bad(`property 'properties.${k}' is required.`) };
  }
  const priority = p.priority;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 100 || priority > 4096) return { error: '(InvalidSecurityRulePriority) Priority must be a whole number between 100 and 4096.' };
  const access = ['Allow', 'Deny'].find((a) => a.toLowerCase() === String(p.access).toLowerCase());
  if (!access) return { error: bad("'properties.access' must be Allow or Deny.") };
  if (String(p.direction).toLowerCase() !== 'inbound') return { error: bad("'properties.direction' must be Inbound: this drill only has inbound rules.") };
  const protocol = ['Tcp', 'Udp', '*'].find((x) => x.toLowerCase() === String(p.protocol).toLowerCase());
  if (!protocol) return { error: bad("'properties.protocol' must be Tcp, Udp or *.") };
  const src = String(p.sourceAddressPrefix);
  if (!(['*', 'Internet', 'VirtualNetwork', 'AzureLoadBalancer'].includes(src) || isCidr(src) || isIp(src))) return { error: `(InvalidSecurityRule) Invalid sourceAddressPrefix '${src}'. Use a CIDR, an address, *, Internet or VirtualNetwork.` };
  const port = String(p.destinationPortRange);
  if (!/^(\*|\d{1,5}(-\d{1,5})?)$/.test(port)) return { error: `(InvalidSecurityRule) Invalid destinationPortRange '${port}'.` };
  const clash = g.rules.find((o) => o.name !== name && o.priority === priority);
  if (clash) return { error: `(SecurityRuleConflict) Priority ${priority} is already used by rule '${clash.name}'.` };
  const rule: Rule = { name, priority, direction: 'Inbound', access: access as Rule['access'], protocol, src, dstPort: port };
  const existing = g.rules.find((r) => r.name === name);
  if (existing) Object.assign(existing, rule);
  else g.rules.push(rule);
  return { result: ruleBody(rule), created: !existing };
}

function putRoute(g: Game, name: string, body: Obj): { error: string } | { result: Obj; created: boolean } {
  const p = body.properties;
  if (!isObj(p)) return { error: bad('the body needs a "properties" object.') };
  const prefix = String(p.addressPrefix ?? '');
  if (!isCidr(prefix)) return { error: bad("'properties.addressPrefix' must be a CIDR such as 10.2.0.0/16.") };
  const hop = p.nextHopType;
  if (hop !== 'VirtualAppliance' && hop !== 'None') return { error: bad("'properties.nextHopType' must be VirtualAppliance or None in this drill.") };
  const ip = String(p.nextHopIpAddress ?? '');
  if (hop === 'VirtualAppliance' && !isIp(ip)) return { error: bad("'properties.nextHopIpAddress' is required for a VirtualAppliance route.") };
  const route: Route = { name, prefix, hop, ip: hop === 'None' ? '' : ip };
  const existing = g.routes.find((r) => r.name === name);
  if (existing) Object.assign(existing, route);
  else g.routes.push(route);
  return { result: routeBody(route), created: !existing };
}

function putPeering(g: Game, vnet: string, name: string, body: Obj): { error: string } | { result: Obj; created: boolean } {
  const p = body.properties;
  if (!isObj(p)) return { error: bad('the body needs a "properties" object.') };
  const remoteId = isObj(p.remoteVirtualNetwork) ? String(p.remoteVirtualNetwork.id ?? '') : '';
  const remote = remoteId.split('/').pop() ?? '';
  if (!remoteId || !VNETS[remote]) return { error: bad(`'properties.remoteVirtualNetwork.id' must be the resource ID of the other vnet (${Object.keys(VNETS).filter((v) => v !== vnet).join(' or ')}).`) };
  if (remote === vnet) return { error: bad("'properties.remoteVirtualNetwork.id' cannot point back at the same vnet.") };
  if (p.allowVirtualNetworkAccess !== undefined && typeof p.allowVirtualNetworkAccess !== 'boolean') return { error: bad("'properties.allowVirtualNetworkAccess' must be true or false.") };
  const existing = g.peerings.find((q) => q.vnet === vnet && q.name === name);
  if (!existing && g.peerings.some((q) => q.vnet === vnet && q.remote === remote)) return { error: `(PeeringAlreadyExists) ${vnet} is already peered with ${remote}.` };
  const allow = p.allowVirtualNetworkAccess === true;
  const peering: Peering = { name, vnet, remote, allowVnetAccess: allow };
  if (existing) Object.assign(existing, peering);
  else g.peerings.push(peering);
  return { result: peeringBody(g, existing ?? peering), created: !existing };
}

function restCmd(g: Game, out: Out, cmd: string) {
  const method = (flagValue(cmd, '--method', '-m') ?? 'get').toLowerCase();
  const rawUrl = flagValue(cmd, '--url', '--uri', '-u');
  if (!rawUrl || !['get', 'put', 'delete'].includes(method)) return out(REST_USAGE, 'error');
  const path = rawUrl.replace(/^https:\/\/management\.azure\.com/i, '').split('?')[0].replace(/\/$/, '');
  const m = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/(.+)$/i.exec(path);
  if (!m) return out(`(InvalidRequest) '${rawUrl}' is not an ARM resource path. Start with /subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/Microsoft.Network/...`, 'error');
  if (m[1].toLowerCase() !== SUB_ID) return out(`(SubscriptionNotFound) The subscription '${m[1]}' could not be found.`, 'error');
  if (m[2].toLowerCase() !== RG) return out(`(ResourceGroupNotFound) Resource group '${m[2]}' could not be found.`, 'error');
  const seg = m[3].split('/');
  const notFound = `(ResourceNotFound) The Resource 'Microsoft.Network/${m[3]}' under resource group '${RG}' was not found.`;

  type Kind = { name: string; read: () => Obj | null; put: (b: Obj) => { error: string } | { result: Obj; created: boolean }; del: () => boolean };
  let kind: Kind | null = null;
  let collection: (() => Obj) | null = null;
  const t = seg.map((x) => x.toLowerCase());
  if (t[0] === 'networksecuritygroups' && seg[1] === 'nsg-db') {
    if (t[2] === 'securityrules' && seg[3] && seg.length === 4) {
      const name = seg[3];
      kind = { name, read: () => { const r = g.rules.find((x) => x.name === name); return r ? ruleBody(r) : null; }, put: (b) => putRule(g, name, b), del: () => { const had = g.rules.some((x) => x.name === name); g.rules = g.rules.filter((x) => x.name !== name); return had; } };
    } else if (seg.length === 2) collection = () => ({ name: 'nsg-db', properties: { securityRules: [...g.rules].sort((a, b) => a.priority - b.priority).map(ruleBody) } });
  } else if (t[0] === 'routetables' && seg[1] === 'rt-web') {
    if (t[2] === 'routes' && seg[3] && seg.length === 4) {
      const name = seg[3];
      kind = { name, read: () => { const r = g.routes.find((x) => x.name === name); return r ? routeBody(r) : null; }, put: (b) => putRoute(g, name, b), del: () => { const had = g.routes.some((x) => x.name === name); g.routes = g.routes.filter((x) => x.name !== name); return had; } };
    } else if (seg.length === 2) collection = () => ({ name: 'rt-web', properties: { routes: g.routes.map(routeBody) } });
  } else if (t[0] === 'virtualnetworks' && VNETS[seg[1]]) {
    const vnet = seg[1];
    if (t[2] === 'virtualnetworkpeerings' && seg[3] && seg.length === 4) {
      const name = seg[3];
      kind = { name, read: () => { const p = g.peerings.find((x) => x.vnet === vnet && x.name === name); return p ? peeringBody(g, p) : null; }, put: (b) => putPeering(g, vnet, name, b), del: () => { const had = g.peerings.some((x) => x.vnet === vnet && x.name === name); g.peerings = g.peerings.filter((x) => !(x.vnet === vnet && x.name === name)); return had; } };
    } else if (t[2] === 'virtualnetworkpeerings' && seg.length === 3) collection = () => ({ value: g.peerings.filter((p) => p.vnet === vnet).map((p) => peeringBody(g, p)) });
  }

  if (method === 'get') {
    if (collection) return out(JSON.stringify(collection(), null, 2), 'success');
    if (!kind) return out(`(InvalidResourceType) az rest supports only: ${REST_KINDS}`, 'error');
    const found = kind.read();
    return found ? out(JSON.stringify(found, null, 2), 'success') : out(notFound, 'error');
  }
  if (!kind) return out(`(InvalidResourceType) az rest ${method} supports only: ${REST_KINDS}`, 'error');
  if (method === 'delete') {
    if (!kind.del()) return out('OK  204 No Content: nothing to delete.');
    g.changes++;
    return out(`OK  200 deleted '${kind.name}'.`, 'success');
  }
  const bodyRef = flagValue(cmd, '--body', '-b');
  if (!bodyRef) return out('ERR az rest put needs --body @file.json (a JSON file from ~/scratch)', 'error');
  if (!isFileRef(bodyRef)) return out("ERR --body expects @file.json, e.g. --body @rule.json. Edit the file in the panel under the terminal.", 'error');
  const parsed = readScratchJson(g, out, bodyRef);
  if (!parsed) return;
  if (!isObj(parsed.value)) return out(bad(`'${parsed.name}' must hold one JSON object.`), 'error');
  const res = kind.put(parsed.value);
  if ('error' in res) return out(res.error, 'error');
  g.changes++;
  out(JSON.stringify(res.result, null, 2), 'success');
  out(`# ${res.created ? '201 Created' : '200 OK, the resource was replaced with exactly what the body says'}`, 'heading');
}

/** What the shell layer needs from this lab. */
export const HOST: Host<Game> = { execute, prompt: () => PROMPT, cfg: SCRATCH };

/** Runs whatever was typed (one line or several) and returns the new game. */
export const runCommand = (prev: Game, text: string): Game => runShell(prev, text, HOST);

/** The bash prompt, e.g. user@host:~$. */
export const livePrompt = (g: Game): string => HOST.prompt(g);

function execute(prev: Game, cmd: string, _echo: string | null): Game {
  if (cmd === 'clear') return { ...prev, history: [] };
  if (cmd === 'restart') return initialGame();

  const g = draft(prev);
  const out = writer(g);
  // the shell layer prints the typed line; nothing to echo here

  if (cmd === 'help') {
    out('# commands', 'heading');
    HELP_COMMANDS.forEach(([c, d]) => out(`  ${c}\n      ${d}`));
  } else if (scratchCommand(g, out, cmd, SCRATCH)) {
    // ls, cat, edit, touch, rm: handled by the scratch module
  } else if (cmd.startsWith('az rest')) {
    restCmd(g, out, cmd);
  } else if (cmd === 'hint') {
    out(`HINT ${nextHint(g)}`, 'alert');
  } else if (cmd === 'submit') {
    debrief(g, out);
  } else if (cmd.startsWith('az vm list')) {
    const err = rgError(cmd);
    if (err) out(err, 'error');
    else {
      out(`${'Name'.padEnd(10)}${'PrivateIPs'.padEnd(12)}${'Vnet'.padEnd(11)}Subnet`, 'heading');
      Object.entries(VMS).forEach(([n, v]) => out(`${n.padEnd(10)}${v.ip.padEnd(12)}${v.vnet.padEnd(11)}${v.subnet}`));
    }
  } else if (cmd.startsWith('az network vnet peering')) {
    peeringCmd(g, out, cmd);
  } else if (cmd.startsWith('az network route-table route')) {
    routeCmd(g, out, cmd);
  } else if (cmd.startsWith('az network nic list-effective-route-table')) {
    const err = rgError(cmd);
    if (err) out(err, 'error');
    else if (flagValue(cmd, '--name', '-n') !== 'web-vm-nic') out('ERR --name web-vm-nic is the NIC to inspect', 'error');
    else {
      out(`${'Source'.padEnd(9)}${'State'.padEnd(9)}${'Prefix'.padEnd(14)}${'NextHopType'.padEnd(18)}NextHopIp`, 'heading');
      effectiveRoutes(g).forEach((r) => out(`${r.source.padEnd(9)}${r.state.padEnd(9)}${r.prefix.padEnd(14)}${r.hopType.padEnd(18)}${r.hopIp}${r.name ? `   (${r.name})` : ''}`, r.state === 'Invalid' ? 'output' : 'success'));
    }
  } else if (cmd.startsWith('az network nsg rule')) {
    nsgCmd(g, out, cmd);
  } else if (cmd.startsWith('az network watcher')) {
    watcherCmd(g, out, cmd);
  } else {
    out(`bash: ${cmd.split(' ')[0]}: command not recognized. Type "help" for usage.`, 'error');
  }
  return g;
}
