// Game engine for Slot Swap: a simulated slice of ARM deployments, App Service and the Azure CLI. No React in here.

import { fileName, isFileRef, readScratchJson, scratchCommand, type ScratchConfig, type ScratchOut } from './scratch';
import { newShell, promptFor, runShell, type Host, type ShellEnv } from './shell';
import { splitWords } from './shellcore';
import { CMDLETS } from './cmdlets';

export type LineType = 'input' | 'output' | 'error' | 'success' | 'heading' | 'alert';

export interface Line {
  text: string;
  type: LineType;
}

export interface Slot {
  version: string;
  settings: Record<string, string>;
}

export interface Game {
  files: Record<string, string>; // ~/scratch: main.bicep, params.json, appsettings.json and whatever the player adds
  focus: string | null; // file the editor panel shows
  sh: ShellEnv; // which shell is open (bash or PowerShell) and its variables
  plan: { sku: string; workers: number };
  prod: Slot;
  staging: Slot | null;
  sticky: string[]; // names of slot settings ("deployment slot setting"): they stay with their slot on a swap
  swapped: boolean; // production got its release through a swap
  logs: boolean; // launchlogs storage account
  vm: { size: string } | null; // batch-vm
  lost: string[];
  solved: boolean;
  history: Line[];
}

type Out = (text: string, type?: LineType) => void;

export const RG = 'launch-rg';
export const WEB = 'shop-web';
export const PLAN = 'shop-plan';
export const VM = 'batch-vm';
export const LOCATION = 'eastus';
export const VM_ZONE = 2;
export const TARGET_WORKERS = 3;
export const MIN_VCPU = 4;
export const MIN_MEM = 16;

export const SKUS: Record<string, { tier: string; slots: boolean; max: number }> = {
  F1: { tier: 'Free', slots: false, max: 1 },
  B1: { tier: 'Basic', slots: false, max: 3 },
  S1: { tier: 'Standard', slots: true, max: 10 },
  P1v3: { tier: 'PremiumV3', slots: true, max: 30 },
};

const VM_SIZES: Record<string, { vcpu: number; mem: number; zones: number[] }> = {
  Standard_D2s_v5: { vcpu: 2, mem: 8, zones: [1, 2, 3] },
  Standard_D4s_v5: { vcpu: 4, mem: 16, zones: [1, 2, 3] },
  Standard_E4s_v5: { vcpu: 4, mem: 32, zones: [1, 3] },
  Standard_D8s_v5: { vcpu: 8, mem: 32, zones: [1, 2, 3] },
  Standard_B4ms: { vcpu: 4, mem: 16, zones: [] },
};

export const vmSpec = (size: string) => VM_SIZES[size];

const TEMPLATE = [
  'param location string = resourceGroup().location',
  "param planSku string = 'F1'",
  'param instanceCount int = 1',
  '',
  "resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {",
  `  name: '${PLAN}'`,
  '  location: location',
  '  sku: { name: planSku, capacity: instanceCount }',
  '}',
  '',
  "resource site 'Microsoft.Web/sites@2023-12-01' = {",
  `  name: '${WEB}'`,
  '  location: location',
  '  properties: { serverFarmId: plan.id }',
  '}',
  '',
  "resource staging 'Microsoft.Web/sites/slots@2023-12-01' = {",
  '  parent: site',
  "  name: 'staging'",
  '  location: location',
  '  properties: {',
  '    serverFarmId: plan.id',
  "    siteConfig: { appSettings: [ { name: 'DB_URL', value: 'staging-db' } ] }",
  '  }',
  '}',
];

/** ~/scratch: the release packages are binary and read-only; everything else can be edited in the editor panel. */
export const SCRATCH: ScratchConfig = { readonly: [], binary: ['release-v1.zip', 'release-v2.zip'] };

const initialFiles = (): Record<string, string> => ({
  'main.bicep': TEMPLATE.join('\n') + '\n',
  'params.json':
    '{\n  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",\n  "contentVersion": "1.0.0.0",\n  "parameters": {\n    "planSku": { "value": "F1" },\n    "instanceCount": { "value": 1 }\n  }\n}\n',
  'appsettings.json': '[\n  {\n    "name": "DB_URL",\n    "value": "prod-db",\n    "slotSetting": false\n  }\n]\n',
});

/** The lines of main.bicep as they are right now (the player may have edited it in the panel). */
export const bicepLines = (g: Game): string[] => (g.files['main.bicep'] ?? '').split('\n');

// ---- audit ----

export interface Check {
  label: string;
  ok: boolean;
}

export function audit(g: Game): Check[] {
  const sku = SKUS[g.plan.sku];
  const vm = g.vm && VM_SIZES[g.vm.size];
  return [
    { label: 'Deployed on a slot-capable plan', ok: !!g.staging && sku.slots },
    { label: 'launchlogs and batch-vm intact', ok: g.lost.length === 0 },
    { label: 'v2 live through a slot swap', ok: g.prod.version === 'v2' && g.swapped },
    { label: 'Production still on prod-db', ok: g.prod.settings.DB_URL === 'prod-db' },
    { label: `Scaled out to ${TARGET_WORKERS}+ instances`, ok: g.plan.workers >= TARGET_WORKERS },
    { label: `batch-vm ${MIN_VCPU}+ vCPU, ${MIN_MEM}+ GiB, zone ${VM_ZONE}`, ok: !!vm && vm.vcpu >= MIN_VCPU && vm.mem >= MIN_MEM && vm.zones.includes(VM_ZONE) },
  ];
}

/** Parameters declared in main.bicep, read from the current text of the file. */
export function templateParams(file: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of file) {
    const m = line.match(/^param (\w+) (?:string|int) = '?([^'\s]*)'?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function nextHint(g: Game): string {
  const params = templateParams(bicepLines(g));
  const sku = SKUS[g.plan.sku];
  if (!g.staging || !sku.slots) {
    return SKUS[params.planSku]?.slots
      ? 'main.bicep now asks for a slot-capable plan. Preview with "az deployment group what-if", then deploy it. Mind the --mode.'
      : 'The staging slot needs a plan tier that supports slots. Read main.bicep and fix it with: sed -i \'s/old/new/\' main.bicep';
  }
  if (g.lost.length) return `You lost ${g.lost.join(' and ')} to a Complete-mode deployment. Type "restart" and run what-if before deploying.`;
  if (g.prod.version !== 'v2') {
    if (g.staging.version !== 'v2') return 'Put release-v2.zip on the staging slot (az webapp deploy --slot staging), then check it with curl.';
    const leak = Object.keys(g.staging.settings).find((k) => !g.sticky.includes(k) && g.staging!.settings[k] !== g.prod.settings[k]);
    if (leak) return `Staging and production differ on ${leak}, and a swap exchanges any setting that is not a slot setting. Look at "az webapp config appsettings set --slot-settings".`;
    return 'Staging looks safe to promote: az webapp deployment slot swap.';
  }
  if (g.prod.settings.DB_URL !== 'prod-db') return 'Production is pointing at the wrong database after the swap. Put DB_URL back (and make it a slot setting so it cannot move again).';
  if (g.plan.workers < TARGET_WORKERS) return 'Launch traffic means more instances, not a bigger plan: az appservice plan update --number-of-workers.';
  if (!audit(g)[5].ok) return `batch-vm needs ${MIN_VCPU}+ vCPU and ${MIN_MEM}+ GiB and has to stay in zone ${VM_ZONE}. "az vm list-skus" shows which sizes each zone offers.`;
  return 'Everything is in place. Type "submit".';
}

function debrief(g: Game, out: Out) {
  const checks = audit(g);
  out('# go-live review', 'heading');
  checks.forEach((c) => out(`  ${c.ok ? '[PASS]' : '[FAIL]'} ${c.label}`, c.ok ? 'success' : 'error'));
  if (!checks.every((c) => c.ok)) {
    out('  Not ready to go live. Fix the failing items and submit again.', 'alert');
    return;
  }
  g.solved = true;
  out('  GO. Release v2 is live and the estate is intact.', 'success');
  out('# what to take away', 'heading');
  out('  · Deployment slots need a Standard, Premium or Isolated plan. Free, Shared and Basic do not support them.');
  out('  · "what-if" previews a deployment. Incremental mode (the default) leaves resources the template does not mention alone;');
  out('    Complete mode deletes everything in the group that is not in the template.');
  out('  · A swap exchanges the slot content and every setting that is not a slot setting. Mark settings such as a');
  out('    database connection as slot settings (sticky) so they stay with the slot. A second swap rolls back.');
  out('  · Scale up changes the plan SKU; scale out changes the instance count, up to the tier limit. A template with a');
  out('    capacity parameter resets the count on every redeploy.');
  out('  · A zonal VM can only use sizes offered in its zone, and a resize restarts it. A non-zonal size such as B4ms fails.');
  out('Type "restart" to play again.');
}

// ---- state ----

const intro = (): Line[] => [
  { text: `Azure Cloud Shell (simulated) · subscription contoso-prod · resource group ${RG}`, type: 'output' },
  { text: `LAUNCH NIGHT: release v2 of ${WEB} goes live tonight. v1 is serving production and the staging slot does not exist yet.`, type: 'alert' },
  { text: `Deploy from main.bicep, test v2 in staging, swap it into production, handle the launch traffic and resize ${VM}.`, type: 'output' },
  { text: 'FILES: ~/scratch holds main.bicep, params.json and appsettings.json. Edit them live in the panel under the terminal; "ls" lists them.', type: 'output' },
  { text: 'Type "help" for commands, "hint" if you get stuck and "submit" when you are ready to go live.', type: 'output' },
];

export const initialGame = (): Game => ({
  files: initialFiles(),
  focus: null,
  sh: newShell(),
  plan: { sku: 'F1', workers: 1 },
  prod: { version: 'v1', settings: { DB_URL: 'prod-db' } },
  staging: null,
  sticky: [],
  swapped: false,
  logs: true,
  vm: { size: 'Standard_D2s_v5' },
  lost: [],
  solved: false,
  history: intro(),
});

const draft = (g: Game): Game => ({
  ...g,
  files: { ...g.files },
  plan: { ...g.plan },
  prod: { ...g.prod, settings: { ...g.prod.settings } },
  staging: g.staging && { ...g.staging, settings: { ...g.staging.settings } },
  sticky: [...g.sticky],
  vm: g.vm && { ...g.vm },
  lost: [...g.lost],
  history: [...g.history],
});

const writer =
  (g: Game): Out =>
  (text, type = 'output') =>
    g.history.push({ text, type });

export const PROMPT = 'release-eng@contoso-prod:~$';

// ---- command parsing ----

const words = (cmd: string) => splitWords(cmd);

const values = (cmd: string, ...names: string[]): string[] | null => {
  const parts = words(cmd);
  const idx = parts.findIndex((p) => names.includes(p));
  if (idx < 0) return null;
  const vals: string[] = [];
  for (let i = idx + 1; i < parts.length && !parts[i].startsWith('-'); i++) vals.push(parts[i]);
  return vals;
};

const flagValue = (cmd: string, ...names: string[]): string | null => values(cmd, ...names)?.[0] ?? null;

function parsePairs(vals: string[] | null): Record<string, string> | null {
  if (!vals?.length) return null;
  const out: Record<string, string> = {};
  for (const v of vals) {
    const eq = v.indexOf('=');
    if (eq <= 0) return null;
    out[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return out;
}

const notFound = (what: string) => `(ResourceNotFound) The Resource '${what}' under resource group '${RG}' was not found.`;

/** Checks -n/-g against the one app or plan in this group. Returns an error line or null. */
function target(cmd: string, name: string): string | null {
  const n = flagValue(cmd, '--name', '-n');
  const rg = flagValue(cmd, '--resource-group', '-g');
  if (rg !== RG) return rg ? `(ResourceGroupNotFound) Resource group '${rg}' could not be found.` : `ERR --resource-group is required (-g ${RG})`;
  if (n !== name) return n ? notFound(n) : `ERR --name is required (-n ${name})`;
  return null;
}

// ---- deployments ----

interface Deployment {
  sku: string;
  capacity: number;
  mode: 'Incremental' | 'Complete';
}

function readDeployment(g: Game, cmd: string): Deployment | string {
  const rg = flagValue(cmd, '--resource-group', '-g');
  if (rg !== RG) return rg ? `(ResourceGroupNotFound) Resource group '${rg}' could not be found.` : `ERR --resource-group is required (-g ${RG})`;
  const file = flagValue(cmd, '--template-file', '-f');
  if (!file) return 'ERR --template-file is required, e.g. --template-file main.bicep (type ls to see the files)';
  const templateName = fileName(file);
  if (!(templateName in g.files) || !templateName.endsWith('.bicep')) return `ERR --template-file '${file}' was not found in ~/scratch (a .bicep file; type ls)`;
  const modeArg = flagValue(cmd, '--mode');
  const mode = modeArg === null ? 'Incremental' : (['Incremental', 'Complete'] as const).find((m) => m.toLowerCase() === modeArg.toLowerCase());
  if (!mode) return `ERR --mode must be Incremental or Complete`;

  const params = templateParams(g.files[templateName].split('\n'));
  const overrides = values(cmd, '--parameters');
  if (overrides) {
    // @file.json is an ARM parameters file; name=value pairs win over it, like on the real CLI
    const given: Record<string, string> = {};
    const fail: string[] = [];
    const collect: ScratchOut = (t) => fail.push(t);
    for (const v of overrides.filter(isFileRef)) {
      const file = readScratchJson(g, collect, v);
      if (!file) return fail[0];
      const body = file.value as { parameters?: Record<string, unknown> } | null;
      if (!body || typeof body !== 'object' || !body.parameters || typeof body.parameters !== 'object') {
        return `(InvalidTemplate) '${file.name}' is not a parameters file: it needs a "parameters" object with one { "value": ... } entry per parameter.`;
      }
      for (const [k, entry] of Object.entries(body.parameters)) {
        const val = (entry as { value?: unknown } | null)?.value;
        if (val === undefined || val === null || typeof val === 'object') return `(InvalidTemplate) Parameter '${k}' in '${file.name}' needs a { "value": <string or number> } entry.`;
        given[k] = String(val);
      }
    }
    const rest = overrides.filter((v) => !isFileRef(v));
    if (rest.length) {
      const pairs = parsePairs(rest);
      if (!pairs) return 'ERR --parameters expects name=value pairs or @file.json, e.g. --parameters planSku=S1';
      Object.assign(given, pairs);
    }
    const bad = Object.keys(given).find((k) => !(k in params));
    if (bad) {
      return `(InvalidTemplate) Deployment template validation failed: the template parameter '${bad}' is not present in ${templateName} and cannot be provided at deployment time.`;
    }
    Object.assign(params, given);
  }
  const capacity = Number(params.instanceCount);
  if (!Number.isInteger(capacity) || capacity < 1) return `(InvalidTemplate) Parameter 'instanceCount' must be a whole number of at least 1, got '${params.instanceCount}'.`;
  if (!SKUS[params.planSku]) return `(BadRequest) The pricing tier '${params.planSku}' is not valid. Known tiers here: ${Object.keys(SKUS).join(', ')}.`;
  return { sku: params.planSku, capacity, mode };
}

const doomed = (g: Game) => [...(g.logs ? ['launchlogs'] : []), ...(g.vm ? [VM] : [])];

function whatIf(g: Game, out: Out, d: Deployment) {
  const planChange =
    d.sku !== g.plan.sku || d.capacity !== g.plan.workers
      ? [`  ~ Microsoft.Web/serverfarms/${PLAN}`, `      sku.name:     "${g.plan.sku}" => "${d.sku}"`, `      sku.capacity: ${g.plan.workers} => ${d.capacity}`]
      : [`  = Microsoft.Web/serverfarms/${PLAN}`];
  out('# what-if · Resource and property changes are indicated with these symbols: + create, ~ modify, - delete, = no change', 'heading');
  const lines = [...planChange, `  = Microsoft.Web/sites/${WEB}`, g.staging ? `  = Microsoft.Web/sites/${WEB}/slots/staging` : `  + Microsoft.Web/sites/${WEB}/slots/staging`];
  if (d.mode === 'Complete') {
    if (g.logs) lines.push('  - Microsoft.Storage/storageAccounts/launchlogs');
    if (g.vm) lines.push(`  - Microsoft.Compute/virtualMachines/${VM}`);
  }
  lines.forEach((l) => out(l, l.startsWith('  -') ? 'error' : l.startsWith('  +') ? 'success' : 'output'));
  const count = (sym: string) => lines.filter((l) => l.startsWith(`  ${sym}`)).length;
  out(`Resource changes: ${count('+')} to create, ${count('~')} to modify, ${count('-')} to delete, ${count('=')} no change.`);
}

function deploy(g: Game, out: Out, d: Deployment) {
  const sku = SKUS[d.sku];
  if (d.capacity > sku.max) {
    return out(`(BadRequest) The ${sku.tier} tier supports at most ${sku.max} instance(s) per plan; the template asks for ${d.capacity}.`, 'error');
  }
  if (!sku.slots && g.staging) {
    return out(`(BadRequest) The plan '${PLAN}' hosts a deployment slot and cannot move to the ${sku.tier} tier, which does not support slots.`, 'error');
  }
  g.plan = { sku: d.sku, workers: d.capacity };
  out(`  ${PLAN}: ${sku.tier} ${d.sku} × ${d.capacity}`);
  if (!sku.slots && !g.staging) {
    out(`(Conflict) Cannot create the deployment slot 'staging' on '${WEB}': plan '${PLAN}' is in the ${sku.tier} tier. Deployment slots need the Standard, Premium or Isolated tier.`, 'error');
    out('# the deployment failed part-way: the plan was updated, the slot was not', 'heading');
    return;
  }
  if (!g.staging) {
    g.staging = { version: 'v1', settings: { DB_URL: 'staging-db' } };
    out(`  ${WEB}/staging created (DB_URL=staging-db)`);
  }
  out(`OK  deployment succeeded (${d.mode}).`, 'success');
  if (d.mode === 'Complete') {
    const gone = doomed(g);
    if (gone.length) {
      g.lost.push(...gone);
      g.logs = false;
      g.vm = null;
      out(`✗ Complete mode deleted ${gone.join(' and ')}: not in the template`, 'error');
    }
  }
}

// ---- commands ----

const HELP_COMMANDS: [string, string][] = [
  ['help · clear · restart', 'This guide · flush output · reset the puzzle'],
  ['hint · submit', 'Nudge toward the next step · run the go-live review'],
  ['ls · cat <file> · edit <file> · touch <file> · rm <file>', 'The ~/scratch folder. Files open in the editor below the terminal and save as you type'],
  ["sed -i 's/old/new/' main.bicep", 'Quick one-line edit of the template (first match on each line)'],
  ['--parameters @params.json · --settings @appsettings.json', 'Feed an ARM parameters file to a deployment, or a JSON array of app settings (with "slotSetting") to appsettings set'],
  ['<command> > <file>', 'Save a command\'s output into ~/scratch, e.g. az webapp config appsettings list -n shop-web -g launch-rg > appsettings.json'],
  [`az resource list -g ${RG}`, 'What is in the group'],
  [`az deployment group what-if -g ${RG} --template-file main.bicep [--parameters k=v ...] [--mode Incremental|Complete]`, 'Preview a deployment'],
  [`az deployment group create -g ${RG} --template-file main.bicep [--parameters k=v ...] [--mode Incremental|Complete]`, 'Deploy (Incremental by default)'],
  [`az appservice plan show|update -n ${PLAN} -g ${RG} [--sku <sku>] [--number-of-workers <n>]`, 'Inspect or scale the plan'],
  [`az webapp deploy -n ${WEB} -g ${RG} [--slot staging] --src-path <zip> --type zip`, 'Deploy a release package'],
  [`az webapp config appsettings list|set -n ${WEB} -g ${RG} [--slot staging] [--settings k=v ...] [--slot-settings k=v ...]`, 'App settings; --slot-settings makes a setting stick to its slot'],
  [`az webapp deployment slot list|swap -n ${WEB} -g ${RG} [--slot staging --target-slot production]`, 'List slots or swap two of them'],
  ['curl <host>', `Call the app: ${WEB}.azurewebsites.net or ${WEB}-staging.azurewebsites.net`],
  [`az vm show -n ${VM} -g ${RG}`, 'Show the VM'],
  ['az vm list-skus -l eastus --size Standard_ --zone', 'VM sizes and the zones that offer them'],
  [`az vm resize -n ${VM} -g ${RG} --size <size>`, 'Resize the VM (restarts it)'],
];

const slotName = (cmd: string): 'staging' | 'production' | string => flagValue(cmd, '--slot', '-s') ?? 'production';

function settingsJson(g: Game, slot: Slot) {
  return JSON.stringify(
    Object.entries(slot.settings).map(([name, value]) => ({ name, slotSetting: g.sticky.includes(name), value })),
    null,
    2
  );
}

function webappCmd(g: Game, out: Out, cmd: string) {
  const sub = words(cmd)[2];
  if (sub === 'deploy') return deployPackage(g, out, cmd);
  const err = target(cmd, WEB);
  if (err) return out(err, 'error');

  if (cmd.startsWith('az webapp deployment slot list')) {
    return g.staging ? out(`${'Name'.padEnd(12)}State\nstaging     Running`, 'output') : out('[]');
  }
  if (cmd.startsWith('az webapp deployment slot swap')) {
    const from = flagValue(cmd, '--slot', '-s');
    const to = flagValue(cmd, '--target-slot') ?? 'production';
    if (!from) return out('ERR Usage: az webapp deployment slot swap -n shop-web -g launch-rg --slot staging --target-slot production', 'error');
    if (!g.staging) return out(`(NotFound) The slot '${from}' does not exist on '${WEB}'. Create it first with a deployment.`, 'error');
    if (!(from === 'staging' && to === 'production') && !(from === 'production' && to === 'staging')) {
      return out(`(BadRequest) Cannot swap '${from}' with '${to}': the slots on ${WEB} are production and staging.`, 'error');
    }
    const a = g.prod;
    const b = g.staging;
    [a.version, b.version] = [b.version, a.version];
    for (const key of new Set([...Object.keys(a.settings), ...Object.keys(b.settings)])) {
      if (g.sticky.includes(key)) continue;
      const [x, y] = [a.settings[key], b.settings[key]];
      if (y === undefined) delete a.settings[key];
      else a.settings[key] = y;
      if (x === undefined) delete b.settings[key];
      else b.settings[key] = x;
    }
    g.swapped = true;
    out(`OK  swapped. Production now runs ${g.prod.version}, staging holds ${g.staging.version}.`, 'success');
    out('# staging was warmed up first, so the cut-over has no cold start. A second swap is the rollback.', 'heading');
    return;
  }
  if (cmd.startsWith('az webapp config appsettings')) {
    const name = slotName(cmd);
    const slot = name === 'production' ? g.prod : name === 'staging' ? g.staging : null;
    if (!slot) return out(name === 'staging' ? `(NotFound) The slot 'staging' does not exist on '${WEB}'.` : `(NotFound) The slot '${name}' does not exist on '${WEB}'.`, 'error');
    if (cmd.startsWith('az webapp config appsettings list')) return out(settingsJson(g, slot), 'success');
    if (cmd.startsWith('az webapp config appsettings set')) {
      let plain: Record<string, string> | null = values(cmd, '--settings') ? parsePairs(values(cmd, '--settings')) : {};
      const sticky = values(cmd, '--slot-settings') ? parsePairs(values(cmd, '--slot-settings')) : {};
      const ref = values(cmd, '--settings')?.[0];
      if (isFileRef(ref)) {
        // --settings @file.json: [{ "name": ..., "value": ..., "slotSetting": true|false }]
        const fail: string[] = [];
        const file = readScratchJson(g, (t) => fail.push(t), ref);
        if (!file) return out(fail[0], 'error');
        if (!sticky) return out('ERR --slot-settings expects name=value pairs', 'error');
        const list = file.value;
        const okShape = Array.isArray(list) && list.every((x) => x && typeof x === 'object' && typeof x.name === 'string' && ['string', 'number', 'boolean'].includes(typeof x.value));
        if (!okShape) return out(`ERR '${file.name}' must be a JSON array of { "name": ..., "value": ..., "slotSetting": true|false } objects.`, 'error');
        plain = {};
        for (const item of list as { name: string; value: string | number | boolean; slotSetting?: boolean }[]) {
          if (item.slotSetting) sticky[item.name] = String(item.value);
          else plain[item.name] = String(item.value);
        }
      }
      if (!plain || !sticky || (!Object.keys(plain).length && !Object.keys(sticky).length)) {
        return out('ERR Usage: az webapp config appsettings set -n shop-web -g launch-rg [--slot staging] --settings k=v ... --slot-settings k=v ...', 'error');
      }
      Object.assign(slot.settings, plain, sticky);
      Object.keys(sticky).forEach((k) => {
        if (!g.sticky.includes(k)) g.sticky.push(k);
      });
      out(settingsJson(g, slot), 'success');
      if (Object.keys(sticky).length) out(`# ${Object.keys(sticky).join(', ')}: slot setting, it stays with its slot on a swap (the name is sticky for every slot)`, 'heading');
      return;
    }
  }
  out('ERR Usage: az webapp <deploy|config appsettings|deployment slot> ...', 'error');
}

function deployPackage(g: Game, out: Out, cmd: string) {
  const err = target(cmd, WEB);
  if (err) return out(err, 'error');
  const src = flagValue(cmd, '--src-path');
  const m = src?.match(/^release-(v[12])\.zip$/);
  if (!m) return out('ERR --src-path must be release-v1.zip or release-v2.zip (type ls)', 'error');
  const name = slotName(cmd);
  if (name === 'production') {
    g.prod.version = m[1];
    out(`OK  ${src} deployed to production.`, 'success');
    out('# straight to production: no staging check and no swap to roll back to', 'alert');
  } else if (name === 'staging' && g.staging) {
    g.staging.version = m[1];
    out(`OK  ${src} deployed to the staging slot.`, 'success');
  } else out(`(NotFound) The slot '${name}' does not exist on '${WEB}'.`, 'error');
}

function planCmd(g: Game, out: Out, cmd: string) {
  const err = target(cmd, PLAN);
  if (err) return out(err, 'error');
  const sub = words(cmd)[3];
  const show = () => out(JSON.stringify({ name: PLAN, location: LOCATION, sku: { name: g.plan.sku, tier: SKUS[g.plan.sku].tier, capacity: g.plan.workers }, numberOfSites: g.staging ? 2 : 1 }, null, 2), 'success');
  if (sub === 'show') return show();
  if (sub !== 'update') return out('ERR Usage: az appservice plan <show|update> -n shop-plan -g launch-rg ...', 'error');
  const sku = flagValue(cmd, '--sku');
  const workersArg = flagValue(cmd, '--number-of-workers');
  if (!sku && !workersArg) return out('ERR Nothing to update: pass --sku (scale up) and/or --number-of-workers (scale out).', 'error');
  const newSku = sku ?? g.plan.sku;
  if (!SKUS[newSku]) return out(`(BadRequest) The pricing tier '${newSku}' is not valid. Known tiers here: ${Object.keys(SKUS).join(', ')}.`, 'error');
  const workers = workersArg === null ? g.plan.workers : Number(workersArg);
  if (!Number.isInteger(workers) || workers < 1) return out('ERR --number-of-workers must be a whole number of at least 1.', 'error');
  if (workers > SKUS[newSku].max) return out(`(BadRequest) The ${SKUS[newSku].tier} tier supports at most ${SKUS[newSku].max} instance(s) per plan.`, 'error');
  if (!SKUS[newSku].slots && g.staging) return out(`(BadRequest) The plan hosts a deployment slot and cannot move to the ${SKUS[newSku].tier} tier.`, 'error');
  g.plan = { sku: newSku, workers };
  show();
}

function vmCmd(g: Game, out: Out, cmd: string) {
  const sub = words(cmd)[2];
  if (sub === 'list-skus') {
    const prefix = flagValue(cmd, '--size') ?? '';
    const rows = Object.entries(VM_SIZES).filter(([n]) => n.startsWith(prefix));
    out(`${'Name'.padEnd(18)}${'vCPUs'.padEnd(7)}${'GiB'.padEnd(6)}Zones`, 'heading');
    rows.forEach(([n, s]) => out(`${n.padEnd(18)}${String(s.vcpu).padEnd(7)}${String(s.mem).padEnd(6)}${s.zones.length ? s.zones.join(',') : '(not zonal)'}`));
    return;
  }
  const err = target(cmd, VM);
  if (err) return out(g.vm ? err : notFound(VM), 'error');
  if (!g.vm) return out(notFound(VM), 'error');
  if (sub === 'show') {
    return out(JSON.stringify({ name: VM, location: LOCATION, zones: [String(VM_ZONE)], hardwareProfile: { vmSize: g.vm.size }, powerState: 'VM running' }, null, 2), 'success');
  }
  if (sub === 'resize') {
    const size = flagValue(cmd, '--size');
    const spec = size ? VM_SIZES[size] : undefined;
    if (!size || !spec) return out(`ERR --size must be one of: ${Object.keys(VM_SIZES).join(', ')}`, 'error');
    if (!spec.zones.includes(VM_ZONE)) {
      return out(`(SkuNotAvailable) The requested VM size '${size}' is not available in availability zone ${VM_ZONE} in location '${LOCATION}'. Run "az vm list-skus" to see the zones each size offers.`, 'error');
    }
    g.vm.size = size;
    out(`OK  ${VM} is now ${size}. The VM was restarted to apply the new size.`, 'success');
    return;
  }
  out('ERR Usage: az vm <show|resize|list-skus> ...', 'error');
}

function curl(g: Game, out: Out, cmd: string) {
  const host = words(cmd)[1]?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const hit = host === `${WEB}.azurewebsites.net` ? g.prod : host === `${WEB}-staging.azurewebsites.net` ? g.staging : undefined;
  if (host === `${WEB}-staging.azurewebsites.net` && !g.staging) return out(`curl: (6) Could not resolve host: ${host}`, 'error');
  if (!hit) return out(host ? `curl: (6) Could not resolve host: ${host}` : 'ERR Usage: curl <host>', 'error');
  out(`HTTP/1.1 200 OK · ${host === `${WEB}.azurewebsites.net` ? 'production' : 'staging'}`, 'success');
  out(`${WEB} release=${hit.version} DB_URL=${hit.settings.DB_URL ?? '(unset)'}`);
}

function resourceList(g: Game, out: Out) {
  out(`${'Name'.padEnd(22)}Type`, 'heading');
  out(`${PLAN.padEnd(22)}Microsoft.Web/serverfarms`);
  out(`${WEB.padEnd(22)}Microsoft.Web/sites`);
  if (g.staging) out(`${`${WEB}/staging`.padEnd(22)}Microsoft.Web/sites/slots`);
  if (g.logs) out(`${'launchlogs'.padEnd(22)}Microsoft.Storage/storageAccounts`);
  if (g.vm) out(`${VM.padEnd(22)}Microsoft.Compute/virtualMachines`);
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

  const sed = cmd.match(/^sed -i ['"]?s\/(.+)\/(.*)\/(g?)['"]? main\.bicep$/);

  if (cmd === 'help') {
    out('# commands', 'heading');
    HELP_COMMANDS.forEach(([c, d]) => out(`  ${c}\n      ${d}`));
  } else if (scratchCommand(g, out, cmd, SCRATCH)) {
    // ls, cat, edit, touch, rm: handled by the scratch module
  } else if (sed) {
    const [, from, to, flag] = sed;
    let changed = 0;
    g.files['main.bicep'] = bicepLines(g)
      .map((line) => {
        const next = flag === 'g' ? line.split(from).join(to) : line.replace(from, to);
        if (next !== line) changed++;
        return next;
      })
      .join('\n');
    out(changed ? `OK  main.bicep: ${changed} line${changed > 1 ? 's' : ''} changed.` : 'main.bicep: no match, nothing changed.', changed ? 'success' : 'output');
  } else if (cmd === 'hint') {
    out(`HINT ${nextHint(g)}`, 'alert');
  } else if (cmd === 'submit') {
    debrief(g, out);
  } else if (cmd.startsWith('az resource list')) {
    resourceList(g, out);
  } else if (/^az deployment group (what-if|create)\b/.test(cmd)) {
    const d = readDeployment(g, cmd);
    if (typeof d === 'string') out(d, 'error');
    else if (cmd.startsWith('az deployment group what-if')) whatIf(g, out, d);
    else deploy(g, out, d);
  } else if (cmd.startsWith('az appservice plan')) {
    planCmd(g, out, cmd);
  } else if (cmd.startsWith('az webapp')) {
    webappCmd(g, out, cmd);
  } else if (cmd.startsWith('az vm')) {
    vmCmd(g, out, cmd);
  } else if (cmd.startsWith('curl')) {
    curl(g, out, cmd);
  } else {
    out(`bash: ${cmd.split(' ')[0]}: command not recognized. Type "help" for usage.`, 'error');
  }
  return g;
}
