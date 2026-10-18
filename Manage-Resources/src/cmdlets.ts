// Az PowerShell cmdlets for Manage Resources, mapped onto the az commands the lab already simulates.
import { isObj, pascalKeys, tagWords, toList, toStr, type Build, type CmdletTable } from './shellcore';

const s = toStr;

/** Az resource objects carry ResourceId / ResourceGroupName / ResourceType next to the raw ARM names. */
const asResource = (v: unknown): unknown =>
  toList(pascalKeys(v)).map((r) => (isObj(r) ? Object.assign(r, { ResourceId: r.Id, ResourceGroupName: r.ResourceGroup, ResourceType: r.Type }) : r));

const tagsOf = (v: unknown): string[] => (v === undefined ? [] : ['--tags', ...tagWords(v)]);

const groupTags = (op: 'create' | 'update', a: Record<string, unknown>): Build => {
  if (a.tag !== undefined && !isObj(a.tag)) return { error: '-Tag takes a hashtable, e.g. @{ CostCenter = "2210" }.' };
  return {
    az: ['group', op, '-n', s(a.name), ...(op === 'create' ? ['-l', s(a.location)] : []), ...tagsOf(a.tag)],
    json: true,
    shape: pascalKeys,
  };
};

export const CMDLETS: CmdletTable = {
  'Connect-AzAccount': {
    params: ['AccountId|Username|UserName', 'Subscription'],
    positional: ['AccountId'],
    mandatory: ['AccountId'],
    build: (a) => ({ az: ['login', '--username', s(a.accountid)] }),
  },
  'Get-AzContext': {
    params: [],
    build: () => ({ az: ['account', 'show'], json: true, shape: pascalKeys }),
  },
  'Get-AzRoleAssignment': {
    params: [],
    build: () => ({ az: ['role', 'assignment', 'list'], json: true, shape: pascalKeys }),
  },
  'Get-AzResourceGroup': {
    params: ['Name|ResourceGroupName'],
    positional: ['Name'],
    build: (a) => (a.name ? { az: ['group', 'show', '-n', s(a.name)], json: true, shape: pascalKeys } : { az: ['group', 'list'], json: true, shape: pascalKeys }),
  },
  'New-AzResourceGroup': {
    params: ['Name', 'Location', 'Tag'],
    positional: ['Name', 'Location'],
    mandatory: ['Name', 'Location'],
    build: (a) => groupTags('create', a),
  },
  'Set-AzResourceGroup': {
    params: ['Name', 'Tag'],
    positional: ['Name'],
    mandatory: ['Name', 'Tag'],
    build: (a) => groupTags('update', a),
  },
  'Remove-AzResourceGroup': {
    params: ['Name'],
    switches: ['Force'],
    positional: ['Name'],
    mandatory: ['Name'],
    build: (a) => ({ az: ['group', 'delete', '-n', s(a.name), ...(a.force ? ['--yes'] : [])] }),
  },
  'Get-AzResource': {
    params: ['ResourceGroupName', 'Name', 'ResourceId', 'TagName', 'TagValue'],
    build: (a) => {
      const tag = a.tagname !== undefined ? (a.tagvalue !== undefined ? `${s(a.tagname)}=${s(a.tagvalue)}` : s(a.tagname)) : undefined;
      if (a.resourceid !== undefined) return { az: ['resource', 'show', '--ids', s(a.resourceid)], json: true, shape: (v) => (asResource(v) as unknown[])[0] };
      if (a.name !== undefined && a.resourcegroupname === undefined)
        return { az: ['resource', 'show', '--ids', s(a.name)], json: true, shape: (v) => (asResource(v) as unknown[])[0] };
      return {
        az: ['resource', 'list', ...(a.resourcegroupname ? ['-g', s(a.resourcegroupname)] : []), ...(tag ? ['--tag', tag] : [])],
        json: true,
        shape: (v) => (a.name ? (asResource(v) as unknown[]).filter((r) => isObj(r) && s(r.Name).toLowerCase() === s(a.name).toLowerCase()) : asResource(v)),
      };
    },
  },
  // Set-AzResource -Tag REPLACES the tag set, like az resource tag without --is-incremental
  'Set-AzResource': {
    params: ['ResourceId', 'Tag'],
    switches: ['Force'],
    pipe: ['ResourceId'],
    mandatory: ['ResourceId', 'Tag'],
    build: (a) => {
      if (!isObj(a.tag)) return { error: '-Tag takes a hashtable, e.g. @{ CostCenter = "2210" }.' };
      return { az: ['resource', 'tag', '--ids', s(a.resourceid), ...tagsOf(a.tag)] };
    },
  },
  'Update-AzTag': {
    params: ['ResourceId', 'Tag', 'Operation'],
    mandatory: ['ResourceId', 'Tag', 'Operation'],
    build: (a) => {
      const op = ['merge', 'replace', 'delete'].find((o) => o === s(a.operation).toLowerCase());
      if (!op) return { error: `-Operation must be Merge, Replace or Delete (got '${s(a.operation)}').` };
      if (!isObj(a.tag)) return { error: '-Tag takes a hashtable, e.g. @{ CostCenter = "2210" }.' };
      return { az: ['tag', 'update', '--resource-id', s(a.resourceid), '--operation', op[0].toUpperCase() + op.slice(1), ...tagsOf(a.tag)] };
    },
  },
  'Move-AzResource': {
    params: ['DestinationResourceGroupName', 'ResourceId'],
    switches: ['Force'],
    pipe: ['ResourceId'],
    collect: ['ResourceId'],
    mandatory: ['DestinationResourceGroupName', 'ResourceId'],
    build: (a) => ({ az: ['resource', 'move', '--destination-group', s(a.destinationresourcegroupname), '--ids', ...toList(a.resourceid).map(s)] }),
  },
  'Get-AzResourceLock': {
    params: ['ResourceGroupName'],
    build: (a) => ({ az: ['lock', 'list', ...(a.resourcegroupname ? ['-g', s(a.resourcegroupname)] : [])], json: true, shape: pascalKeys }),
  },
  'Remove-AzResourceLock': {
    params: ['LockName', 'ResourceGroupName'],
    switches: ['Force'],
    mandatory: ['LockName', 'ResourceGroupName'],
    build: (a) => ({ az: ['lock', 'delete', '--name', s(a.lockname), '-g', s(a.resourcegroupname)] }),
  },
};
