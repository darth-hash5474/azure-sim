// Az PowerShell cmdlets for Cold Storage, mapped onto the az commands the lab already simulates.
import { isObj, pascalKeys, toStr, type Build, type CmdletTable } from './shellcore';

const s = toStr;
const ACCT = 'contosodata';
const RG = 'data-rg';

const base = (a: Record<string, unknown>) => ['--account-name', s(a.name ?? a.storageaccountname ?? ACCT), '-g', s(a.resourcegroupname ?? RG)];
const ACCOUNT_PARAMS = ['ResourceGroupName|ResourceGroup', 'Name|AccountName|StorageAccountName'];
const bool = (v: unknown) => (v === true || String(v).toLowerCase() === 'true' ? 'true' : 'false');

const policyArg = (p: unknown): string | null => {
  if (isObj(p) || Array.isArray(p)) return JSON.stringify(p);
  const t = s(p).trim();
  if (!t) return null;
  return t.startsWith('{') ? t : `@${t.replace(/^@/, '')}`;
};

const retention = (a: Record<string, unknown>, kind: 'blob' | 'container'): Build => {
  const days = a.retentiondays;
  if (days === undefined) return { error: 'Provide -RetentionDays (1-365).' };
  const f = kind === 'blob' ? ['--enable-delete-retention', 'true', '--delete-retention-days'] : ['--enable-container-delete-retention', 'true', '--container-delete-retention-days'];
  return { az: ['storage', 'account', 'blob-service-properties', 'update', ...base(a), ...f, s(days)], json: true, shape: pascalKeys };
};

export const CMDLETS: CmdletTable = {
  'Get-AzStorageAccount': {
    params: ACCOUNT_PARAMS,
    build: (a) => ({ az: ['storage', 'account', 'show', ...base(a)], json: true, shape: pascalKeys }),
  },
  'Set-AzStorageAccount': {
    params: [...ACCOUNT_PARAMS, 'SkuName', 'NetworkRuleSet', 'DefaultAction'],
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => {
      const da = a.defaultaction ?? (isObj(a.networkruleset) ? (a.networkruleset as Record<string, unknown>).DefaultAction ?? (a.networkruleset as Record<string, unknown>).defaultAction : undefined);
      return {
        az: ['storage', 'account', 'update', ...base(a), ...(a.skuname ? ['--sku', s(a.skuname)] : []), ...(da ? ['--default-action', s(da)] : [])],
        json: true,
        shape: pascalKeys,
      };
    },
  },
  'Update-AzStorageAccountNetworkRuleSet': {
    params: [...ACCOUNT_PARAMS, 'DefaultAction', 'Bypass'],
    mandatory: ['ResourceGroupName', 'Name', 'DefaultAction'],
    build: (a) => ({ az: ['storage', 'account', 'update', ...base(a), '--default-action', s(a.defaultaction)], json: true, shape: pascalKeys }),
  },
  'Get-AzStorageAccountNetworkRuleSet': {
    params: ACCOUNT_PARAMS,
    build: (a) => ({ az: ['storage', 'account', 'network-rule', 'list', ...base(a)], json: true, shape: pascalKeys }),
  },
  'Add-AzStorageAccountNetworkRule': {
    params: [...ACCOUNT_PARAMS, 'IPAddressOrRange', 'VirtualNetworkResourceId'],
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => networkRule(a, 'add'),
  },
  'Remove-AzStorageAccountNetworkRule': {
    params: [...ACCOUNT_PARAMS, 'IPAddressOrRange', 'VirtualNetworkResourceId'],
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => networkRule(a, 'remove'),
  },
  'Get-AzStorageAccountKey': {
    params: ACCOUNT_PARAMS,
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => ({ az: ['storage', 'account', 'keys', 'list', ...base(a)], json: true, shape: pascalKeys }),
  },
  'New-AzStorageAccountKey': {
    params: [...ACCOUNT_PARAMS, 'KeyName'],
    mandatory: ['ResourceGroupName', 'Name', 'KeyName'],
    build: (a) => ({ az: ['storage', 'account', 'keys', 'renew', ...base(a), '--key', s(a.keyname).toLowerCase() === 'key2' ? 'secondary' : s(a.keyname).toLowerCase() === 'key1' ? 'primary' : s(a.keyname)], json: true, shape: pascalKeys }),
  },
  'Revoke-AzStorageAccountUserDelegationKeys': {
    params: ACCOUNT_PARAMS,
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => ({ az: ['storage', 'account', 'revoke-delegation-keys', ...base(a)] }),
  },
  'New-AzStorageAccountSASToken': {
    params: ['Service', 'ResourceType', 'Permission', 'ExpiryTime', 'Context|AccountName'],
    mandatory: ['Service', 'ResourceType', 'Permission', 'ExpiryTime'],
    build: (a) => ({
      az: ['storage', 'account', 'generate-sas', '--account-name', ACCT, '--services', s(a.service).toLowerCase().replace('blob', 'b').replace('file', 'f'), '--resource-types', s(a.resourcetype).toLowerCase().replace(/service/, 's').replace(/container/, 'c').replace(/object/, 'o').replace(/[, ]/g, ''), '--permissions', s(a.permission), '--expiry', s(a.expirytime)],
    }),
  },
  'Enable-AzStorageBlobDeleteRetentionPolicy': {
    params: [...ACCOUNT_PARAMS, 'RetentionDays'],
    mandatory: ['ResourceGroupName', 'Name', 'RetentionDays'],
    build: (a) => retention(a, 'blob'),
  },
  'Enable-AzStorageContainerDeleteRetentionPolicy': {
    params: [...ACCOUNT_PARAMS, 'RetentionDays'],
    mandatory: ['ResourceGroupName', 'Name', 'RetentionDays'],
    build: (a) => retention(a, 'container'),
  },
  'Get-AzStorageBlobServiceProperty': {
    params: ACCOUNT_PARAMS,
    build: (a) => ({ az: ['storage', 'account', 'blob-service-properties', 'show', ...base(a)], json: true, shape: pascalKeys }),
  },
  'Update-AzStorageBlobServiceProperty': {
    params: [...ACCOUNT_PARAMS, 'IsVersioningEnabled'],
    mandatory: ['ResourceGroupName', 'Name', 'IsVersioningEnabled'],
    build: (a) => ({ az: ['storage', 'account', 'blob-service-properties', 'update', ...base(a), '--enable-versioning', bool(a.isversioningenabled)], json: true, shape: pascalKeys }),
  },
  'Set-AzStorageAccountManagementPolicy': {
    params: [...ACCOUNT_PARAMS, 'Policy'],
    mandatory: ['ResourceGroupName', 'Name', 'Policy'],
    build: (a) => {
      const p = policyArg(a.policy);
      if (!p) return { error: '-Policy takes a policy object, a JSON string, or the name of a JSON file in ~/scratch.' };
      return { az: ['storage', 'account', 'management-policy', 'create', ...base(a), '--policy', p], json: true, shape: pascalKeys };
    },
  },
  'Get-AzStorageAccountManagementPolicy': {
    params: ACCOUNT_PARAMS,
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => ({ az: ['storage', 'account', 'management-policy', 'show', ...base(a)], json: true, shape: pascalKeys }),
  },
  'Get-AzStorageContainer': {
    params: ['Name', 'IncludeDeleted'],
    switches: ['IncludeDeleted'],
    build: (a) => ({ az: ['storage', 'container', 'list', '--account-name', ACCT, ...(a.includedeleted ? ['--include-deleted'] : [])], json: true, shape: pascalKeys }),
  },
};

function networkRule(a: Record<string, unknown>, op: 'add' | 'remove'): Build {
  const ip = a.ipaddressorrange;
  if (ip !== undefined) return { az: ['storage', 'account', 'network-rule', op, ...base(a), '--ip-address', s(ip)], json: true, shape: pascalKeys };
  const vid = a.virtualnetworkresourceid;
  if (vid === undefined) return { error: 'Provide -IPAddressOrRange or -VirtualNetworkResourceId.' };
  const m = s(vid).match(/virtualNetworks\/([^/]+)\/subnets\/([^/]+)/i);
  if (!m) return { error: '-VirtualNetworkResourceId must end in /virtualNetworks/<vnet>/subnets/<subnet>.' };
  return { az: ['storage', 'account', 'network-rule', op, ...base(a), '--vnet-name', m[1], '--subnet', m[2]], json: true, shape: pascalKeys };
}
