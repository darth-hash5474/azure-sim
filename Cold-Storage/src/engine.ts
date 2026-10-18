// Game engine for Cold Storage: a simulated slice of Azure Storage management and the Azure CLI. No React in here.

import { isFileRef, readScratchJson, scratchCommand, type ScratchConfig } from './scratch';
import { newShell, runShell, type Host, type ShellEnv } from './shell';
import { splitWords } from './shellcore';


export type LineType = 'input' | 'output' | 'error' | 'success' | 'heading' | 'alert';

interface Line {
  text: string;
  type: LineType;
}

type Out = (text: string, type?: LineType) => void;

const SKUS = [
  'Standard_LRS',
  'Standard_GRS',
  'Standard_RAGRS',
  'Standard_ZRS',
  'Standard_GZRS',
  'Standard_RAGZRS',
  'Premium_LRS',
  'Premium_ZRS',
] as const;

type Sku = (typeof SKUS)[number];
type KeyName = 'key1' | 'key2';
export type AppId = 'payments-app' | 'backup-job';
type BlobTier = 'Hot' | 'Cool' | 'Cold' | 'Archive';
type ShareTier = 'TransactionOptimized' | 'Hot' | 'Cool';
type Status = 'open' | 'closed' | 'skipped';

interface Blob {
  name: string;
  size: string;
  tier: BlobTier;
  rehydrate: { to: BlobTier; priority: 'Standard' | 'High' } | null;
}

interface Container {
  name: string;
  blobs: Blob[];
  deletedVersion: string | null; // non-null while soft-deleted
}

interface AccessPolicy {
  name: string;
  perms: string | null;
  expiry: string | null;
}

interface Sas {
  id: number;
  ticket: number; // ticket that was open when it was issued
  kind: 'account' | 'service' | 'user';
  container: string | null;
  perms: string | null;
  expiry: string | null;
  policy: string | null;
  key: KeyName | null; // signing key (account and service SAS)
  keyVersion: number;
  udEpoch: number; // user delegation SAS: delegation-key generation it was signed under
}

export interface Game {
  ticket: number; // index of the open ticket; TICKETS.length when the shift is over
  status: Status[];
  reopens: number[];
  sku: Sku;
  blobRetention: number | null;
  containerRetention: number | null;
  versioning: boolean;
  containers: Container[];
  policies: Record<string, AccessPolicy[]>;
  sas: Sas[];
  partnerSas: number | null;
  keys: Record<KeyName, { value: string; version: number }>;
  udEpoch: number;
  apps: Record<AppId, string>; // the key value each consumer authenticates with
  shares: Record<string, { quota: number; tier: ShareTier }>;
  lifecycle: string | null; // file the applied lifecycle policy came from
  lifecycleDoc: unknown | null; // the policy as it was when applied (editing the file afterwards changes nothing until re-applied)
  files: Record<string, string>; // ~/scratch: the lifecycle policy drafts and whatever the player adds
  focus: string | null; // file the editor panel shows
  sh: ShellEnv; // bash variables
  defaultAction: 'Allow' | 'Deny';
  ipRules: string[];
  subnetRule: boolean;
  serviceEndpoint: boolean;
  history: Line[];
}

const TENANT = 'contoso.onmicrosoft.com';
export const ACCOUNT = 'contosodata';
const RG = 'data-rg';
const SUB_ID = '6b1e9d3a-2f7c-4a58-b0e4-8c3d5f1a7e92';
const ACCOUNT_ID = `/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${ACCOUNT}`;
const SUBNET_ID = `/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/Microsoft.Network/virtualNetworks/app-vnet/subnets/app-subnet`;
const ADMIN_OID = '7c2e5a91-3f4b-4d86-b1e0-9a6d2c8f4e57';
const OFFICE_IP = '203.0.113.10';
const SHELL_IP = '20.42.17.88';
export const PROMPT = 'storage-admin@contoso-prod:~$';
const SAS_VERSION = '2022-11-02';

const APPS: Record<AppId, { kind: 'webapp' | 'functionapp'; rg: string; key: KeyName }> = {
  'payments-app': { kind: 'webapp', rg: 'apps-rg', key: 'key1' },
  'backup-job': { kind: 'functionapp', rg: 'apps-rg', key: 'key2' },
};
export const APP_IDS = Object.keys(APPS) as AppId[];

const TODAY = new Date().toISOString().slice(0, 10);

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const PARTNER_DEADLINE = addDays(TODAY, 7);

/** Accepts 2026-10-22 or 2026-10-22T00:00Z style UTC dates; returns the date part. */
const parseDate = (v: string | null): string | null =>
  v && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null;

/** Deterministic base64-looking strings for keys and signatures. */
function pseudoB64(seed: number, length: number): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = seed >>> 0;
  let s = '';
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += A[(x >>> 16) % 64];
  }
  return s;
}

const keyValue = (k: KeyName, version: number) => `${pseudoB64((k === 'key1' ? 7919 : 104729) + version * 31337, 40)}==`;

const zoned = (s: Sku) => s.includes('ZRS');
const geo = (s: Sku) => s.includes('GRS');
const readableSecondary = (s: Sku) => s.includes('RAG');

const PERM_NAMES: Record<string, string> = {
  r: 'read', a: 'add', c: 'create', w: 'write', d: 'delete', x: 'delete version', l: 'list',
  t: 'tags', i: 'set immutability', m: 'move', e: 'execute', o: 'ownership', p: 'permissions',
};

// ---- lifecycle policy drafts (only one is right) ----

const lifecycleRule = (prefix: string, cool: number, archive: number, del: number) => ({
  rules: [
    {
      enabled: true,
      name: 'logs-retention',
      type: 'Lifecycle',
      definition: {
        actions: {
          baseBlob: {
            tierToCool: { daysAfterModificationGreaterThan: cool },
            tierToArchive: { daysAfterModificationGreaterThan: archive },
            delete: { daysAfterModificationGreaterThan: del },
          },
        },
        filters: { blobTypes: ['blockBlob'], prefixMatch: [prefix] },
      },
    },
  ],
});

const POLICY_FILES: Record<string, ReturnType<typeof lifecycleRule>> = {
  'logs-v1.json': lifecycleRule('2026/', 30, 90, 365),
  'logs-v2.json': lifecycleRule('logs/', 30, 90, 365),
  'logs-v3.json': lifecycleRule('logs/', 30, 365, 90),
};

/** ~/scratch: the three platform-team drafts, as real files the player can read, fix and apply. */
export const SCRATCH: ScratchConfig = { readonly: [] };

const initialFiles = (): Record<string, string> =>
  Object.fromEntries(Object.entries(POLICY_FILES).map(([name, doc]) => [name, JSON.stringify(doc, null, 2) + '\n']));

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const TIER_ACTIONS = ['tierToCool', 'tierToCold', 'tierToArchive', 'delete'];

/** What the service checks when a policy arrives: its shape, not whether it is a good policy. Returns an error line or null. */
function validatePolicy(doc: unknown): string | null {
  const bad = (m: string) => `(InvalidRequestContent) The management policy is invalid: ${m}`;
  if (!isObj(doc) || !Array.isArray(doc.rules) || !doc.rules.length) return bad("the file needs a top-level 'rules' array with at least one rule.");
  const names = new Set<string>();
  for (const [i, r] of (doc.rules as unknown[]).entries()) {
    const at = `rules[${i}]`;
    if (!isObj(r)) return bad(`${at} must be an object.`);
    if (typeof r.name !== 'string' || !r.name) return bad(`${at}.name is required.`);
    if (names.has(r.name)) return bad(`rule name '${r.name}' is used twice.`);
    names.add(r.name);
    if (r.type !== 'Lifecycle') return bad(`${at}.type must be 'Lifecycle'.`);
    const def = r.definition;
    if (!isObj(def) || !isObj(def.actions)) return bad(`${at}.definition.actions is required.`);
    const filters = def.filters;
    if (!isObj(filters) || !Array.isArray(filters.blobTypes) || !filters.blobTypes.length) return bad(`${at}.definition.filters.blobTypes is required (for example ["blockBlob"]).`);
    if (filters.blobTypes.some((t) => t !== 'blockBlob' && t !== 'appendBlob')) return bad(`${at}.definition.filters.blobTypes can only hold blockBlob and appendBlob.`);
    if (filters.prefixMatch !== undefined && (!Array.isArray(filters.prefixMatch) || filters.prefixMatch.some((p) => typeof p !== 'string'))) return bad(`${at}.definition.filters.prefixMatch must be an array of strings.`);
    const base = def.actions.baseBlob;
    if (!isObj(base) || !Object.keys(base).length) return bad(`${at}.definition.actions.baseBlob needs at least one action (${TIER_ACTIONS.join(', ')}).`);
    for (const [k, v] of Object.entries(base)) {
      if (!TIER_ACTIONS.includes(k)) return bad(`${at}.definition.actions.baseBlob.${k} is not a supported action here (use ${TIER_ACTIONS.join(', ')}).`);
      const days = isObj(v) ? v.daysAfterModificationGreaterThan : undefined;
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) return bad(`${at}.definition.actions.baseBlob.${k}.daysAfterModificationGreaterThan must be a whole number of days.`);
    }
  }
  return null;
}

/** Problems with the applied policy against the CHG-305 requirements. Empty means it is right. */
function lifecycleProblems(doc: unknown): string[] {
  if (!doc) return ['No lifecycle policy is applied yet.'];
  const rules = ((doc as { rules: Obj[] }).rules ?? []).filter((r) => r.enabled !== false);
  if (!rules.length) return ['Every rule in the applied policy is disabled, so nothing will ever run.'];
  const problemsOf = (r: Obj): string[] => {
    const def = r.definition as { actions: { baseBlob: Record<string, { daysAfterModificationGreaterThan: number }> }; filters: { blobTypes: string[]; prefixMatch?: string[] } };
    const out: string[] = [];
    const prefixes = def.filters.prefixMatch ?? [];
    if (!prefixes.length) out.push(`Rule '${r.name}' has no prefixMatch, so it applies to every container in the account, not only logs.`);
    for (const p of prefixes) {
      if (!p.startsWith('logs')) out.push(`Rule '${r.name}': prefixMatch '${p}' does not start with the container name. Prefixes start with the container name, so it matches a container called '${p.split('/')[0]}' and never touches logs.`);
    }
    if (!def.filters.blobTypes.includes('blockBlob')) out.push(`Rule '${r.name}': blobTypes must include blockBlob, the type the logs are stored as.`);
    const d = (k: string) => def.actions.baseBlob[k]?.daysAfterModificationGreaterThan;
    const [cool, archive, del] = [d('tierToCool'), d('tierToArchive'), d('delete')];
    const want: [string, number | undefined, number][] = [['tierToCool', cool, 30], ['tierToArchive', archive, 90], ['delete', del, 365]];
    if (archive !== undefined && del !== undefined && del <= archive) out.push(`Rule '${r.name}': delete (${del} days) fires before or with archive (${archive} days), so logs are destroyed before they reach Archive.`);
    for (const [k, got, exp] of want) {
      if (got === undefined) out.push(`Rule '${r.name}' has no ${k} action. It needs one at ${exp} days.`);
      else if (got !== exp && !(k === 'delete' && archive !== undefined && del !== undefined && del <= archive)) out.push(`Rule '${r.name}': ${k} is ${got} days, the brief says ${exp}.`);
    }
    return out;
  };
  const per = rules.map(problemsOf);
  const outsideLogs = rules.some((r) => {
    const prefixes = (r.definition as { filters: { prefixMatch?: string[] } }).filters.prefixMatch ?? [];
    return !prefixes.length || prefixes.some((p) => !p.startsWith('logs'));
  });
  return per.some((p) => !p.length) && !outsideLogs ? [] : (per.find((p) => p.length) ?? ["A rule outside the logs container is part of this policy. Only logs may be touched."]);
}

// ---- SAS and consumer health ----

/** Effective permissions and expiry of a SAS (policy fields included), and why the service would reject it, if it would. */
export function inspectSas(g: Game, s: Sas): { perms: string; expiry: string; problem: string | null } {
  let perms = s.perms;
  let expiry = s.expiry;
  const result = (problem: string | null) => ({ perms: perms ?? '', expiry: expiry ?? '', problem });

  if (s.kind === 'user') {
    if (s.udEpoch !== g.udEpoch) return result('its user delegation key was revoked');
  } else if (s.key && g.keys[s.key].version !== s.keyVersion) {
    return result(`${s.key}, which signed it, has been regenerated`);
  }
  if (s.policy && s.container) {
    const p = g.policies[s.container]?.find((x) => x.name === s.policy);
    if (!p) return result(`it points at stored access policy '${s.policy}', which does not exist on ${s.container}`);
    if ((p.perms && s.perms) || (p.expiry && s.expiry))
      return result('a field is set in both the token and its stored access policy, which the service rejects');
    perms = p.perms ?? s.perms;
    expiry = p.expiry ?? s.expiry;
  }
  if (!perms) return result('it carries no permissions');
  if (!expiry) return result('it has no expiry');
  if (expiry <= TODAY) return result(`it expired on ${expiry}`);
  return result(null);
}

export function appProblem(g: Game, app: AppId): string | null {
  if (g.apps[app] !== g.keys.key1.value && g.apps[app] !== g.keys.key2.value) return 'stale key';
  if (g.defaultAction === 'Deny' && !g.subnetRule) return 'firewalled';
  return null;
}

export const keyInUse = (g: Game, app: AppId): KeyName | null =>
  g.apps[app] === g.keys.key1.value ? 'key1' : g.apps[app] === g.keys.key2.value ? 'key2' : null;

const liveContainer = (g: Game, name: string | null) => g.containers.find((c) => c.name === name && !c.deletedVersion);

// ---- tickets ----

interface Ticket {
  id: string;
  title: string;
  brief: string[];
  reqs: string[];
  hint: string[];
  lesson: string;
  open?: (g: Game, out: Out) => void;
  check: (g: Game) => string[]; // empty = pass
  onPass?: (g: Game, out: Out) => void;
}

const partnerCandidate = (g: Game) => [...g.sas].reverse().find((s) => s.ticket === 2);

export const TICKETS: Ticket[] = [
  {
    id: 'CHG-301',
    title: 'Survive a region outage',
    brief: [
      `The orders API reads invoices from ${ACCOUNT}. Risk has signed off on a new requirement:`,
      'if East US goes down, the data must survive AND the API must keep reading it from the secondary',
      'region without waiting for anyone to fail over. Use the cheapest redundancy that does this.',
      'Zone redundancy is not required.',
    ],
    reqs: ['copy in a second region', 'secondary readable, no failover', 'cheapest option that fits'],
    hint: [
      'LRS keeps 3 copies in one datacenter. GRS adds 3 more in the paired region, but you can only read',
      'them after a failover. The RA- variants expose a read-only secondary endpoint all the time.',
      `az storage account update -n ${ACCOUNT} -g ${RG} --sku <sku>`,
    ],
    lesson:
      'LRS = one datacenter, ZRS = three zones, GRS/GZRS add the paired region. Only RA-GRS/RA-GZRS let you read the secondary without a failover. Adding or removing zones is a conversion, not a SKU flip.',
    check: (g) =>
      g.sku === 'Standard_RAGRS'
        ? []
        : g.sku === 'Standard_GRS'
          ? ['GRS replicates to West US, but that copy is only readable after a failover. The API needs to read it during the outage.']
          : [`Still ${g.sku}: every copy lives in East US. A regional outage takes the data offline.`],
  },
  {
    id: 'CHG-302',
    title: 'Make containers recoverable',
    brief: [
      'Last quarter someone deleted a whole container. Blob soft delete was on and it did not help.',
      'Make deleted containers recoverable for at least 14 days.',
    ],
    reqs: ['deleted containers recoverable', 'retention ≥ 14 days'],
    hint: [
      'Blob soft delete, container soft delete and versioning are separate switches on the blob service.',
      `az storage account blob-service-properties update --account-name ${ACCOUNT} -g ${RG} \\`,
      '    --enable-container-delete-retention true --container-delete-retention-days <days>',
    ],
    lesson:
      'Blob soft delete, container soft delete and versioning are separate settings. Only container soft delete brings back a deleted container (1-365 days).',
    check: (g) =>
      g.containerRetention === null
        ? ['Container soft delete is still off. Blob soft delete (already on) protects blobs, not a deleted container.']
        : g.containerRetention < 14
          ? [`Container retention is ${g.containerRetention} days. The ticket asks for at least 14.`]
          : [],
  },
  {
    id: 'CHG-303',
    title: 'Partner access to invoices',
    brief: [
      "Fabrikam's auditors need to read and list blobs in the invoices container. Read-only, nothing",
      `else in the account, and access must end no later than ${PARTNER_DEADLINE}.`,
      'Generate the SAS token you will send them, then submit. (Security says: assume every link leaks.)',
    ],
    reqs: ['invoices container only', 'read + list, nothing more', `expires by ${PARTNER_DEADLINE}`],
    hint: [
      'Account SAS: whole account. Service SAS: one container, signed with an account key, optionally',
      'backed by a stored access policy. User delegation SAS: signed with your Entra ID credentials',
      '(--as-user --auth-mode login), at most 7 days. Before you pick, ask how you would kill each one early.',
    ],
    lesson:
      'Account SAS spans the account, service SAS one resource, user delegation SAS uses Entra ID (max 7 days). Back a service SAS with a stored access policy (max 5 per container) so you can revoke it without rotating keys.',
    check: (g) => {
      const s = partnerCandidate(g);
      if (!s) return ['No SAS has been generated for this ticket yet. Generate one, then submit.'];
      const { perms, expiry, problem } = inspectSas(g, s);
      const errs: string[] = [];
      if (s.kind === 'account') errs.push(`That is an account SAS. It opens every container in ${ACCOUNT}, not just invoices.`);
      else if (s.container !== 'invoices') errs.push(`That SAS is for container '${s.container}', not invoices.`);
      if (problem) return [...errs, `The token would be rejected: ${problem}.`];
      const extra = [...perms].filter((c) => !'rl'.includes(c));
      if (extra.length) errs.push(`It also grants ${extra.map((c) => PERM_NAMES[c] ?? c).join(', ')}. The partner gets read and list only.`);
      if (!perms.includes('r')) errs.push('It cannot read blobs: there is no r permission.');
      if (expiry > PARTNER_DEADLINE) errs.push(`It stays valid until ${expiry}. Access has to end by ${PARTNER_DEADLINE}.`);
      return errs;
    },
    onPass: (g, out) => {
      const s = partnerCandidate(g)!;
      g.partnerSas = s.id;
      out(`  Token sent to fabrikam-audit@fabrikam.com (${s.kind === 'user' ? 'user delegation SAS' : s.policy ? `service SAS via policy '${s.policy}'` : `service SAS signed with ${s.key}`}).`);
    },
  },
  {
    id: 'CHG-304',
    title: 'Finance file share',
    brief: [
      `Finance is retiring an old file server. They need an SMB share called finance on ${ACCOUNT},`,
      'hard-capped at 100 GiB. It holds closed-year records that are rarely opened, so keep the',
      'storage cost as low as possible.',
    ],
    reqs: ['SMB share "finance"', 'quota exactly 100 GiB', 'lowest storage cost tier'],
    hint: [
      'Standard file shares have three tiers: TransactionOptimized, Hot, Cool. Cool has the cheapest',
      'storage and the most expensive transactions. The quota is the hard cap, in GiB.',
      `az storage share-rm create --storage-account ${ACCOUNT} -g ${RG} --name finance --quota <GiB> --access-tier <tier>`,
    ],
    lesson:
      'Standard Azure Files shares come in TransactionOptimized, Hot and Cool tiers, and the quota is a hard cap. share-rm goes through ARM; "az storage share" is the data-plane equivalent.',
    check: (g) => {
      const s = g.shares.finance;
      if (!s) return ['There is no share called finance yet.'];
      const errs: string[] = [];
      if (s.quota !== 100) errs.push(`Quota is ${s.quota} GiB. Finance asked for a hard cap of 100 GiB.`);
      if (s.tier !== 'Cool') errs.push(`Tier is ${s.tier}. For rarely-opened data, Cool has the lowest storage price.`);
      return errs;
    },
  },
  {
    id: 'CHG-305',
    title: 'Log retention',
    brief: [
      'Compliance rule for the logs container: move blobs to Cool 30 days after last modification,',
      'to Archive after 90, and delete them after 365.',
      'The platform team drafted three lifecycle policies in ~/scratch (logs-v1.json, logs-v2.json, logs-v3.json). Only one is right.',
      'Apply the right one, or fix a draft in the editor first. The policy is checked as it was when you applied it.',
    ],
    reqs: ['Cool @ 30 days', 'Archive @ 90 days', 'delete @ 365 days', 'logs container only'],
    hint: [
      'cat each draft. prefixMatch must start with the container name, and check every day count.',
      `az storage account management-policy create --account-name ${ACCOUNT} -g ${RG} --policy @<file>`,
    ],
    lesson:
      'Lifecycle prefixMatch starts with the container name. There is one management policy per account, and it runs about once a day, so new rules take up to 24 hours to act.',
    check: (g) => lifecycleProblems(g.lifecycleDoc),
  },
  {
    id: 'INC-306',
    title: 'media container deleted',
    brief: [
      'The marketing site is serving 404s for every image. Get the media container back.',
    ],
    reqs: ['media container live again'],
    hint: [
      `az storage container list --account-name ${ACCOUNT} --include-deleted shows soft-deleted containers`,
      `and their version. Then: az storage container restore -n media --deleted-version <v> --account-name ${ACCOUNT}`,
      'If container soft delete was off when it was deleted, there is nothing to restore.',
    ],
    lesson:
      'A deleted container comes back only if container soft delete was on at the time: list with --include-deleted, then restore by name and deleted version.',
    open: (g, out) => {
      out(`!! storage-intern@contoso just ran: az storage container delete -n media --account-name ${ACCOUNT}`, 'alert');
      const c = liveContainer(g, 'media');
      if (!c) return;
      if (g.containerRetention !== null) c.deletedVersion = '01DB3A7F2C9E4B10';
      else g.containers = g.containers.filter((x) => x !== c);
    },
    check: (g) =>
      liveContainer(g, 'media')
        ? []
        : g.containers.some((c) => c.name === 'media')
          ? ['media is still soft-deleted. Find its version with --include-deleted and restore it.']
          : ['media was deleted while container soft delete was off, so there is nothing to restore. Type "skip" to close it as lost.'],
  },
  {
    id: 'INC-307',
    title: 'Auditor needs the 2019 ledger',
    brief: [
      'The external auditor needs archive/ledger-2019.csv (3.2 GB) and the meeting is in an hour.',
      'Make it downloadable in time.',
    ],
    reqs: ['ledger-2019.csv readable', 'within the hour'],
    hint: [
      'Archive blobs are offline: try downloading it and see. Rehydrate by changing the tier:',
      `az storage blob set-tier --account-name ${ACCOUNT} -c archive -n ledger-2019.csv --tier Hot --rehydrate-priority <Standard|High>`,
    ],
    lesson:
      'Archive is offline. Rehydrate with set-tier (or a copy): Standard can take up to 15 hours, High usually under 1 hour for blobs under 10 GB, and a pending Standard rehydration can be raised to High. Archive bills a 180-day minimum.',
    check: (g) => {
      const b = g.containers.find((c) => c.name === 'archive')?.blobs.find((x) => x.name === 'ledger-2019.csv');
      if (!b) return ['ledger-2019.csv is gone.'];
      if (b.tier !== 'Archive') return [];
      if (!b.rehydrate) return ['The blob is still in the Archive tier. Archive blobs cannot be read until they are rehydrated.'];
      if (b.rehydrate.priority === 'Standard')
        return ['Rehydration is pending at Standard priority, which can take up to 15 hours. A pending Standard rehydration can be raised to High.'];
      return [];
    },
    onPass: (g, out) => {
      const b = g.containers.find((c) => c.name === 'archive')?.blobs.find((x) => x.name === 'ledger-2019.csv');
      if (b?.rehydrate) {
        out(`  Rehydration finished (High priority, 41 min). ledger-2019.csv is now ${b.rehydrate.to}; the auditor has the file.`);
        b.tier = b.rehydrate.to;
        b.rehydrate = null;
      }
    },
  },
  {
    id: 'INC-308',
    title: 'Partner SAS leaked',
    brief: [
      'Kill that token now. payments-app (uses key1) and backup-job (uses key2) must stay up.',
    ],
    reqs: ['leaked SAS rejected', 'payments-app up', 'backup-job up'],
    hint: [
      'Policy-backed SAS: delete or expire the stored access policy. User delegation SAS: revoke the',
      'delegation keys. Plain service SAS: it dies only with the key that signed it, so rotate safely:',
      'move consumers to the other key (az storage account keys list, then',
      'az webapp config appsettings set -n payments-app -g apps-rg --settings STORAGE_ACCOUNT_KEY=<value>),',
      'then az storage account keys renew.',
    ],
    lesson:
      'Kill a policy-backed SAS by deleting or expiring its policy, a user delegation SAS with revoke-delegation-keys, and a plain SAS only by regenerating its signing key. Rotate keys by moving consumers to the other key first.',
    open: (g, out) => {
      if (g.partnerSas === null) {
        const id = g.sas.length + 1;
        g.sas.push({
          id, ticket: -1, kind: 'service', container: 'invoices', perms: 'rl', expiry: PARTNER_DEADLINE, policy: null,
          key: 'key1', keyVersion: g.keys.key1.version, udEpoch: g.udEpoch,
        });
        g.partnerSas = id;
        out('!! CHG-303 never shipped, so someone in Finance generated a SAS for Fabrikam themselves:', 'alert');
        out(`   a plain service SAS on invoices (rl, until ${PARTNER_DEADLINE}) signed with key1.`, 'alert');
      }
      out('!! The Fabrikam SAS for invoices has been posted in a public forum thread.', 'alert');
    },
    check: (g) => {
      const s = g.sas.find((x) => x.id === g.partnerSas);
      const errs: string[] = [];
      if (s && !inspectSas(g, s).problem) errs.push('The leaked token still works.');
      for (const app of APP_IDS) {
        const p = appProblem(g, app);
        if (p === 'stale key') errs.push(`${app} is down: the key it was using has been regenerated. Point it at a current key.`);
        if (p === 'firewalled') errs.push(`${app} is down: the storage firewall blocks app-subnet.`);
      }
      return errs;
    },
  },
  {
    id: 'CHG-309',
    title: 'Close the public endpoint',
    brief: [
      `${ACCOUNT} accepts traffic from the whole internet. Lock it down so only these can reach it:`,
      '  · app-subnet in app-vnet (payments-app and backup-job run there)',
      `  · the office egress IP ${OFFICE_IP}`,
      'Everything else gets denied.',
    ],
    reqs: ['default action Deny', 'app-vnet/app-subnet allowed', `${OFFICE_IP} allowed`, 'nothing else allowed'],
    hint: [
      'A VNet rule needs the Microsoft.Storage service endpoint on the subnet first:',
      `  az network vnet subnet update -g ${RG} --vnet-name app-vnet -n app-subnet --service-endpoints Microsoft.Storage`,
      `Then az storage account network-rule add --account-name ${ACCOUNT} -g ${RG} (--vnet-name/--subnet or --ip-address),`,
      `then az storage account update -n ${ACCOUNT} -g ${RG} --default-action Deny. Watch what Deny does to Cloud Shell.`,
    ],
    lesson:
      'Firewall: enable the Microsoft.Storage service endpoint before adding a VNet rule; IP rules take public addresses only, and no /31 or /32 ranges. Default Deny also blocks your own data-plane calls, while ARM management calls keep working.',
    check: (g) => {
      const errs: string[] = [];
      if (g.defaultAction !== 'Deny') errs.push('Default action is still Allow: the rules do nothing until everything else is denied.');
      if (!g.subnetRule) errs.push('app-vnet/app-subnet is not in the virtual network rules.');
      if (!g.ipRules.includes(OFFICE_IP)) errs.push(`The office IP ${OFFICE_IP} is not allowed.`);
      const extra = g.ipRules.filter((ip) => ip !== OFFICE_IP);
      if (extra.length)
        errs.push(`Extra IP rules: ${extra.join(', ')}${extra.includes(SHELL_IP) ? ' (Cloud Shell)' : ''}. The ticket allows only the office and app-subnet.`);
      for (const app of APP_IDS) if (appProblem(g, app)) errs.push(`${app} is down (${appProblem(g, app)}).`);
      return errs;
    },
  },
];

// ---- game state ----

const blob = (name: string, size: string, tier: BlobTier = 'Hot'): Blob => ({ name, size, tier, rehydrate: null });

export const initialGame = (): Game => {
  const keys = { key1: { value: keyValue('key1', 0), version: 0 }, key2: { value: keyValue('key2', 0), version: 0 } };
  const g: Game = {
    ticket: 0,
    status: TICKETS.map(() => 'open'),
    reopens: TICKETS.map(() => 0),
    sku: 'Standard_LRS',
    blobRetention: 7,
    containerRetention: null,
    versioning: false,
    containers: [
      { name: 'invoices', deletedVersion: null, blobs: [blob('2026/09/INV-48812.pdf', '212 KB'), blob('2026/09/INV-48813.pdf', '198 KB'), blob('2026/10/INV-49007.pdf', '205 KB')] },
      { name: 'logs', deletedVersion: null, blobs: [blob('2026/10/13/api.log', '48 MB'), blob('2026/10/14/api.log', '51 MB'), blob('2026/10/14/worker.log', '12 MB')] },
      { name: 'media', deletedVersion: null, blobs: [blob('hero.jpg', '1.4 MB'), blob('logo.svg', '8 KB'), blob('catalog/spring.mp4', '96 MB')] },
      { name: 'archive', deletedVersion: null, blobs: [blob('ledger-2019.csv', '3.2 GB', 'Archive'), blob('ledger-2020.csv', '3.4 GB', 'Archive')] },
    ],
    policies: {},
    sas: [],
    partnerSas: null,
    keys,
    udEpoch: 0,
    apps: { 'payments-app': keys.key1.value, 'backup-job': keys.key2.value },
    shares: {},
    lifecycle: null,
    lifecycleDoc: null,
    files: initialFiles(),
    focus: null,
  sh: newShell(),
    defaultAction: 'Allow',
    ipRules: [],
    subnetRule: false,
    serviceEndpoint: false,
    history: [
      { text: `Azure Cloud Shell (simulated) · subscription contoso-prod · signed in as storage-admin@${TENANT}`, type: 'output' },
      { text: `You have the storage ops shift for ${ACCOUNT} (StorageV2, Standard_LRS, East US, resource group ${RG}).`, type: 'output' },
      { text: 'Tickets arrive one at a time. Do the work with az commands, then type "submit". "hint" nudges, "skip" gives up.', type: 'output' },
      { text: 'Decisions carry over: later incidents run against the account exactly as you left it.', type: 'alert' },
      { text: 'SCRATCH: ~/scratch holds the lifecycle policy drafts. Edit files live in the panel under the terminal; "ls" lists them.', type: 'output' },
    ],
  };
  printTicket(g, writer(g));
  return g;
};

const writer =
  (g: Game): Out =>
  (text, type = 'output') =>
    g.history.push({ text, type });

function printTicket(g: Game, out: Out) {
  const t = TICKETS[g.ticket];
  out(`# ticket ${g.ticket + 1}/${TICKETS.length} · ${t.id} · ${t.title}`, 'heading');
  t.brief.forEach((l) => out(`  ${l}`));
}

function openTicket(g: Game, out: Out) {
  if (g.ticket >= TICKETS.length) return debrief(g, out);
  TICKETS[g.ticket].open?.(g, out); // incidents announce themselves before the brief
  printTicket(g, out);
}

function debrief(g: Game, out: Out) {
  const done = g.status.filter((s) => s === 'closed').length;
  const reopens = g.reopens.reduce((a, b) => a + b, 0);
  out('# shift over · debrief', 'heading');
  TICKETS.forEach((t, i) => {
    const ok = g.status[i] === 'closed';
    out(`  ${ok ? '[DONE]' : '[FAIL]'} ${t.id} ${t.title}${g.reopens[i] ? ` · reopened ${g.reopens[i]}×` : ''}`, ok ? 'success' : 'error');
  });
  out(
    `  closed ${done}/${TICKETS.length} · reopens ${reopens} · ${
      done === TICKETS.length ? (reopens === 0 ? 'FLAWLESS SHIFT.' : 'ALL CLOSED.') : done >= 6 ? 'ROUGH SHIFT.' : 'PAGER DUTY REVOKED.'
    }`,
    done === TICKETS.length ? 'success' : 'alert'
  );
  out('# what to take away', 'heading');
  TICKETS.forEach((t) => out(`  · ${t.lesson}`));
  out('Type "restart" to run the shift again.');
}

/** Reads `--flag value` / `-f value` pairs from a command line. */
const flagValue = (cmd: string, ...names: string[]): string | null => {
  const parts = splitWords(cmd);
  const idx = parts.findIndex((p) => names.includes(p));
  return idx >= 0 && parts[idx + 1] && !parts[idx + 1].startsWith('-') ? parts[idx + 1] : null;
};

const hasFlag = (cmd: string, name: string) => splitWords(cmd).includes(name);

const parseBool = (v: string | null): boolean | null => (v === 'true' ? true : v === 'false' ? false : null);

const blocked = (g: Game) => g.defaultAction === 'Deny' && !g.ipRules.includes(SHELL_IP);

const isPrivateIp = (o: number[]) => o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);

function sasToken(s: Sas): string {
  const parts: string[] = [];
  if (s.expiry) parts.push(`se=${s.expiry}T00%3A00%3A00Z`);
  if (s.policy) parts.push(`si=${s.policy}`);
  if (s.perms) parts.push(`sp=${s.perms}`);
  parts.push(`sv=${SAS_VERSION}`);
  if (s.kind === 'account') parts.push('ss=b', 'srt=sco');
  else parts.push('sr=c');
  if (s.kind === 'user')
    parts.push(`skoid=${ADMIN_OID}`, `sktid=72f988bf-86f1-41af-91ab-2d7cd011db47`, `skt=${TODAY}T00%3A00%3A00Z`, `ske=${s.expiry}T00%3A00%3A00Z`, 'sks=b', `skv=${SAS_VERSION}`);
  parts.push(`sig=${pseudoB64(s.id * 977 + 13, 43)}%3D`);
  return `"${parts.join('&')}"`;
}

const HELP_COMMANDS: [string, string][] = [
  ['help · clear · restart', 'This guide · flush output · start the shift over'],
  ['ticket · queue · hint', 'Reprint the open ticket · ticket status · a nudge for this ticket'],
  ['submit · skip', 'Hand the ticket in for checking · close it as failed'],
  ['ls · cat <file> · edit <file> · touch <file> · rm <file>', 'The ~/scratch folder: the lifecycle policy drafts live here. Files open in the editor below the terminal and save as you type'],
  ['<command> > <file>', 'Save a command\'s output into ~/scratch, e.g. az storage account management-policy show ... > mine.json'],
  [`az storage account show|update -n ${ACCOUNT} [--sku <sku>] [--default-action Allow|Deny]`, 'Account properties'],
  [`az storage account blob-service-properties show|update --account-name ${ACCOUNT} ...`, 'Soft delete: --enable-container-delete-retention, --container-delete-retention-days, --enable-delete-retention, --delete-retention-days, --enable-versioning'],
  [`az storage account keys list|renew --account-name ${ACCOUNT} [--key primary|secondary]`, 'Access keys'],
  [`az storage account revoke-delegation-keys -n ${ACCOUNT}`, 'Invalidate every user delegation SAS'],
  [`az storage account generate-sas --account-name ${ACCOUNT} --services b --resource-types sco --permissions <p> --expiry <date>`, 'Account SAS'],
  [`az storage account management-policy create|show --account-name ${ACCOUNT} [--policy @<file>]`, 'Lifecycle management'],
  [`az storage account network-rule add|remove|list --account-name ${ACCOUNT} [--ip-address <ip> | --vnet-name <v> --subnet <s>]`, 'Storage firewall'],
  ['az network vnet subnet show|update --vnet-name app-vnet -n app-subnet [--service-endpoints <svc>]', 'Subnet service endpoints'],
  [`az storage container list|restore --account-name ${ACCOUNT} [--include-deleted] [-n <c> --deleted-version <v>]`, 'Containers'],
  [`az storage container generate-sas -n <c> --account-name ${ACCOUNT} [--permissions <p>] [--expiry <date>] [--policy-name <p>] [--as-user --auth-mode login]`, 'Service or user delegation SAS'],
  [`az storage container policy create|update|delete|list -c <c> -n <policy> --account-name ${ACCOUNT} [--permissions <p>] [--expiry <date>]`, 'Stored access policies'],
  [`az storage blob list|show|download|set-tier -c <c> [-n <blob>] --account-name ${ACCOUNT} [--tier <t>] [--rehydrate-priority Standard|High]`, 'Blobs and access tiers'],
  [`az storage share-rm create|update|show|list --storage-account ${ACCOUNT} [-n <share>] [--quota <GiB>] [--access-tier <tier>]`, 'Azure Files shares'],
  ['az webapp|functionapp config appsettings set|list -n <app> -g apps-rg [--settings STORAGE_ACCOUNT_KEY=<value>]', 'App settings for payments-app (webapp) and backup-job (functionapp)'],
];

// ---- commands ----

/** What the shell layer needs from this lab. */
export const HOST: Host<Game> = { execute, prompt: () => PROMPT, cfg: SCRATCH };

/** Runs whatever was typed (one line or several) and returns the new game. */
export const runCommand = (prev: Game, text: string): Game => runShell(prev, text, HOST);

/** The bash prompt, e.g. user@host:~$. */
export const livePrompt = (g: Game): string => HOST.prompt(g);

function execute(prev: Game, raw: string, _echo: string | null): Game {
  // the drafts used to live in a policies/ folder: keep that spelling working
  const cmd = raw.trim().replace(/\s+/g, ' ').replace(/(\s|@)(\.\/)?policies\//g, '$1').trim();
  if (cmd === 'clear') return { ...prev, history: [] };
  if (cmd === 'restart') return initialGame();

  const g: Game = structuredClone(prev);
  const out = writer(g);
  // the shell layer prints the typed line; nothing to echo here

  const over = g.ticket >= TICKETS.length;
  const arg = (...names: string[]) => flagValue(cmd, ...names);
  const fail = (msg: string) => out(msg, 'error');
  const json = (v: unknown) => out(JSON.stringify(v, null, 2), 'success');

  const rgOk = (): boolean => {
    const rg = arg('--resource-group', '-g');
    if (rg && rg !== RG) {
      fail(`(ResourceGroupNotFound) Resource group '${rg}' could not be found.`);
      return false;
    }
    return true;
  };
  const account = (...names: string[]): boolean => {
    const n = arg(...names);
    if (!n) {
      fail(`ERR the following arguments are required: ${names[0]} (${ACCOUNT})`);
      return false;
    }
    if (n !== ACCOUNT) {
      fail(`(ResourceNotFound) The Resource 'Microsoft.Storage/storageAccounts/${n}' under resource group '${RG}' was not found.`);
      return false;
    }
    return rgOk();
  };
  /** Management plane: goes through ARM, unaffected by the storage firewall. */
  const mgmt = () => account('--account-name', '--name', '-n');
  /** Data plane: talks to the storage endpoint directly from Cloud Shell. */
  const data = (): boolean => {
    if (!account('--account-name')) return false;
    if (blocked(g)) {
      fail('(AuthorizationFailure) This request is not authorized to perform this operation.');
      out(`# the storage firewall denies Cloud Shell's IP (${SHELL_IP}). ARM management calls still work.`, 'heading');
      return false;
    }
    return true;
  };
  const issue = (s: Omit<Sas, 'id' | 'ticket'>) => {
    const sas: Sas = { ...s, id: g.sas.length + 1, ticket: g.ticket };
    g.sas.push(sas);
    out(sasToken(sas), 'success');
  };
  const validPerms = (p: string | null) => {
    if (p && !/^[racwdxltimeop]+$/.test(p)) {
      fail(`ERR invalid --permissions '${p}'. Use letters from: ${Object.keys(PERM_NAMES).join('')}`);
      return false;
    }
    return true;
  };
  const dateArg = (): { ok: boolean; value: string | null } => {
    const raw = arg('--expiry');
    const value = parseDate(raw);
    if (raw && !value) {
      fail(`ERR --expiry must be a UTC date such as ${PARTNER_DEADLINE} or ${PARTNER_DEADLINE}T00:00Z`);
      return { ok: false, value: null };
    }
    return { ok: true, value };
  };

  // ---- ticket flow ----
  if (cmd === 'help') {
    out('# names', 'heading');
    out(`  account ${ACCOUNT} · resource group ${RG} · containers invoices, logs, media, archive`);
    out('  vnet app-vnet / subnet app-subnet · apps payments-app, backup-job (resource group apps-rg)');
    out(`  today is ${TODAY} (UTC)`);
    out('# commands', 'heading');
    HELP_COMMANDS.forEach(([c, d]) => out(`  ${c}\n      ${d}`));
  } else if (cmd === 'ticket') {
    if (over) out('No open tickets. The shift is over; type "restart" to go again.');
    else printTicket(g, out);
  } else if (cmd === 'queue') {
    TICKETS.forEach((t, i) => {
      const s = i === g.ticket ? '▸ open' : g.status[i] === 'closed' ? '✓ done' : g.status[i] === 'skipped' ? '✗ fail' : '· queued';
      out(`  ${s.padEnd(9)}${t.id}  ${t.title}`, g.status[i] === 'closed' ? 'success' : g.status[i] === 'skipped' ? 'error' : 'output');
    });
  } else if (cmd === 'hint') {
    if (over) out('No open tickets.');
    else TICKETS[g.ticket].hint.forEach((l) => out(`  ${l}`, 'alert'));
  } else if (cmd === 'submit') {
    if (over) out('The shift is over. Type "restart" to go again.');
    else {
      const t = TICKETS[g.ticket];
      const errs = t.check(g);
      if (errs.length) {
        g.reopens[g.ticket]++;
        out(`REOPENED ${t.id}`, 'error');
        errs.forEach((e) => out(`  ✗ ${e}`, 'error'));
        out('  Fix it and "submit" again, or "skip" to close it as failed.');
      } else {
        out(`CLOSED ${t.id} · ${t.title}`, 'success');
        t.onPass?.(g, out);
        g.status[g.ticket] = 'closed';
        g.ticket++;
        openTicket(g, out);
      }
    }
  } else if (cmd === 'skip') {
    if (over) out('The shift is over. Type "restart" to go again.');
    else {
      out(`SKIPPED ${TICKETS[g.ticket].id}: logged as failed.`, 'error');
      g.status[g.ticket] = 'skipped';
      g.ticket++;
      openTicket(g, out);
    }
  } else if (scratchCommand(g, out, cmd, SCRATCH)) {
    // ls, cat, edit, touch, rm: handled by the scratch module

    // ---- storage account (management plane) ----
  } else if (cmd.startsWith('az storage account generate-sas')) {
    const perms = arg('--permissions');
    const { ok, value: expiry } = dateArg();
    if (!account('--account-name') || !ok || !validPerms(perms)) return g;
    if (!perms || !expiry || !arg('--services') || !arg('--resource-types'))
      fail('ERR the following arguments are required: --permissions, --expiry, --services, --resource-types');
    else {
      out('There are no credentials provided in your command and environment, we will query for account key for your storage account.');
      issue({ kind: 'account', container: null, perms, expiry, policy: null, key: 'key1', keyVersion: g.keys.key1.version, udEpoch: g.udEpoch });
    }
  } else if (cmd.startsWith('az storage account keys list')) {
    if (mgmt()) json((['key1', 'key2'] as KeyName[]).map((k) => ({ creationTime: TODAY, keyName: k, permissions: 'FULL', value: g.keys[k].value })));
  } else if (cmd.startsWith('az storage account keys renew')) {
    const which = arg('--key');
    const k: KeyName | null = which === 'primary' || which === 'key1' ? 'key1' : which === 'secondary' || which === 'key2' ? 'key2' : null;
    if (!k) fail('ERR --key is required: primary | secondary');
    else if (mgmt()) {
      const old = g.keys[k].value;
      g.keys[k] = { value: keyValue(k, g.keys[k].version + 1), version: g.keys[k].version + 1 };
      json((['key1', 'key2'] as KeyName[]).map((x) => ({ keyName: x, permissions: 'FULL', value: g.keys[x].value })));
      out(`# every SAS signed with the old ${k} is now invalid`, 'heading');
      for (const app of APP_IDS)
        if (g.apps[app] === old) out(`!! ${app}: (AuthenticationFailed) Server failed to authenticate the request. ${app} is DOWN.`, 'error');
    }
  } else if (cmd.startsWith('az storage account revoke-delegation-keys')) {
    if (mgmt()) {
      g.udEpoch++;
      out('OK  All user delegation keys for the account are revoked. Every user delegation SAS signed with them is now invalid.', 'success');
    }
  } else if (cmd.startsWith('az storage account blob-service-properties show')) {
    if (mgmt())
      json({
        containerDeleteRetentionPolicy: { enabled: g.containerRetention !== null, days: g.containerRetention },
        deleteRetentionPolicy: { allowPermanentDelete: false, enabled: g.blobRetention !== null, days: g.blobRetention },
        isVersioningEnabled: g.versioning,
      });
  } else if (cmd.startsWith('az storage account blob-service-properties update')) {
    if (!mgmt()) return g;
    const enC = parseBool(arg('--enable-container-delete-retention'));
    const daysC = arg('--container-delete-retention-days');
    const enB = parseBool(arg('--enable-delete-retention'));
    const daysB = arg('--delete-retention-days');
    const ver = parseBool(arg('--enable-versioning'));
    const badDays = [daysC, daysB].find((d) => d !== null && !(Number.isInteger(Number(d)) && Number(d) >= 1 && Number(d) <= 365));
    if (enC === null && daysC === null && enB === null && daysB === null && ver === null) {
      fail('ERR nothing to update. Flags: --enable-container-delete-retention true|false, --container-delete-retention-days <1-365>, --enable-delete-retention true|false, --delete-retention-days <1-365>, --enable-versioning true|false');
    } else if (badDays !== undefined) {
      fail(`ERR retention days must be an integer from 1 to 365 (got '${badDays}')`);
    } else if (daysC !== null && enC !== true && g.containerRetention === null) {
      fail('ERR container delete retention is disabled. Enable it with --enable-container-delete-retention true');
    } else if (daysB !== null && enB !== true && g.blobRetention === null) {
      fail('ERR blob delete retention is disabled. Enable it with --enable-delete-retention true');
    } else {
      if (enC === false) g.containerRetention = null;
      else if (enC === true || daysC !== null) g.containerRetention = daysC !== null ? Number(daysC) : (g.containerRetention ?? 7);
      if (enB === false) g.blobRetention = null;
      else if (enB === true || daysB !== null) g.blobRetention = daysB !== null ? Number(daysB) : (g.blobRetention ?? 7);
      if (ver !== null) g.versioning = ver;
      json({
        containerDeleteRetentionPolicy: { enabled: g.containerRetention !== null, days: g.containerRetention },
        deleteRetentionPolicy: { enabled: g.blobRetention !== null, days: g.blobRetention },
        isVersioningEnabled: g.versioning,
      });
    }
  } else if (cmd.startsWith('az storage account management-policy create')) {
    const p = arg('--policy');
    if (!p) fail('ERR the following arguments are required: --policy (@<file>)');
    else if (!mgmt()) return g;
    else if (!isFileRef(p)) fail('ERR --policy expects @<file>, a JSON file from ~/scratch (type ls). Edit it in the panel under the terminal.');
    else {
      const parsed = readScratchJson(g, out, p);
      if (!parsed) return g;
      const invalid = validatePolicy(parsed.value);
      if (invalid) {
        fail(invalid);
        return g;
      }
      g.lifecycle = parsed.name;
      g.lifecycleDoc = parsed.value;
      json({ id: `${ACCOUNT_ID}/managementPolicies/default`, name: 'DefaultManagementPolicy', policy: parsed.value });
      out('# one policy per account: this replaced any previous one. Rules run about once a day, so allow up to 24h to act.', 'heading');
    }
  } else if (cmd.startsWith('az storage account management-policy show')) {
    if (mgmt()) {
      if (g.lifecycleDoc) json({ name: 'DefaultManagementPolicy', policy: g.lifecycleDoc });
      else fail(`(ManagementPolicyNotFound) No ManagementPolicy found for account ${ACCOUNT}`);
    }
  } else if (/^az storage account network-rule (add|remove)\b/.test(cmd)) {
    const adding = cmd.includes('network-rule add');
    const ip = arg('--ip-address');
    const vnet = arg('--vnet-name');
    const subnet = arg('--subnet');
    if (!ip && !(vnet && subnet)) return (fail('ERR specify --ip-address <ip>, or --vnet-name <vnet> --subnet <subnet>'), g);
    if (!mgmt()) return g;
    let err: string | null = null;
    if (ip) {
      const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
      const octets = m ? m.slice(1, 5).map(Number) : [];
      if (!adding) {
        if (!g.ipRules.includes(ip)) err = `ERR no IP rule for '${ip}'`;
        else g.ipRules = g.ipRules.filter((x) => x !== ip);
      } else if (!m || octets.some((o) => o > 255) || (m[5] !== undefined && Number(m[5]) > 32)) err = `ERR '${ip}' is not a valid IPv4 address or CIDR range`;
      else if (m[5] === '31' || m[5] === '32') err = `ERR /31 and /32 ranges are not supported in storage IP rules. Add the address on its own: --ip-address ${m.slice(1, 5).join('.')}`;
      else if (isPrivateIp(octets)) err = 'ERR IP rules take public addresses only. Private (RFC 1918) ranges have to come in through a virtual network rule or a private endpoint.';
      else if (!g.ipRules.includes(ip)) g.ipRules = [...g.ipRules, ip];
    } else if (vnet !== 'app-vnet' || subnet !== 'app-subnet') {
      err = `(NotFound) Subnet '${subnet}' in virtual network '${vnet}' was not found.`;
    } else if (!adding) {
      g.subnetRule = false;
    } else if (!g.serviceEndpoint) {
      err = "(NetworkAclsValidationFailure) Subnet 'app-subnet' of virtual network 'app-vnet' does not have the Microsoft.Storage service endpoint enabled. Add it to the subnet before creating the rule.";
    } else g.subnetRule = true;
    if (err) fail(err);
    else printNetwork(g, json);
  } else if (cmd.startsWith('az storage account network-rule list')) {
    if (mgmt()) printNetwork(g, json);
  } else if (cmd.startsWith('az storage account show')) {
    if (mgmt())
      json({
        name: ACCOUNT,
        resourceGroup: RG,
        kind: 'StorageV2',
        sku: { name: g.sku, tier: 'Standard' },
        primaryLocation: 'eastus',
        secondaryLocation: geo(g.sku) ? 'westus' : null,
        statusOfSecondary: geo(g.sku) ? 'available' : null,
        secondaryEndpoints: readableSecondary(g.sku) ? { blob: `https://${ACCOUNT}-secondary.blob.core.windows.net/` } : null,
        networkRuleSet: networkRuleSet(g),
      });
  } else if (cmd.startsWith('az storage account update')) {
    if (!mgmt()) return g;
    const skuArg = arg('--sku');
    const da = arg('--default-action');
    const sku = SKUS.find((s) => s.toLowerCase() === skuArg?.toLowerCase());
    const action = da === 'Allow' || da === 'Deny' ? da : null;
    if (!skuArg && !da) fail('ERR nothing to update. Flags: --sku <sku>, --default-action Allow|Deny');
    else if (skuArg && !sku) fail(`ERR invalid --sku '${skuArg}'. Allowed: ${SKUS.join(', ')}`);
    else if (da && !action) fail("ERR --default-action must be 'Allow' or 'Deny'");
    else if (sku?.startsWith('Premium'))
      fail(`ERR ${ACCOUNT} is a Standard account and cannot change performance tier to ${sku}. Create a new premium account and copy the data.`);
    else if (sku && zoned(sku) !== zoned(g.sku))
      fail(
        `ERR ${g.sku} -> ${sku} ${zoned(sku) ? 'adds' : 'removes'} zone redundancy. That is a conversion (az storage account migration start, or manual migration), not a SKU update, and it is not simulated here. This ticket does not need zones.`
      );
    else {
      const wasGeo = geo(g.sku);
      if (sku) g.sku = sku;
      if (action) g.defaultAction = action;
      json({ name: ACCOUNT, sku: { name: g.sku, tier: 'Standard' }, networkRuleSet: networkRuleSet(g) });
      if (sku && geo(sku) && !wasGeo) out('# geo-replication to westus enabled; initial sync to the secondary has started', 'heading');
      if (action === 'Deny') {
        out('# public endpoint now denies everything not matched by a network rule (trusted Azure services still bypass)', 'heading');
        for (const app of APP_IDS) if (appProblem(g, app) === 'firewalled') out(`!! ${app}: (AuthorizationFailure) request from app-subnet denied by the storage firewall. ${app} is DOWN.`, 'error');
      }
    }

    // ---- network ----
  } else if (/^az network vnet subnet (update|show)\b/.test(cmd)) {
    const vnet = arg('--vnet-name');
    const name = arg('--name', '-n');
    const endpoints = arg('--service-endpoints');
    if (!vnet || !name) fail('ERR the following arguments are required: --vnet-name, --name/-n');
    else if (!rgOk()) return g;
    else if (vnet !== 'app-vnet' || name !== 'app-subnet') fail(`(NotFound) Subnet '${name}' in virtual network '${vnet}' was not found.`);
    else {
      if (cmd.includes('subnet update')) {
        if (!endpoints) return (fail('ERR nothing to update. Flag: --service-endpoints <service>'), g);
        g.serviceEndpoint = /^microsoft\.storage(\.global)?$/i.test(endpoints);
        if (!g.serviceEndpoint && g.subnetRule) out('# app-subnet no longer has the Microsoft.Storage endpoint; its storage firewall rule stops matching', 'heading');
      }
      json({
        addressPrefix: '10.20.1.0/24',
        id: SUBNET_ID,
        name: 'app-subnet',
        serviceEndpoints: g.serviceEndpoint ? [{ locations: ['eastus', 'westus'], provisioningState: 'Succeeded', service: 'Microsoft.Storage' }] : [],
      });
    }

    // ---- containers (data plane) ----
  } else if (cmd.startsWith('az storage container generate-sas')) {
    const name = arg('--name', '-n');
    const perms = arg('--permissions');
    const policy = arg('--policy-name');
    const { ok, value: expiry } = dateArg();
    if (!name) return (fail('ERR the following arguments are required: --name/-n (container)'), g);
    if (!account('--account-name') || !ok || !validPerms(perms)) return g;
    if (hasFlag(cmd, '--as-user')) {
      if (arg('--auth-mode') !== 'login') fail('ERR --as-user requires --auth-mode login');
      else if (policy) fail('ERR a user delegation SAS cannot reference a stored access policy');
      else if (!perms || !expiry) fail('ERR --permissions and --expiry are required for a user delegation SAS');
      else if (expiry <= TODAY) fail(`ERR --expiry must be in the future (today is ${TODAY})`);
      else if (expiry > PARTNER_DEADLINE) fail(`ERR a user delegation key is valid for at most 7 days, so --expiry must be on or before ${PARTNER_DEADLINE}`);
      else if (data()) issue({ kind: 'user', container: name, perms, expiry, policy: null, key: null, keyVersion: 0, udEpoch: g.udEpoch });
    } else if (!policy && (!perms || !expiry)) {
      fail('ERR --permissions and --expiry are required unless a --policy-name supplies them');
    } else {
      const given = arg('--account-key');
      const key = given ? (['key1', 'key2'] as KeyName[]).find((k) => g.keys[k].value === given) : 'key1';
      if (!key) return (fail(`ERR --account-key does not match a current key of ${ACCOUNT}`), g);
      if (!given) out('There are no credentials provided in your command and environment, we will query for account key for your storage account.');
      issue({ kind: 'service', container: name, perms, expiry, policy, key, keyVersion: g.keys[key].version, udEpoch: g.udEpoch });
    }
  } else if (cmd.startsWith('az storage container policy')) {
    const sub = cmd.split(' ')[4];
    const c = arg('--container-name', '-c');
    const name = arg('--name', '-n');
    const perms = arg('--permissions');
    const { ok, value: expiry } = dateArg();
    if (!['create', 'update', 'delete', 'list', 'show'].includes(sub)) return (fail('ERR usage: az storage container policy create|update|delete|list|show'), g);
    if (!c || (sub !== 'list' && !name)) return (fail(`ERR the following arguments are required: --container-name/-c${sub === 'list' ? '' : ', --name/-n'}`), g);
    if (!ok || !validPerms(perms) || !data()) return g;
    if (!liveContainer(g, c)) return (fail('(ContainerNotFound) The specified container does not exist.'), g);
    const list = (g.policies[c] ??= []);
    const existing = list.find((p) => p.name === name);
    const show = (p: AccessPolicy) => ({ expiry: p.expiry ? `${p.expiry}T00:00:00+00:00` : null, permission: p.perms, start: null });
    if (sub === 'list') json(Object.fromEntries(list.map((p) => [p.name, show(p)])));
    else if (sub === 'create') {
      if (existing) fail(`ERR Policy with name '${name}' already exists.`);
      else if (list.length >= 5) fail('ERR a container can have at most 5 stored access policies');
      else {
        const p: AccessPolicy = { name: name!, perms, expiry };
        list.push(p);
        json(show(p));
      }
    } else if (!existing) fail(`ERR Policy with name '${name}' not found.`);
    else if (sub === 'show') json(show(existing));
    else if (sub === 'delete') {
      g.policies[c] = list.filter((p) => p !== existing);
      out(`OK  Stored access policy '${name}' deleted from ${c}.`, 'success');
      out('# every SAS bound to it is rejected from now on (allow up to 30 seconds to take effect)', 'heading');
    } else {
      if (!perms && !expiry) return (fail('ERR nothing to update. Flags: --permissions, --expiry'), g);
      if (perms) existing.perms = perms;
      if (expiry) existing.expiry = expiry;
      json(show(existing));
      out('# the change applies to every SAS bound to this policy (allow up to 30 seconds)', 'heading');
    }
  } else if (cmd.startsWith('az storage container list')) {
    if (data()) {
      const incl = hasFlag(cmd, '--include-deleted');
      out(`${'Name'.padEnd(12)}${'Deleted'.padEnd(10)}Version`, 'heading');
      g.containers
        .filter((c) => incl || !c.deletedVersion)
        .forEach((c) => out(`${c.name.padEnd(12)}${(c.deletedVersion ? 'True' : 'False').padEnd(10)}${c.deletedVersion ?? ''}`));
    }
  } else if (cmd.startsWith('az storage container restore')) {
    const name = arg('--name', '-n');
    const version = arg('--deleted-version');
    if (!name || !version) fail('ERR the following arguments are required: --name/-n, --deleted-version');
    else if (data()) {
      const c = g.containers.find((x) => x.name === name && x.deletedVersion === version);
      if (liveContainer(g, name)) fail('(ContainerAlreadyExists) The specified container already exists.');
      else if (!c) fail('(ContainerNotFound) The specified container does not exist.');
      else {
        c.deletedVersion = null;
        json({ containerName: name, version });
      }
    }

    // ---- blobs (data plane) ----
  } else if (/^az storage blob (list|show|download|set-tier)\b/.test(cmd)) {
    const sub = cmd.split(' ')[3];
    const cName = arg('--container-name', '-c');
    const name = arg('--name', '-n');
    if (!cName || (sub !== 'list' && !name)) return (fail(`ERR the following arguments are required: --container-name/-c${sub === 'list' ? '' : ', --name/-n'}`), g);
    if (!data()) return g;
    const c = liveContainer(g, cName);
    if (!c) return (fail('(ContainerNotFound) The specified container does not exist.'), g);
    if (sub === 'list') {
      out(`${'Name'.padEnd(26)}${'Blob Tier'.padEnd(11)}Length`, 'heading');
      c.blobs.forEach((b) => out(`${b.name.padEnd(26)}${b.tier.padEnd(11)}${b.size}`));
      return g;
    }
    const b = c.blobs.find((x) => x.name === name);
    if (!b) return (fail('(BlobNotFound) The specified blob does not exist.'), g);
    if (sub === 'show') {
      json({
        container: cName,
        name: b.name,
        properties: {
          blobTier: b.tier,
          archiveStatus: b.rehydrate ? `rehydrate-pending-to-${b.rehydrate.to.toLowerCase()}` : null,
          rehydratePriority: b.rehydrate?.priority ?? null,
          contentLength: b.size,
        },
      });
    } else if (sub === 'download') {
      if (!arg('--file', '-f')) fail('ERR the following arguments are required: --file/-f');
      else if (b.tier === 'Archive') {
        fail('(BlobArchived) This operation is not permitted on an archived blob.');
        if (b.rehydrate) out(`# rehydration to ${b.rehydrate.to} is pending at ${b.rehydrate.priority} priority`, 'heading');
      } else out(`Finished[#############################################################]  100.0000%  (${b.size})`, 'success');
    } else {
      const tierArg = arg('--tier');
      const prioArg = arg('--rehydrate-priority');
      const tier = (['Hot', 'Cool', 'Cold', 'Archive'] as BlobTier[]).find((t) => t.toLowerCase() === tierArg?.toLowerCase());
      const prio = prioArg === null ? 'Standard' : prioArg.toLowerCase() === 'high' ? 'High' : prioArg.toLowerCase() === 'standard' ? 'Standard' : null;
      if (!tier) fail('ERR --tier is required: Hot | Cool | Cold | Archive');
      else if (!prio) fail('ERR --rehydrate-priority must be Standard or High');
      else if (b.rehydrate) {
        if (tier === b.rehydrate.to && prio === 'High' && b.rehydrate.priority === 'Standard') {
          b.rehydrate.priority = 'High';
          out(`OK  pending rehydration raised to High priority (archive-status: rehydrate-pending-to-${tier.toLowerCase()})`, 'success');
        } else fail('(BlobBeingRehydrated) This operation is not permitted because the blob is being rehydrated.');
      } else if (b.tier === 'Archive' && tier !== 'Archive') {
        b.rehydrate = { to: tier, priority: prio };
        out(`OK  rehydration started (archive-status: rehydrate-pending-to-${tier.toLowerCase()}, priority ${prio})`, 'success');
        out(prio === 'High' ? '# High priority: usually under 1 hour for blobs under 10 GB' : '# Standard priority: can take up to 15 hours', 'heading');
      } else {
        b.tier = tier;
        out(`OK  ${b.name} is now ${tier}${tier === 'Archive' ? ' (offline; 180-day minimum storage duration)' : ''}`, 'success');
      }
    }

    // ---- Azure Files ----
  } else if (/^az storage share-rm (create|update|show|list)\b/.test(cmd)) {
    const sub = cmd.split(' ')[3];
    const name = arg('--name', '-n');
    const quotaArg = arg('--quota', '-q');
    const tierArg = arg('--access-tier');
    if (sub !== 'list' && !name) return (fail('ERR the following arguments are required: --name/-n'), g);
    if (!account('--storage-account')) return g;
    const tier = (['TransactionOptimized', 'Hot', 'Cool'] as ShareTier[]).find((t) => t.toLowerCase() === tierArg?.toLowerCase());
    const quota = quotaArg === null ? null : Number(quotaArg);
    const share = name ? g.shares[name] : undefined;
    const show = (n: string) => ({ name: n, accessTier: g.shares[n].tier, enabledProtocols: 'SMB', shareQuota: g.shares[n].quota });
    if (tierArg && !tier)
      fail(tierArg.toLowerCase() === 'premium' ? 'ERR Premium shares need a FileStorage (premium) account.' : 'ERR --access-tier must be TransactionOptimized, Hot or Cool');
    else if (quota !== null && !(Number.isInteger(quota) && quota >= 1 && quota <= 5120)) fail('ERR --quota must be an integer from 1 to 5120 (GiB)');
    else if (sub === 'list') json(Object.keys(g.shares).map(show));
    else if (sub === 'create') {
      if (share) fail('(ShareAlreadyExists) The specified share already exists.');
      else {
        g.shares[name!] = { quota: quota ?? 5120, tier: tier ?? 'TransactionOptimized' };
        json(show(name!));
      }
    } else if (!share) fail('(ShareNotFound) The specified share does not exist.');
    else if (sub === 'show') json(show(name!));
    else if (quota === null && !tier) fail('ERR nothing to update. Flags: --quota <GiB>, --access-tier <tier>');
    else {
      if (quota !== null) share.quota = quota;
      if (tier) share.tier = tier;
      json(show(name!));
    }
  } else if (cmd.startsWith('az storage share create')) {
    const name = arg('--name', '-n');
    const quotaArg = arg('--quota', '-q');
    const quota = quotaArg === null ? 5120 : Number(quotaArg);
    if (!name) fail('ERR the following arguments are required: --name/-n');
    else if (!(Number.isInteger(quota) && quota >= 1 && quota <= 5120)) fail('ERR --quota must be an integer from 1 to 5120 (GiB)');
    else if (data()) {
      if (g.shares[name]) fail('(ShareAlreadyExists) The specified share already exists.');
      else {
        g.shares[name] = { quota, tier: 'TransactionOptimized' };
        json({ created: true });
        out('# data-plane create: tier defaults to TransactionOptimized (change it with az storage share-rm update --access-tier)', 'heading');
      }
    }

    // ---- consumers ----
  } else if (/^az (webapp|functionapp) config appsettings (set|list)\b/.test(cmd)) {
    const [, kind, , , sub] = cmd.split(' ');
    const name = arg('--name', '-n');
    const app = APP_IDS.find((a) => a === name && APPS[a].kind === kind);
    const rg = arg('--resource-group', '-g');
    if (!name) fail('ERR the following arguments are required: --name/-n');
    else if (rg && rg !== 'apps-rg') fail(`(ResourceGroupNotFound) Resource group '${rg}' could not be found.`);
    else if (!app) fail(`(ResourceNotFound) ${kind === 'webapp' ? 'Web app' : 'Function app'} '${name}' was not found. (payments-app is a webapp, backup-job a functionapp)`);
    else if (sub === 'list') json([{ name: 'STORAGE_ACCOUNT_NAME', value: ACCOUNT }, { name: 'STORAGE_ACCOUNT_KEY', value: g.apps[app] }]);
    else {
      const m = cmd.match(/STORAGE_ACCOUNT_KEY=(\S+)/);
      if (!m) fail('ERR usage: --settings STORAGE_ACCOUNT_KEY=<key value>');
      else {
        g.apps[app] = m[1];
        json([{ name: 'STORAGE_ACCOUNT_KEY', slotSetting: false, value: m[1] }]);
        const k = keyInUse(g, app);
        out(k ? `# ${app} now authenticates with ${k}` : `!! that value matches neither current key. ${app} is DOWN.`, k ? 'heading' : 'error');
      }
    }
  } else if (cmd.startsWith('az ')) {
    fail(`ERR '${cmd.split(' ').slice(0, 4).join(' ')}' is not part of this drill. Type "help" for the supported commands.`);
  } else {
    fail(`bash: ${cmd.split(' ')[0]}: command not recognized. Type "help" for usage.`);
  }
  return g;
}

function networkRuleSet(g: Game) {
  return {
    bypass: 'AzureServices',
    defaultAction: g.defaultAction,
    ipRules: g.ipRules.map((ip) => ({ action: 'Allow', ipAddressOrRange: ip })),
    virtualNetworkRules: g.subnetRule ? [{ action: 'Allow', state: 'Succeeded', virtualNetworkResourceId: SUBNET_ID }] : [],
  };
}

function printNetwork(g: Game, json: (v: unknown) => void) {
  const { ipRules, virtualNetworkRules } = networkRuleSet(g);
  json({ ipRules, virtualNetworkRules });
}

// ---- UI ----

