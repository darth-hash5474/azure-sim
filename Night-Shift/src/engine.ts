// Game engine for Night Shift: a simulated slice of Azure Monitor, Log Analytics and Azure Backup. No React in here.

import { isFileRef, readScratchJson, readScratchText, scratchCommand, type ScratchConfig } from './scratch';
import { newShell, promptFor, runShell, type Host, type ShellEnv } from './shell';
import { splitWords } from './shellcore';
import { CMDLETS } from './cmdlets';

export type LineType = 'input' | 'output' | 'error' | 'success' | 'heading' | 'alert';

export interface Line {
  text: string;
  type: LineType;
}

export interface Vault {
  name: string;
  kind: 'rsv' | 'backup'; // Recovery Services vault vs Backup vault
  location: string;
}

export interface AlertRule {
  name: string;
  scope: string;
  metric: string;
  agg: string;
  op: string;
  threshold: number;
  window: string;
  freq: string;
  actions: string[];
  managed: boolean; // owned by another team
}

export interface ProcRule {
  name: string;
  type: 'RemoveAllActionGroups' | 'AddActionGroups';
  scope: string;
}

export interface Job {
  id: string;
  doneAt: number;
  done: boolean;
}

export interface Game {
  clock: number; // minutes since midnight
  vm: 'running' | 'deleted' | 'restored';
  pages: number;
  dcrAssociatedAt: number | null; // batch-vm onboarded to the data collection rule
  foundCulprit: boolean;
  actionGroups: { name: string; email: string }[];
  alerts: AlertRule[];
  procRules: ProcRule[];
  vaults: Vault[];
  protectedBy: string | null;
  jobs: Job[];
  recoveryPoints: { name: string; at: number }[];
  lost: boolean; // batch-vm deleted with no recovery point
  solved: boolean;
  files: Record<string, string>; // ~/scratch: ticket.txt, query.kql, actiongroup.json, alert.json, silence.json and whatever the player adds
  focus: string | null; // file the editor panel shows
  sh: ShellEnv; // which shell is open (bash or PowerShell) and its variables
  history: Line[];
}

type Out = (text: string, type?: LineType) => void;

export const RG = 'ops-rg';
export const LOCATION = 'eastus';
export const SUB_ID = '6b1e9d3a-2f7c-4a58-b0e4-8c3d5f1a7e92';
export const START = 2 * 60 + 12; // 02:12
export const DELETE_AT = 3 * 60 + 15; // 03:15
export const VMS = ['web-vm', 'batch-vm', 'report-vm'];
const VM_METRICS = ['Percentage CPU', 'Network In Total', 'Network Out Total', 'Disk Read Bytes', 'Disk Write Bytes', 'Available Memory Bytes'];
const WINDOWS = ['1m', '5m', '15m', '30m', '1h', '2h', '6h', '12h', '1d'];
const FREQS = ['1m', '5m', '15m', '30m', '1h'];
const mins = (s: string) => (s.endsWith('m') ? Number(s.slice(0, -1)) : s.endsWith('h') ? Number(s.slice(0, -1)) * 60 : Number(s.slice(0, -1)) * 1440);

export const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const rgScope = `/subscriptions/${SUB_ID}/resourceGroups/${RG}`;

// ---- derived state ----

const coversBatchVm = (scope: string) => scope === RG || scope === 'batch-vm' || scope.endsWith(`/resourceGroups/${RG}`) || scope.endsWith('/virtualMachines/batch-vm') || scope === `/subscriptions/${SUB_ID}`;

/** A removal rule that covers the noisy rule's scope silences its notifications. */
export const silenced = (g: Game) => g.procRules.some((r) => r.type === 'RemoveAllActionGroups' && coversBatchVm(r.scope));

const stormActive = (g: Game) => g.vm === 'running' && !silenced(g);

const goodAlert = (a: AlertRule, g: Game) =>
  a.scope === 'batch-vm' && a.metric === 'Percentage CPU' && a.agg === 'avg' && a.op === '>' && a.threshold >= 70 && a.threshold <= 95 && a.actions.some((n) => g.actionGroups.find((x) => x.name === n)?.email);

export interface Check {
  label: string;
  ok: boolean;
}

export function audit(g: Game): Check[] {
  return [
    { label: 'Found who started the job', ok: g.foundCulprit },
    { label: 'High-CPU alert with a real action group', ok: g.alerts.some((a) => !a.managed && goodAlert(a, g)) },
    { label: 'Page storm silenced', ok: silenced(g) },
    { label: 'Backup taken before 03:15', ok: g.recoveryPoints.length > 0 },
    { label: 'batch-vm restored', ok: g.vm === 'restored' },
  ];
}

// ---- Log Analytics ----

type Row = Record<string, string | number>;

const TABLE_COLS: Record<string, string[]> = {
  Heartbeat: ['TimeGenerated', 'Computer', 'Category'],
  Syslog: ['TimeGenerated', 'Computer', 'ProcessName', 'SyslogMessage', 'SeverityLevel'],
};

function tableRows(g: Game, table: string): Row[] {
  const rows: Row[] = [];
  const now = g.clock;
  if (table === 'Heartbeat') {
    for (let m = now - 59; m < now; m++) for (const c of ['web-vm', 'report-vm']) rows.push({ TimeGenerated: hhmm(m), Computer: c, Category: 'Direct Agent' });
    if (g.dcrAssociatedAt !== null) for (let m = g.dcrAssociatedAt; m <= now - 5; m++) rows.push({ TimeGenerated: hhmm(m), Computer: 'batch-vm', Category: 'Direct Agent' });
  } else {
    for (let m = Math.max(now - 30, START - 30); m < now; m++) rows.push({ TimeGenerated: hhmm(m), Computer: 'web-vm', ProcessName: 'CRON', SyslogMessage: 'pam_unix(cron:session): session opened for user www-data', SeverityLevel: 'info' });
    if (g.dcrAssociatedAt !== null) {
      for (let m = g.dcrAssociatedAt; m <= now - 5; m++) {
        rows.push({ TimeGenerated: hhmm(m), Computer: 'batch-vm', ProcessName: 'CRON', SyslogMessage: 'pam_unix(cron:session): session opened for user root', SeverityLevel: 'info' });
        rows.push({ TimeGenerated: hhmm(m), Computer: 'batch-vm', ProcessName: 'nightly-reindex.sh', SyslogMessage: `pid 4121 running as user intern: reindex pass ${((m - g.dcrAssociatedAt) % 9) + 1} of 9 (8 workers)`, SeverityLevel: 'warning' });
      }
    }
  }
  return rows;
}

/** Splits a pipeline on | outside quotes. */
function stages(q: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of q) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '|') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function runKql(g: Game, q: string): { cols: string[]; rows: Row[] } | { error: string } {
  const parts = stages(q);
  const table = parts[0];
  if (!TABLE_COLS[table]) {
    return { error: `(BadRequest) 'where' operator: Failed to resolve table or column expression named '${table}'. Tables in this workspace: ${Object.keys(TABLE_COLS).join(', ')}.` };
  }
  let cols = TABLE_COLS[table];
  let rows = tableRows(g, table);
  const needCol = (c: string) => (cols.includes(c) ? null : `(BadRequest) Failed to resolve scalar expression named '${c}'. Columns: ${cols.join(', ')}.`);

  for (const stage of parts.slice(1)) {
    let m: RegExpMatchArray | null;
    if ((m = stage.match(/^(?:where)\s+(.+)$/i))) {
      for (const clause of m[1].split(/\s+and\s+/i)) {
        const c = clause.match(/^(\w+)\s*(==|=~|!=|contains|has)\s*(?:(["'])(.*?)\3|(\S+))$/i);
        if (!c) return { error: `(BadRequest) Syntax error near '${clause}'. Supported: Col == 'x', =~, !=, contains, has.` };
        const err = needCol(c[1]);
        if (err) return { error: err };
        const want = String(c[4] ?? c[5]);
        const op = c[2].toLowerCase();
        rows = rows.filter((r) => {
          const v = String(r[c[1]]);
          return op === '==' ? v === want : op === '=~' ? v.toLowerCase() === want.toLowerCase() : op === '!=' ? v !== want : v.toLowerCase().includes(want.toLowerCase());
        });
      }
    } else if ((m = stage.match(/^project\s+(.+)$/i))) {
      const want = m[1].split(',').map((s) => s.trim());
      for (const c of want) {
        const err = needCol(c);
        if (err) return { error: err };
      }
      cols = want;
    } else if ((m = stage.match(/^(?:take|limit)\s+(\d+)$/i))) {
      rows = rows.slice(0, Number(m[1]));
    } else if ((m = stage.match(/^(?:order|sort)\s+by\s+(\w+)(?:\s+(asc|desc))?$/i))) {
      const err = needCol(m[1]);
      if (err) return { error: err };
      const dir = (m[2] ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
      const col = m[1];
      rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col]), undefined, { numeric: true }) * dir);
    } else if ((m = stage.match(/^summarize\s+count\(\)\s+by\s+(\w+)$/i))) {
      const err = needCol(m[1]);
      if (err) return { error: err };
      const counts = new Map<string, number>();
      rows.forEach((r) => counts.set(String(r[m![1]]), (counts.get(String(r[m![1]])) ?? 0) + 1));
      cols = [m[1], 'count_'];
      rows = [...counts.entries()].map(([k, n]) => ({ [m![1]]: k, count_: n }));
    } else if (/^count$/i.test(stage)) {
      cols = ['Count'];
      rows = [{ Count: rows.length }];
    } else {
      return { error: `(BadRequest) Unsupported operator '${stage.split(/\s+/)[0]}'. This simulator knows where, project, take, order by, summarize count() by, count.` };
    }
  }
  return { cols, rows };
}

// ---- time ----

function advance(g: Game, out: Out, minutes: number) {
  for (let i = 0; i < minutes; i++) {
    g.clock++;
    if (stormActive(g)) g.pages += 2;
    for (const j of g.jobs) {
      if (!j.done && g.clock >= j.doneAt) {
        j.done = true;
        const rp = { name: `rp-${hhmm(g.clock).replace(':', '')}`, at: g.clock };
        g.recoveryPoints.push(rp);
        out(`[${hhmm(g.clock)}] backup job ${j.id} completed. Recovery point ${rp.name} created.`, 'success');
      }
    }
    if (g.clock === DELETE_AT && g.vm === 'running') {
      g.vm = 'deleted';
      out(`[${hhmm(g.clock)}] ALERT: nightly-reindex.sh (user intern) has deleted batch-vm and its disks.`, 'error');
      if (!g.recoveryPoints.length) {
        g.lost = true;
        out('There is no recovery point, so batch-vm is gone for good. Type "restart" to run the night again.', 'error');
      } else out('Recovery points exist: restore from one.', 'alert');
    }
  }
}

// ---- state ----

const intro = (): Line[] => [
  { text: 'Azure Cloud Shell (simulated) · subscription contoso-prod · resource group ops-rg · on call', type: 'output' },
  { text: `02:12. Pager storm: the on-call phone has been buzzing since 02:00 and batch-vm looks wrong. A runaway job is on it.`, type: 'alert' },
  { text: 'Find out what is happening and who started it, set up proper alerting, silence the noise, and be ready to recover.', type: 'output' },
  { text: 'BRIEF: cat ticket.txt. Every az command costs a minute of the night; the clock is in the panel on the right.', type: 'output' },
  { text: 'SCRATCH: ~/scratch holds query.kql and JSON drafts (actiongroup.json, alert.json, silence.json). Edit them live in the panel under the terminal; "ls" lists them.', type: 'output' },
  { text: 'Type "help" for commands, "hint" if you get stuck and "submit" when you are done.', type: 'output' },
];

export const initialGame = (): Game => ({
  clock: START,
  vm: 'running',
  pages: 46,
  dcrAssociatedAt: null,
  foundCulprit: false,
  actionGroups: [{ name: 'ag-legacy', email: 'all-staff@contoso.com' }],
  alerts: [{ name: 'cpu-test', scope: 'batch-vm', metric: 'Percentage CPU', agg: 'avg', op: '>', threshold: 5, window: '1m', freq: '1m', actions: ['ag-legacy'], managed: true }],
  procRules: [],
  vaults: [{ name: 'bvault-ops', kind: 'backup', location: LOCATION }],
  protectedBy: null,
  jobs: [],
  recoveryPoints: [],
  lost: false,
  solved: false,
  files: initialFiles(),
  focus: null,
  sh: newShell(),
  history: intro(),
});

const draft = (g: Game): Game => ({
  ...g,
  actionGroups: g.actionGroups.map((a) => ({ ...a })),
  alerts: g.alerts.map((a) => ({ ...a, actions: [...a.actions] })),
  procRules: g.procRules.map((r) => ({ ...r })),
  vaults: g.vaults.map((v) => ({ ...v })),
  jobs: g.jobs.map((j) => ({ ...j })),
  recoveryPoints: g.recoveryPoints.map((r) => ({ ...r })),
  files: { ...g.files },
  history: [...g.history],
});

const writer =
  (g: Game): Out =>
  (text, type = 'output') =>
    g.history.push({ text, type });

export const PROMPT = 'oncall@contoso-prod:~$';

// ---- command parsing ----

const words = (cmd: string) => splitWords(cmd);

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2');

const flagValue = (cmd: string, ...names: string[]): string | null => {
  const parts = words(cmd);
  const idx = parts.findIndex((p) => names.includes(p));
  return idx >= 0 && parts[idx + 1] && !parts[idx + 1].startsWith('--') ? unquote(parts[idx + 1]) : null;
};

/** The value of a flag whose value may be quoted and contain spaces. */
const quotedFlag = (cmd: string, name: string): string | null => {
  const parts = words(cmd);
  const idx = parts.indexOf(name);
  return idx >= 0 && parts[idx + 1] !== undefined ? parts[idx + 1] : null;
};

const rgError = (cmd: string): string | null => {
  const rg = flagValue(cmd, '--resource-group', '-g');
  return rg === RG ? null : rg ? `(ResourceGroupNotFound) Resource group '${rg}' could not be found.` : `ERR --resource-group is required (-g ${RG})`;
};

const vmName = (token: string | null): string | null => {
  const n = token?.split('/').pop() ?? '';
  return VMS.includes(n) ? n : null;
};

// ---- ticket / help ----

const TICKET = [
  'INC-5530 · batch-vm pager storm',
  '',
  '  02:00  the on-call phone starts buzzing: rule cpu-test (platform team) fires every minute on batch-vm',
  '  02:09  batch-vm CPU jumps from the usual ~8% and stays high',
  '  03:15  a scheduled clean-up inside the same job deletes batch-vm. Nobody has said what the job is.',
  '',
  'Your night',
  '  · work out which VM is misbehaving and who started the job. batch-vm should be sending logs to law-ops, but nothing arrives',
  '  · build the alert you would want: average CPU on batch-vm above 85%, paging an action group with a real email receiver',
  '  · stop the paging. The platform team owns cpu-test and will not let you edit it. Silence it without touching the rule',
  '  · batch-vm has no backup. Protect it before 03:15 so you can bring it back',
];

/** ~/scratch: the ticket is read-only; the query and the JSON bodies are drafts the player edits live. */
export const SCRATCH: ScratchConfig = { readonly: ['ticket.txt'] };

const armId = (path: string) => `${rgScope}/providers/${path}`;
const VM_ID = armId('Microsoft.Compute/virtualMachines/batch-vm');

const initialFiles = (): Record<string, string> => ({
  'ticket.txt': TICKET.join('\n'),
  'query.kql': '// Run with: az monitor log-analytics query -w law-ops --analytics-query @query.kql\nHeartbeat\n| summarize count() by Computer\n',
  'actiongroup.json':
    '{\n  "location": "Global",\n  "properties": {\n    "groupShortName": "oncall",\n    "enabled": true,\n    "emailReceivers": [\n      { "name": "oncall-lead", "emailAddress": "" }\n    ]\n  }\n}\n',
  'alert.json': `{\n  "location": "global",\n  "properties": {\n    "severity": 2,\n    "enabled": true,\n    "scopes": [ "${VM_ID}" ],\n    "evaluationFrequency": "PT1M",\n    "windowSize": "PT5M",\n    "criteria": {\n      "odata.type": "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",\n      "allOf": [\n        {\n          "name": "cpu",\n          "criterionType": "StaticThresholdCriterion",\n          "metricName": "Percentage CPU",\n          "operator": "GreaterThan",\n          "threshold": 50,\n          "timeAggregation": "Average"\n        }\n      ]\n    },\n    "actions": [ { "actionGroupId": "${armId('Microsoft.Insights/actionGroups/oncall-ag')}" } ]\n  }\n}\n`,
  'silence.json': '{\n  "location": "Global",\n  "properties": {\n    "scopes": [],\n    "enabled": true,\n    "actions": [ { "actionType": "RemoveAllActionGroups" } ]\n  }\n}\n',
});

const HELP_COMMANDS: [string, string][] = [
  ['help · clear · restart', 'This guide · flush output · reset the night'],
  ['hint · submit · wait', 'Nudge · run the review · skip ahead to the next scheduled event'],
  ['ls · cat <file> · edit <file> · touch <file> · rm <file>', 'The ~/scratch folder (cat ticket.txt for the brief). Files open in the editor below the terminal and save as you type'],
  ['az monitor log-analytics query -w law-ops --analytics-query @query.kql', 'Run a multi-line KQL file ("//" lines are comments)'],
  ['az rest --method <get|put|delete> --url <ARM path> [--body @file.json]', 'Raw ARM call with a JSON body from ~/scratch: Microsoft.Insights/actionGroups/<n>, Microsoft.Insights/metricAlerts/<n>, Microsoft.AlertsManagement/actionRules/<n>. A GET on cpu-test shows what a real rule looks like'],
  ['<command> > <file>', 'Save any output into ~/scratch, e.g. az rest ... metricAlerts/cpu-test > cpu.json'],
  [`az resource list -g ${RG}`, 'What is in the group'],
  ['az monitor metrics list --resource <vm> -g ops-rg --metric "Percentage CPU"', 'Recent platform metrics for a VM'],
  ['az monitor log-analytics query -w law-ops --analytics-query "<kql>"', 'Query logs. Tables: Heartbeat, Syslog. KQL: where, project, take, order by, summarize count() by'],
  ['az monitor data-collection rule association create --name <n> --resource <vm> --rule-id dcr-ops -g ops-rg', 'Send a VM\'s guest logs to law-ops'],
  ['az monitor diagnostic-settings create --resource <vm> --workspace law-ops ...', 'Route resource logs to a workspace'],
  ['az monitor action-group create -n <n> -g ops-rg --action email <name> <address>', 'An action group with an email receiver'],
  ['az monitor metrics alert create -n <n> -g ops-rg --scopes <vm> --condition "avg Percentage CPU > 85" --window-size 5m --evaluation-frequency 1m --action <group>', 'A metric alert rule'],
  ['az monitor metrics alert list|delete -g ops-rg [-n <rule>]', 'Alert rules'],
  ['az monitor alert-processing-rule create -n <n> -g ops-rg --rule-type <RemoveAllActionGroups|AddActionGroups> --scopes <scope> [--action-groups <g>]', 'Change notifications without touching the rule'],
  ['az backup vault create -n <n> -g ops-rg --location <region>', 'A Recovery Services vault'],
  ['az backup policy list --vault-name <v> -g ops-rg', 'Backup policies in a vault'],
  ['az backup protection enable-for-vm --vault-name <v> -g ops-rg --vm batch-vm --policy-name <p>', 'Protect a VM'],
  ['az backup protection backup-now --vault-name <v> -g ops-rg --container-name batch-vm --item-name batch-vm', 'Take a backup now (takes 10 minutes)'],
  ['az backup job list --vault-name <v> -g ops-rg', 'Backup jobs and their status'],
  ['az backup recoverypoint list --vault-name <v> -g ops-rg --container-name batch-vm --item-name batch-vm', 'Recovery points'],
  ['az backup restore restore-disks --vault-name <v> -g ops-rg --container-name batch-vm --item-name batch-vm --rp-name <rp> --storage-account opsrestore --target-resource-group ops-rg', 'Restore a lost VM'],
];

function nextHint(g: Game): string {
  if (g.lost) return 'batch-vm is gone with no recovery point. Type "restart" and back it up before 03:15.';
  if (g.vm === 'deleted') return 'Restore from a recovery point: az backup recoverypoint list, then az backup restore restore-disks.';
  const a = audit(g);
  if (!a[0].ok) {
    if (g.dcrAssociatedAt === null) return 'Heartbeat shows which VMs report to law-ops: "Heartbeat | summarize count() by Computer". batch-vm is missing, so associate it with the data collection rule dcr-ops.';
    return 'Logs take about 5 minutes to appear. Query Syslog for batch-vm: look at ProcessName and who the job runs as.';
  }
  if (!a[1].ok) return 'Create an action group with an email receiver, then a metric alert on batch-vm: avg Percentage CPU > 85 with --action <group>. The evaluation frequency cannot exceed the window.';
  if (!a[2].ok) return 'You cannot edit cpu-test, but an alert processing rule of type RemoveAllActionGroups on the group (or the VM) silences its notifications.';
  if (!a[3].ok) {
    if (!g.vaults.some((v) => v.kind === 'rsv')) return 'VM backup needs a Recovery Services vault, in the same region as the VM. bvault-ops is a Backup vault, which cannot protect VMs.';
    if (!g.protectedBy) return 'Enable protection for batch-vm with a policy, then take a backup now. It needs 10 minutes of the night.';
    return 'Run backup-now and let it finish (check "az backup job list"). It has to complete before 03:15.';
  }
  if (!a[4].ok) return 'Everything is ready. Type "wait" to run the clock to 03:15, when the job deletes batch-vm, then restore it.';
  return 'Type "submit".';
}

function debrief(g: Game, out: Out) {
  const checks = audit(g);
  out('# shift handover', 'heading');
  checks.forEach((c) => out(`  ${c.ok ? '[PASS]' : '[FAIL]'} ${c.label}`, c.ok ? 'success' : 'error'));
  if (!checks.every((c) => c.ok)) {
    out('  Not ready to hand over. Fix the failing items and submit again.', 'alert');
    return;
  }
  g.solved = true;
  out('  HANDED OVER. Quiet pager, real alerting, and batch-vm is back.', 'success');
  out('# what to take away', 'heading');
  out('  · Platform metrics (CPU, network) exist without any setup. Guest data (Syslog, Perf) needs the Azure Monitor Agent and a');
  out('    data collection rule association, and only flows from the moment you add it, with a few minutes of ingestion delay.');
  out('  · Virtual machines have metrics and the activity log but no resource logs, so a diagnostic setting on one has nothing to route.');
  out('  · An alert rule is a condition plus action groups. The evaluation frequency cannot exceed the window size.');
  out('  · An alert processing rule changes what happens to fired alerts (RemoveAllActionGroups silences them), can be scoped and');
  out('    scheduled for maintenance, and needs no edit to the rule, which may belong to another team.');
  out('  · VMs are backed up with a Recovery Services vault in the VM\'s own region. A Backup vault covers disks, blobs and databases.');
  out('  · A backup has to exist before the disaster. restore-disks recovers the disks and the VM is rebuilt from them.');
  out('Type "restart" to play again.');
}

// ---- commands ----

function metricsList(g: Game, out: Out, cmd: string) {
  const vm = vmName(flagValue(cmd, '--resource'));
  const metric = quotedFlag(cmd, '--metric') ?? 'Percentage CPU';
  if (!vm) return out(`ERR --resource must be one of: ${VMS.join(', ')}`, 'error');
  if (vm === 'batch-vm' && g.vm !== 'running') return out(`(ResourceNotFound) The Resource 'Microsoft.Compute/virtualMachines/batch-vm' under resource group '${RG}' was not found.`, 'error');
  if (!VM_METRICS.includes(metric)) return out(`(BadRequest) Metric '${metric}' was not found for Microsoft.Compute/virtualMachines. Available: ${VM_METRICS.join(', ')}.`, 'error');
  out(`${vm} · ${metric} · average, 1 minute grain`, 'heading');
  out(`${'Time'.padEnd(8)}Average`, 'heading');
  for (let m = g.clock - 6; m < g.clock; m++) {
    let v: number;
    if (metric !== 'Percentage CPU') v = 1000 + ((m * 37) % 400);
    else if (vm === 'batch-vm') v = m >= 2 * 60 + 9 ? 97 - (m % 3) : 8;
    else if (vm === 'web-vm') v = 13 + (m % 4);
    else v = 9 + (m % 2);
    out(`${hhmm(m).padEnd(8)}${v}`, metric === 'Percentage CPU' && v > 80 ? 'alert' : 'output');
  }
}

function logQuery(g: Game, out: Out, cmd: string) {
  const ws = flagValue(cmd, '--workspace', '-w');
  let q = quotedFlag(cmd, '--analytics-query');
  if (isFileRef(q)) {
    const fail: string[] = [];
    const file = readScratchText(g, (t) => fail.push(t), q);
    if (!file) return out(fail[0], 'error');
    q = file.text;
    if (!q.split('\n').some((l) => l.trim() && !l.trim().startsWith('//'))) return out(`ERR '${file.name}' has no query in it (lines starting with // are comments).`, 'error');
  }
  if (q) q = q.split('\n').filter((l) => !l.trim().startsWith('//')).join(' ').replace(/\s+/g, ' ').trim();
  if (ws !== 'law-ops') return out(ws ? `(WorkspaceNotFound) The workspace '${ws}' was not found.` : 'ERR --workspace/-w law-ops is required', 'error');
  if (!q) return out('ERR --analytics-query "<kql>" is required', 'error');
  const res = runKql(g, q);
  if ('error' in res) return out(res.error, 'error');
  if (!res.rows.length) {
    out('[]');
    if (g.dcrAssociatedAt !== null && g.clock - g.dcrAssociatedAt < 5) out('# the data collection rule was applied recently; logs take about 5 minutes to land', 'heading');
    return;
  }
  const shown = res.rows.slice(0, 20);
  if (flagValue(cmd, '--output', '-o')?.toLowerCase() === 'json') {
    out(JSON.stringify(shown, null, 2));
    if (res.rows.some((r) => Object.values(r).some((v) => String(v).includes('user intern')))) g.foundCulprit = true;
    return;
  }
  const width = (c: string) => Math.min(60, Math.max(c.length, ...shown.map((r) => String(r[c]).length))) + 2;
  out(res.cols.map((c) => c.padEnd(width(c))).join(''), 'heading');
  shown.forEach((r) => out(res.cols.map((c) => String(r[c]).slice(0, 58).padEnd(width(c))).join('')));
  if (res.rows.length > shown.length) out(`... ${res.rows.length - shown.length} more rows`);
  if (res.rows.some((r) => Object.values(r).some((v) => String(v).includes('user intern')))) g.foundCulprit = true;
}

function monitorCmd(g: Game, out: Out, cmd: string) {
  const sub = words(cmd).slice(2, 4).join(' ');
  if (cmd.startsWith('az monitor metrics list')) return metricsList(g, out, cmd);
  if (cmd.startsWith('az monitor log-analytics query')) return logQuery(g, out, cmd);

  if (sub === 'data-collection rule' || cmd.startsWith('az monitor data-collection rule association create')) {
    const vm = vmName(flagValue(cmd, '--resource'));
    const rule = flagValue(cmd, '--rule-id');
    const name = flagValue(cmd, '--name', '-n');
    if (!vm || !name || rule !== 'dcr-ops') return out('ERR Usage: az monitor data-collection rule association create --name <n> --resource <vm> --rule-id dcr-ops -g ops-rg', 'error');
    if (vm === 'batch-vm') {
      if (g.vm !== 'running') return out(`(ResourceNotFound) batch-vm no longer exists.`, 'error');
      g.dcrAssociatedAt = g.clock;
    }
    return out(JSON.stringify({ name, dataCollectionRuleId: `${rgScope}/providers/Microsoft.Insights/dataCollectionRules/dcr-ops`, provisioningState: 'Succeeded' }, null, 2), 'success');
  }

  if (cmd.startsWith('az monitor diagnostic-settings create')) {
    const vm = vmName(flagValue(cmd, '--resource'));
    if (vm) return out(`(BadRequest) Resource type 'Microsoft.Compute/virtualMachines' has no log categories to export; only metrics. Guest logs come from the agent and a data collection rule.`, 'error');
    return out('ERR --resource must be a VM in this group; none of the resources here produce resource logs', 'error');
  }

  if (cmd.startsWith('az monitor action-group create')) {
    const parts = words(cmd);
    const i = parts.indexOf('--action');
    const name = flagValue(cmd, '--name', '-n');
    const err = rgError(cmd);
    if (err) return out(err, 'error');
    if (!name || i < 0 || parts[i + 1] !== 'email' || !parts[i + 2] || !/^[^@\s]+@[^@\s]+\.\w+$/.test(parts[i + 3] ?? '')) {
      return out('ERR Usage: az monitor action-group create -n <name> -g ops-rg --action email <receiver-name> <address>', 'error');
    }
    g.actionGroups = [...g.actionGroups.filter((a) => a.name !== name), { name, email: parts[i + 3] }];
    return out(JSON.stringify({ name, emailReceivers: [{ name: parts[i + 2], emailAddress: parts[i + 3] }], enabled: true }, null, 2), 'success');
  }

  if (cmd.startsWith('az monitor metrics alert')) {
    const op = words(cmd)[4];
    const err = rgError(cmd);
    if (err) return out(err, 'error');
    if (op === 'list') {
      out(`${'Name'.padEnd(12)}${'Scope'.padEnd(12)}${'Condition'.padEnd(34)}${'Window'.padEnd(8)}${'Every'.padEnd(7)}Actions`, 'heading');
      g.alerts.forEach((a) => out(`${a.name.padEnd(12)}${a.scope.padEnd(12)}${`${a.agg} ${a.metric} ${a.op} ${a.threshold}`.padEnd(34)}${a.window.padEnd(8)}${a.freq.padEnd(7)}${a.actions.join(',')}${a.managed ? '   (managed by platform-team)' : ''}`));
      return;
    }
    const name = flagValue(cmd, '--name', '-n');
    if (op === 'delete') {
      const a = g.alerts.find((x) => x.name === name);
      if (!a) return out(`(ResourceNotFound) Alert rule '${name ?? ''}' was not found.`, 'error');
      if (a.managed) return out(`(Forbidden) The rule '${a.name}' is managed by platform-team. You can change what happens to its alerts, but not the rule itself.`, 'error');
      g.alerts = g.alerts.filter((x) => x !== a);
      return out(`OK  Rule '${a.name}' deleted.`, 'success');
    }
    if (op === 'create') {
      const scope = vmName(flagValue(cmd, '--scopes'));
      const cond = quotedFlag(cmd, '--condition')?.match(/^(avg|min|max|total|count)\s+(.+?)\s+(>|<|>=|<=|==)\s+(\d+(?:\.\d+)?)$/);
      const window = flagValue(cmd, '--window-size') ?? '5m';
      const freq = flagValue(cmd, '--evaluation-frequency') ?? '1m';
      const actions = (() => {
        const parts = words(cmd);
        const i = parts.indexOf('--action');
        const vals: string[] = [];
        for (let k = i + 1; i >= 0 && k < parts.length && !parts[k].startsWith('--'); k++) vals.push(parts[k]);
        return vals;
      })();
      if (!name || !scope || !cond) return out('ERR Usage: az monitor metrics alert create -n <n> -g ops-rg --scopes <vm> --condition "avg Percentage CPU > 85" [--window-size 5m] [--evaluation-frequency 1m] --action <group>', 'error');
      if (!VM_METRICS.includes(cond[2])) return out(`(BadRequest) Metric '${cond[2]}' was not found for Microsoft.Compute/virtualMachines. Available: ${VM_METRICS.join(', ')}.`, 'error');
      if (!WINDOWS.includes(window)) return out(`(BadRequest) Window size '${window}' is not supported. Use one of: ${WINDOWS.join(', ')}.`, 'error');
      if (!FREQS.includes(freq)) return out(`(BadRequest) Evaluation frequency '${freq}' is not supported. Use one of: ${FREQS.join(', ')}.`, 'error');
      if (mins(freq) > mins(window)) return out(`(BadRequest) The evaluation frequency (${freq}) cannot be greater than the window size (${window}).`, 'error');
      const missing = actions.find((a) => !g.actionGroups.some((x) => x.name === a));
      if (missing) return out(`(ActionGroupNotFound) The action group '${missing}' does not exist. Create it with az monitor action-group create.`, 'error');
      const rule: AlertRule = { name, scope, metric: cond[2], agg: cond[1], op: cond[3], threshold: Number(cond[4]), window, freq, actions, managed: false };
      g.alerts = [...g.alerts.filter((a) => a.name !== name || a.managed), rule];
      return out(JSON.stringify({ name, enabled: true, severity: 3, evaluationFrequency: freq, windowSize: window, scopes: [scope], criteria: { metricName: rule.metric, operator: rule.op, threshold: rule.threshold, timeAggregation: rule.agg }, actions }, null, 2), 'success');
    }
    return out('ERR Usage: az monitor metrics alert <list|create|delete> ...', 'error');
  }

  if (cmd.startsWith('az monitor alert-processing-rule create')) {
    const err = rgError(cmd);
    if (err) return out(err, 'error');
    const name = flagValue(cmd, '--name', '-n');
    const type = ['RemoveAllActionGroups', 'AddActionGroups'].find((t) => t.toLowerCase() === flagValue(cmd, '--rule-type')?.toLowerCase());
    const scope = flagValue(cmd, '--scopes');
    if (!name || !type || !scope) return out('ERR Usage: az monitor alert-processing-rule create -n <n> -g ops-rg --rule-type <RemoveAllActionGroups|AddActionGroups> --scopes <scope>', 'error');
    if (!(coversBatchVm(scope) || scope.includes('/virtualMachines/'))) return out(`(BadRequest) The scope '${scope}' is not a resource, resource group or subscription in this tenant.`, 'error');
    if (type === 'AddActionGroups') {
      const ag = flagValue(cmd, '--action-groups');
      if (!ag || !g.actionGroups.some((x) => x.name === ag)) return out('ERR AddActionGroups needs --action-groups <existing group>', 'error');
    }
    g.procRules = [...g.procRules.filter((r) => r.name !== name), { name, type: type as ProcRule['type'], scope }];
    return out(JSON.stringify({ name, properties: { scopes: [scope], enabled: true, actions: [{ actionType: type }] } }, null, 2), 'success');
  }

  out('ERR Unknown az monitor command. Type "help" for usage.', 'error');
}

// ---- az rest: raw ARM calls with a JSON body from ~/scratch ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const REST_USAGE = 'ERR Usage: az rest --method <get|put|delete> --url <ARM path> [--body @file.json]';
const REST_KINDS = `${armId('Microsoft.Insights/actionGroups/<n>')}, ${armId('Microsoft.Insights/metricAlerts/<n>')}, ${armId('Microsoft.AlertsManagement/actionRules/<n>')}`;
const badBody = (msg: string) => `(InvalidRequestContent) The request content was invalid and could not be deserialized: ${msg}`;

const ISO: Record<string, string> = { PT1M: '1m', PT5M: '5m', PT15M: '15m', PT30M: '30m', PT1H: '1h', PT2H: '2h', PT6H: '6h', PT12H: '12h', P1D: '1d' };
const toIso = (s: string) => Object.entries(ISO).find(([, v]) => v === s)?.[0] ?? s;
const OPS: Record<string, string> = { GreaterThan: '>', GreaterThanOrEqual: '>=', LessThan: '<', LessThanOrEqual: '<=', Equals: '==' };
const AGGS: Record<string, string> = { Average: 'avg', Minimum: 'min', Maximum: 'max', Total: 'total', Count: 'count' };
const nameOf = (id: string) => id.split('/').pop() ?? '';

const alertBody = (a: AlertRule): Obj => ({
  id: armId(`Microsoft.Insights/metricAlerts/${a.name}`),
  name: a.name,
  type: 'Microsoft.Insights/metricAlerts',
  location: 'global',
  properties: {
    severity: 3,
    enabled: true,
    scopes: [armId(`Microsoft.Compute/virtualMachines/${a.scope}`)],
    evaluationFrequency: toIso(a.freq),
    windowSize: toIso(a.window),
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria',
      allOf: [
        {
          name: 'cpu',
          criterionType: 'StaticThresholdCriterion',
          metricName: a.metric,
          operator: Object.entries(OPS).find(([, v]) => v === a.op)?.[0] ?? a.op,
          threshold: a.threshold,
          timeAggregation: Object.entries(AGGS).find(([, v]) => v === a.agg)?.[0] ?? a.agg,
        },
      ],
    },
    actions: a.actions.map((n) => ({ actionGroupId: armId(`Microsoft.Insights/actionGroups/${n}`) })),
  },
});

const groupBody = (a: { name: string; email: string }): Obj => ({
  id: armId(`Microsoft.Insights/actionGroups/${a.name}`),
  name: a.name,
  type: 'Microsoft.Insights/actionGroups',
  location: 'Global',
  properties: { groupShortName: a.name.slice(0, 12), enabled: true, emailReceivers: [{ name: 'receiver', emailAddress: a.email, status: 'Enabled' }] },
});

const ruleBody = (r: ProcRule): Obj => ({
  id: armId(`Microsoft.AlertsManagement/actionRules/${r.name}`),
  name: r.name,
  type: 'Microsoft.AlertsManagement/actionRules',
  location: 'Global',
  properties: { scopes: [r.scope], enabled: true, actions: [{ actionType: r.type }] },
});

type PutResult = { error: string } | { result: Obj; created: boolean };

function putGroup(g: Game, name: string, body: Obj): PutResult {
  const p = body.properties;
  if (!isObj(p)) return { error: badBody('the body needs a "properties" object.') };
  const receivers = p.emailReceivers;
  if (!Array.isArray(receivers) || !receivers.length) return { error: badBody("'properties.emailReceivers' needs at least one receiver.") };
  const first = receivers[0] as Obj;
  const email = String(first?.emailAddress ?? '');
  if (!first?.name) return { error: badBody("each email receiver needs a 'name'.") };
  if (!/^[^@\s]+@[^@\s]+\.\w+$/.test(email)) return { error: `(InvalidEmailAddress) The email address '${email}' is not valid.` };
  const created = !g.actionGroups.some((a) => a.name === name);
  g.actionGroups = [...g.actionGroups.filter((a) => a.name !== name), { name, email }];
  return { result: groupBody({ name, email }), created };
}

function putAlert(g: Game, name: string, body: Obj): PutResult {
  if (g.alerts.some((a) => a.name === name && a.managed)) return { error: `(Forbidden) The rule '${name}' is managed by platform-team. You can change what happens to its alerts, but not the rule itself.` };
  const p = body.properties;
  if (!isObj(p)) return { error: badBody('the body needs a "properties" object.') };
  const scopes = Array.isArray(p.scopes) ? (p.scopes as unknown[]).map(String) : [];
  const vm = vmName(scopes[0] ?? null);
  if (!vm) return { error: badBody(`'properties.scopes' needs the resource ID of a VM (one of ${VMS.join(', ')}).`) };
  const all = isObj(p.criteria) && Array.isArray(p.criteria.allOf) ? (p.criteria.allOf as Obj[]) : [];
  const c = all[0];
  if (!c) return { error: badBody("'properties.criteria.allOf' needs one criterion.") };
  const metric = String(c.metricName ?? '');
  if (!VM_METRICS.includes(metric)) return { error: `(BadRequest) Metric '${metric}' was not found for Microsoft.Compute/virtualMachines. Available: ${VM_METRICS.join(', ')}.` };
  const op = OPS[String(c.operator)];
  const agg = AGGS[String(c.timeAggregation)];
  if (!op) return { error: badBody(`'operator' must be one of ${Object.keys(OPS).join(', ')}.`) };
  if (!agg) return { error: badBody(`'timeAggregation' must be one of ${Object.keys(AGGS).join(', ')}.`) };
  if (typeof c.threshold !== 'number') return { error: badBody("'threshold' must be a number.") };
  const window = ISO[String(p.windowSize)];
  const freq = ISO[String(p.evaluationFrequency)];
  if (!window || !WINDOWS.includes(window)) return { error: `(BadRequest) Window size '${String(p.windowSize)}' is not supported. Use an ISO 8601 duration such as PT5M.` };
  if (!freq || !FREQS.includes(freq)) return { error: `(BadRequest) Evaluation frequency '${String(p.evaluationFrequency)}' is not supported. Use PT1M, PT5M, PT15M, PT30M or PT1H.` };
  if (mins(freq) > mins(window)) return { error: `(BadRequest) The evaluation frequency (${freq}) cannot be greater than the window size (${window}).` };
  const actions = (Array.isArray(p.actions) ? (p.actions as Obj[]) : []).map((a) => nameOf(String(a.actionGroupId ?? ''))).filter(Boolean);
  const missing = actions.find((a) => !g.actionGroups.some((x) => x.name === a));
  if (missing) return { error: `(ActionGroupNotFound) The action group '${missing}' does not exist. Create it first (az rest put on Microsoft.Insights/actionGroups/${missing}).` };
  const rule: AlertRule = { name, scope: vm, metric, agg, op, threshold: c.threshold, window, freq, actions, managed: false };
  const created = !g.alerts.some((a) => a.name === name);
  g.alerts = [...g.alerts.filter((a) => a.name !== name), rule];
  return { result: alertBody(rule), created };
}

function putProcRule(g: Game, name: string, body: Obj): PutResult {
  const p = body.properties;
  if (!isObj(p)) return { error: badBody('the body needs a "properties" object.') };
  const scopes = Array.isArray(p.scopes) ? (p.scopes as unknown[]).map(String) : [];
  if (!scopes.length) return { error: badBody("'properties.scopes' needs at least one scope: a subscription, resource group or resource ID.") };
  const bad = scopes.find((sc) => !(coversBatchVm(sc) || sc.includes('/virtualMachines/')));
  if (bad) return { error: `(BadRequest) The scope '${bad}' is not a resource, resource group or subscription in this tenant.` };
  const action = Array.isArray(p.actions) ? (p.actions[0] as Obj | undefined) : undefined;
  const type = ['RemoveAllActionGroups', 'AddActionGroups'].find((t) => t === action?.actionType);
  if (!type) return { error: badBody("'properties.actions[0].actionType' must be RemoveAllActionGroups or AddActionGroups.") };
  if (type === 'AddActionGroups') {
    const ids = Array.isArray(action?.actionGroupIds) ? (action!.actionGroupIds as unknown[]).map((x) => nameOf(String(x))) : [];
    if (!ids.length || ids.some((n) => !g.actionGroups.some((x) => x.name === n))) return { error: badBody("AddActionGroups needs 'actionGroupIds' that point at existing action groups.") };
  }
  const created = !g.procRules.some((r) => r.name === name);
  g.procRules = [...g.procRules.filter((r) => r.name !== name && !r.name.startsWith(`${name}#`)), ...scopes.map((scope, i) => ({ name: i ? `${name}#${i + 1}` : name, type: type as ProcRule['type'], scope }))];
  return { result: { ...ruleBody(g.procRules.find((r) => r.name === name)!), properties: { scopes, enabled: true, actions: [{ actionType: type }] } }, created };
}

function restCmd(g: Game, out: Out, cmd: string) {
  const method = (flagValue(cmd, '--method', '-m') ?? 'get').toLowerCase();
  const rawUrl = flagValue(cmd, '--url', '--uri', '-u');
  if (!rawUrl || !['get', 'put', 'delete'].includes(method)) return out(REST_USAGE, 'error');
  const path = rawUrl.replace(/^https:\/\/management\.azure\.com/i, '').split('?')[0].replace(/\/$/, '');
  const m = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/(Microsoft\.[A-Za-z]+)\/([A-Za-z]+)(?:\/([^/]+))?$/i.exec(path);
  if (!m) return out(`(InvalidRequest) '${rawUrl}' is not an ARM resource path. Start with ${rgScope}/providers/...`, 'error');
  if (m[1].toLowerCase() !== SUB_ID) return out(`(SubscriptionNotFound) The subscription '${m[1]}' could not be found.`, 'error');
  if (m[2].toLowerCase() !== RG) return out(`(ResourceGroupNotFound) Resource group '${m[2]}' could not be found.`, 'error');
  const key = `${m[3]}/${m[4]}`.toLowerCase();
  const name = m[5];
  const notFound = `(ResourceNotFound) The Resource '${m[3]}/${m[4]}/${name ?? ''}' under resource group '${RG}' was not found.`;

  let read: (() => Obj | null) | null = null;
  let list: () => Obj;
  let put: ((b: Obj) => PutResult) | null = null;
  let del: (() => string | null) | null = null; // null = deleted, string = refusal
  if (key === 'microsoft.insights/metricalerts') {
    list = () => ({ value: g.alerts.map(alertBody) });
    if (name) {
      read = () => { const a = g.alerts.find((x) => x.name === name); return a ? alertBody(a) : null; };
      put = (b) => putAlert(g, name, b);
      del = () => {
        const a = g.alerts.find((x) => x.name === name);
        if (a?.managed) return `(Forbidden) The rule '${a.name}' is managed by platform-team. You can change what happens to its alerts, but not the rule itself.`;
        if (a) g.alerts = g.alerts.filter((x) => x !== a);
        return null;
      };
    }
  } else if (key === 'microsoft.insights/actiongroups') {
    list = () => ({ value: g.actionGroups.map(groupBody) });
    if (name) {
      read = () => { const a = g.actionGroups.find((x) => x.name === name); return a ? groupBody(a) : null; };
      put = (b) => putGroup(g, name, b);
    }
  } else if (key === 'microsoft.alertsmanagement/actionrules') {
    list = () => ({ value: g.procRules.map(ruleBody) });
    if (name) {
      read = () => { const r = g.procRules.find((x) => x.name === name); return r ? ruleBody(r) : null; };
      put = (b) => putProcRule(g, name, b);
      del = () => { g.procRules = g.procRules.filter((r) => r.name !== name && !r.name.startsWith(`${name}#`)); return null; };
    }
  } else return out(`(InvalidResourceType) az rest supports only: ${REST_KINDS}`, 'error');

  if (method === 'get') {
    if (!name) return out(JSON.stringify(list(), null, 2), 'success');
    const found = read!();
    return found ? out(JSON.stringify(found, null, 2), 'success') : out(notFound, 'error');
  }
  if (!name) return out(`ERR az rest ${method} needs the name of one resource at the end of the URL.`, 'error');
  if (method === 'delete') {
    if (!del) return out(`(MethodNotAllowed) Delete is not supported for ${m[4]} in this drill.`, 'error');
    const refusal = del();
    return refusal ? out(refusal, 'error') : out(`OK  200 deleted '${name}'.`, 'success');
  }
  const bodyRef = flagValue(cmd, '--body', '-b');
  if (!bodyRef) return out('ERR az rest put needs --body @file.json (a JSON file from ~/scratch)', 'error');
  if (!isFileRef(bodyRef)) return out('ERR --body expects @file.json, e.g. --body @alert.json. Edit the file in the panel under the terminal.', 'error');
  const parsed = readScratchJson(g, out, bodyRef);
  if (!parsed) return;
  if (!isObj(parsed.value)) return out(badBody(`'${parsed.name}' must hold one JSON object.`), 'error');
  const res = put!(parsed.value);
  if ('error' in res) return out(res.error, 'error');
  out(JSON.stringify(res.result, null, 2), 'success');
  out(`# ${res.created ? '201 Created' : '200 OK, the resource was replaced with exactly what the body says'}`, 'heading');
}

const vaultOf = (g: Game, cmd: string): Vault | string => {
  const err = rgError(cmd);
  if (err) return err;
  const name = flagValue(cmd, '--vault-name', '--name', '-n');
  const v = g.vaults.find((x) => x.name === name);
  return v ?? `(ResourceNotFound) The Recovery Services vault '${name ?? ''}' was not found in ${RG}.`;
};

function backupCmd(g: Game, out: Out, cmd: string) {
  const parts = words(cmd);
  const area = parts[2];
  const op = parts[3];

  if (area === 'vault' && op === 'create') {
    const err = rgError(cmd);
    if (err) return out(err, 'error');
    const name = flagValue(cmd, '--name', '-n');
    const loc = flagValue(cmd, '--location', '-l');
    if (!name || !loc) return out('ERR Usage: az backup vault create -n <name> -g ops-rg --location <region>', 'error');
    if (g.vaults.some((v) => v.name === name)) return out(`(Conflict) A vault named '${name}' already exists.`, 'error');
    if (!['eastus', 'westus', 'westeurope'].includes(loc)) return out(`(LocationNotAvailableForResourceType) '${loc}' is not available for vaults here. Try eastus, westus or westeurope.`, 'error');
    g.vaults.push({ name, kind: 'rsv', location: loc });
    out(JSON.stringify({ name, location: loc, type: 'Microsoft.RecoveryServices/vaults', properties: { provisioningState: 'Succeeded' } }, null, 2), 'success');
    return;
  }

  const v = vaultOf(g, cmd);
  if (typeof v === 'string') return out(v, 'error');

  if (area === 'policy' && op === 'list') {
    if (v.kind !== 'rsv') return out(`(BadRequest) '${v.name}' is a Backup vault; VM backup policies live in Recovery Services vaults.`, 'error');
    out(`${'Name'.padEnd(18)}${'Workload'.padEnd(10)}Schedule`, 'heading');
    out(`${'DefaultPolicy'.padEnd(18)}${'VM'.padEnd(10)}daily 03:30, 30 days`);
    out(`${'EnhancedPolicy'.padEnd(18)}${'VM'.padEnd(10)}hourly, 30 days`);
    return;
  }

  if (area === 'protection' && op === 'enable-for-vm') {
    const vm = flagValue(cmd, '--vm');
    const policy = flagValue(cmd, '--policy-name');
    if (vm !== 'batch-vm' || !policy) return out('ERR Usage: az backup protection enable-for-vm --vault-name <v> -g ops-rg --vm batch-vm --policy-name <policy>', 'error');
    if (v.kind !== 'rsv') return out(`(UserErrorVaultTypeNotSupported) '${v.name}' is a Backup vault. Virtual machines are protected with a Recovery Services vault.`, 'error');
    if (v.location !== LOCATION) return out(`(UserErrorVmAndVaultInDifferentRegions) The vault '${v.name}' is in ${v.location} but batch-vm is in ${LOCATION}. The vault must be in the same region as the VM.`, 'error');
    if (!['DefaultPolicy', 'EnhancedPolicy'].includes(policy)) return out(`(BMSUserErrorInvalidPolicy) Policy '${policy}' was not found in '${v.name}'.`, 'error');
    if (g.vm !== 'running') return out('(ResourceNotFound) batch-vm no longer exists.', 'error');
    g.protectedBy = v.name;
    return out(JSON.stringify({ name: 'batch-vm', properties: { protectionState: 'IRPending', policyName: policy, vaultName: v.name } }, null, 2), 'success');
  }

  if (area === 'protection' && op === 'backup-now') {
    if (g.protectedBy !== v.name) return out(`(BMSUserErrorContainerNotFound) batch-vm is not protected by '${v.name}'. Enable protection first.`, 'error');
    if (g.vm !== 'running') return out('(ResourceNotFound) batch-vm no longer exists.', 'error');
    const id = `job-${hhmm(g.clock).replace(':', '')}`;
    g.jobs.push({ id, doneAt: g.clock + 10, done: false });
    return out(JSON.stringify({ name: id, properties: { operation: 'Backup', status: 'InProgress', entityFriendlyName: 'batch-vm' } }, null, 2) + '\n# the backup takes about 10 minutes', 'success');
  }

  if (area === 'job' && op === 'list') {
    if (!g.jobs.length) return out('[]');
    out(`${'Name'.padEnd(14)}${'Operation'.padEnd(11)}${'Item'.padEnd(11)}Status`, 'heading');
    g.jobs.forEach((j) => out(`${j.id.padEnd(14)}${'Backup'.padEnd(11)}${'batch-vm'.padEnd(11)}${j.done ? 'Completed' : `InProgress (done at ${hhmm(j.doneAt)})`}`));
    return;
  }

  if (area === 'recoverypoint' && op === 'list') {
    if (!g.recoveryPoints.length) return out('[]');
    out(`${'Name'.padEnd(12)}${'Time'.padEnd(8)}Consistency`, 'heading');
    g.recoveryPoints.forEach((r) => out(`${r.name.padEnd(12)}${hhmm(r.at).padEnd(8)}CrashConsistent`));
    return;
  }

  if (area === 'restore' && op === 'restore-disks') {
    const rp = flagValue(cmd, '--rp-name');
    if (!rp || flagValue(cmd, '--storage-account') !== 'opsrestore' || flagValue(cmd, '--item-name') !== 'batch-vm') {
      return out('ERR Usage: az backup restore restore-disks --vault-name <v> -g ops-rg --container-name batch-vm --item-name batch-vm --rp-name <rp> --storage-account opsrestore --target-resource-group ops-rg', 'error');
    }
    if (!g.recoveryPoints.some((r) => r.name === rp)) return out(`(BMSUserErrorRecoveryPointNotFound) Recovery point '${rp}' was not found.`, 'error');
    if (g.vm === 'running') return out('# batch-vm is still running. A restore recovers a lost VM; there is nothing to restore yet.', 'heading');
    g.vm = 'restored';
    out(JSON.stringify({ name: `restore-${rp}`, properties: { operation: 'Restore', status: 'Completed' } }, null, 2), 'success');
    out('OK  disks restored to opsrestore and batch-vm rebuilt from them.', 'success');
    return;
  }
  out('ERR Unknown az backup command. Type "help" for usage.', 'error');
}

function resourceList(g: Game, out: Out) {
  out(`${'Name'.padEnd(14)}Type`, 'heading');
  VMS.filter((v) => v !== 'batch-vm' || g.vm !== 'deleted').forEach((v) => out(`${v.padEnd(14)}Microsoft.Compute/virtualMachines`));
  out(`${'law-ops'.padEnd(14)}Microsoft.OperationalInsights/workspaces`);
  out(`${'dcr-ops'.padEnd(14)}Microsoft.Insights/dataCollectionRules`);
  g.vaults.forEach((v) => out(`${v.name.padEnd(14)}${v.kind === 'rsv' ? 'Microsoft.RecoveryServices/vaults' : 'Microsoft.DataProtection/BackupVaults'}  (${v.location})`));
  g.actionGroups.forEach((a) => out(`${a.name.padEnd(14)}Microsoft.Insights/actionGroups`));
}

/** What the shell layer needs from this lab. */
export const HOST: Host<Game> = { execute, prompt: () => PROMPT, cfg: SCRATCH, cmdlets: CMDLETS };

/** Runs whatever was typed (one line or several, bash or PowerShell) and returns the new game. */
export const runCommand = (prev: Game, text: string): Game => runShell(prev, text, HOST);

/** The prompt of the shell that is open: user@host:~$ in bash, PS /home/user> in PowerShell. */
export const livePrompt = (g: Game): string => promptFor(HOST.prompt(g), g.sh.mode);

function execute(prev: Game, cmd: string, _echo: string | null): Game {
  if (cmd === 'clear') return { ...prev, history: [] };
  if (cmd === 'restart') return initialGame();

  const g = draft(prev);
  const out = writer(g);
  // the shell layer prints the typed line; nothing to echo here
  let cost = 0;

  if (cmd === 'help') {
    out('# commands', 'heading');
    HELP_COMMANDS.forEach(([c, d]) => out(`  ${c}\n      ${d}`));
  } else if (scratchCommand(g, out, cmd, SCRATCH)) {
    // ls, cat, edit, touch, rm: handled by the scratch module
  } else if (cmd === 'hint') {
    out(`HINT ${nextHint(g)}`, 'alert');
  } else if (cmd === 'submit') {
    debrief(g, out);
  } else if (cmd === 'wait') {
    if (g.clock >= DELETE_AT) out('Nothing else is scheduled tonight.');
    else {
      out(`Skipping ahead to ${hhmm(DELETE_AT)} ...`, 'alert');
      cost = DELETE_AT - g.clock;
    }
  } else if (cmd.startsWith('az')) {
    cost = cmd.startsWith('az backup vault create') ? 2 : 1;
    if (cmd.startsWith('az resource list')) resourceList(g, out);
    else if (cmd.startsWith('az rest')) restCmd(g, out, cmd);
    else if (cmd.startsWith('az monitor')) monitorCmd(g, out, cmd);
    else if (cmd.startsWith('az backup')) backupCmd(g, out, cmd);
    else out('ERR Unknown command. Type "help" for usage.', 'error');
  } else {
    out(`bash: ${cmd.split(' ')[0]}: command not recognized. Type "help" for usage.`, 'error');
  }
  if (cost) advance(g, out, cost);
  return g;
}
