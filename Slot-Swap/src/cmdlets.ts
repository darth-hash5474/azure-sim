// Az PowerShell cmdlets for Slot Swap, mapped onto the az commands the lab already simulates.
import { pascalKeys, prop, toStr, type Build, type CmdletTable } from './shellcore';

const s = toStr;
const str = (v: unknown) => (v === undefined ? undefined : s(v));

const deployment = (a: Record<string, unknown>, op: 'what-if' | 'create'): Build => {
  const rg = str(a.resourcegroupname);
  const file = str(a.templatefile);
  if (!file) return { error: 'Provide -TemplateFile (a .bicep file in ~/scratch).' };
  const given: string[] = [];
  if (a.templateparameterfile !== undefined) given.push(`@${s(a.templateparameterfile)}`);
  if (a.templateparameterobject !== undefined) {
    const o = a.templateparameterobject;
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return { error: '-TemplateParameterObject takes a hashtable, e.g. @{ planSku = "P1v3"; instanceCount = 2 }.' };
    for (const [k, v] of Object.entries(o)) given.push(`${k}=${s(v)}`);
  }
  return {
    az: ['deployment', 'group', op, '-g', rg ?? '', '--template-file', file, ...(a.mode ? ['--mode', s(a.mode)] : []), ...(given.length ? ['--parameters', ...given] : [])],
  };
};

const DEPLOY_PARAMS = ['ResourceGroupName|ResourceGroup', 'Name', 'TemplateFile', 'TemplateParameterFile', 'TemplateParameterObject', 'Mode'];

const SKU_BY_TIER: Record<string, string[]> = {
  standard: ['S1', 'S2', 'S3'],
  premiumv3: ['P1v3', 'P2v3', 'P3v3'],
  premium0v3: ['P1v3', 'P2v3', 'P3v3'],
};

export const CMDLETS: CmdletTable = {
  'Get-AzResource': {
    params: ['ResourceGroupName', 'Name', 'ResourceType'],
    build: (a) => ({ az: ['resource', 'list', ...(a.resourcegroupname ? ['-g', s(a.resourcegroupname)] : [])] }),
  },
  'New-AzResourceGroupDeployment': {
    params: DEPLOY_PARAMS,
    mandatory: ['ResourceGroupName', 'TemplateFile'],
    build: (a) => deployment(a, a['~whatif'] ? 'what-if' : 'create'),
  },
  'Get-AzResourceGroupDeploymentWhatIfResult': {
    params: DEPLOY_PARAMS,
    mandatory: ['ResourceGroupName', 'TemplateFile'],
    build: (a) => deployment(a, 'what-if'),
  },
  'Get-AzAppServicePlan': {
    params: ['ResourceGroupName', 'Name'],
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => ({ az: ['appservice', 'plan', 'show', '-n', s(a.name), '-g', s(a.resourcegroupname)], json: true, shape: pascalKeys }),
  },
  'Set-AzAppServicePlan': {
    params: ['ResourceGroupName', 'Name', 'Tier', 'WorkerSize', 'NumberofWorkers'],
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => {
      let sku: string | undefined;
      if (a.tier !== undefined) {
        const row = SKU_BY_TIER[s(a.tier).replace(/\s+/g, '').toLowerCase()];
        const size = ['small', 'medium', 'large'].indexOf(s(a.workersize ?? 'small').toLowerCase());
        if (!row) return { error: `The tier '${s(a.tier)}' is not one this lab knows. Try Standard or PremiumV3 with -WorkerSize Small|Medium|Large.` };
        if (size < 0) return { error: `-WorkerSize must be Small, Medium or Large (got '${s(a.workersize)}').` };
        sku = row[size];
      }
      return {
        az: ['appservice', 'plan', 'update', '-n', s(a.name), '-g', s(a.resourcegroupname), ...(sku ? ['--sku', sku] : []), ...(a.numberofworkers !== undefined ? ['--number-of-workers', s(a.numberofworkers)] : [])],
        json: true,
        shape: pascalKeys,
      };
    },
  },
  'Get-AzWebAppSlot': {
    params: ['ResourceGroupName', 'Name', 'Slot'],
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => ({ az: ['webapp', 'deployment', 'slot', 'list', '-n', s(a.name), '-g', s(a.resourcegroupname)] }),
  },
  'Switch-AzWebAppSlot': {
    params: ['ResourceGroupName', 'Name', 'SourceSlotName', 'DestinationSlotName'],
    mandatory: ['ResourceGroupName', 'Name', 'SourceSlotName', 'DestinationSlotName'],
    build: (a) => ({ az: ['webapp', 'deployment', 'slot', 'swap', '-n', s(a.name), '-g', s(a.resourcegroupname), '--slot', s(a.sourceslotname), '--target-slot', s(a.destinationslotname)] }),
  },
  'Publish-AzWebApp': {
    params: ['ResourceGroupName', 'Name', 'Slot', 'ArchivePath'],
    switches: ['Force'],
    mandatory: ['ResourceGroupName', 'Name', 'ArchivePath'],
    build: (a) => ({ az: ['webapp', 'deploy', '-n', s(a.name), '-g', s(a.resourcegroupname), ...(a.slot ? ['--slot', s(a.slot)] : []), '--src-path', s(a.archivepath), '--type', 'zip'] }),
  },
  'Get-AzVM': {
    params: ['ResourceGroupName', 'Name'],
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => ({
      az: ['vm', 'show', '-n', s(a.name), '-g', s(a.resourcegroupname)],
      json: true,
      shape: (v) => ({ ...(pascalKeys(v) as object), ResourceGroupName: s(a.resourcegroupname) }),
    }),
  },
  'Update-AzVM': {
    params: ['ResourceGroupName', 'VM'],
    mandatory: ['ResourceGroupName', 'VM'],
    build: (a) => {
      const name = prop(a.vm, 'Name');
      const size = prop(prop(a.vm, 'HardwareProfile'), 'VmSize');
      if (name === undefined || size === undefined) return { error: '-VM must be the object from Get-AzVM (it needs Name and HardwareProfile.VmSize).' };
      return { az: ['vm', 'resize', '-n', s(name), '-g', s(a.resourcegroupname), '--size', s(size)] };
    },
  },
  'Get-AzComputeResourceSku': {
    params: ['Location'],
    build: (a) => ({ az: ['vm', 'list-skus', '-l', s(a.location ?? 'eastus'), '--size', 'Standard_', '--zone'] }),
  },
  'Invoke-WebRequest': {
    params: ['Uri'],
    positional: ['Uri'],
    mandatory: ['Uri'],
    build: (a) => ({ native: true, az: ['curl', s(a.uri)] }),
  },
};
