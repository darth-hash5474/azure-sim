// Az PowerShell cmdlets for Night Shift, mapped onto the az commands the lab already simulates.
import { RG, SUB_ID } from './engine';
import { customObjects, isObj, pascalKeys, prop, toList, toStr, type Build, type CmdletTable } from './shellcore';

const s = toStr;
const last = (v: unknown) => s(v).split('/').pop() ?? '';
const scope = () => `/subscriptions/${SUB_ID}/resourceGroups/${RG}`;
const rid = (path: string) => `${scope()}/providers/${path}`;
const obj = <T extends Record<string, unknown>>(o: T): T => (customObjects.add(o), o);

/** "00:05:00" (a TimeSpan) -> "5m" / "1h" as the az commands want it. */
const span = (v: unknown, fallback: string): string => {
  if (v === undefined) return fallback;
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)$/.exec(s(v));
  if (!m) return s(v);
  const total = (Number(m[1] ?? 0) * 24 + Number(m[2])) * 60 + Number(m[3]);
  return total % 60 === 0 && total >= 60 ? `${total / 60}h` : `${total}m`;
};

const AGG: Record<string, string> = { average: 'avg', minimum: 'min', maximum: 'max', total: 'total', count: 'count' };
const OP: Record<string, string> = { greaterthan: '>', lessthan: '<', greaterthanorequal: '>=', lessthanorequal: '<=', equals: '==' };

const vault = (id: unknown) => ['--vault-name', last(id), '-g', RG];

export const CMDLETS: CmdletTable = {
  'Get-AzResource': {
    params: ['ResourceGroupName', 'Name'],
    build: (a) => ({ az: ['resource', 'list', '-g', s(a.resourcegroupname ?? RG)] }),
  },
  'Get-AzVM': {
    params: ['ResourceGroupName', 'Name'],
    build: (a) => ({
      read: ['resource', 'list', '-g', RG],
      then: (current) => {
        const names = toList(current)
          .map((l) => s(l))
          .filter((l) => l.includes('Microsoft.Compute/virtualMachines'))
          .map((l) => l.trim().split(/\s+/)[0])
          .filter((n) => !a.name || n.toLowerCase() === s(a.name).toLowerCase());
        if (a.name && !names.length) return { error: `The Resource 'Microsoft.Compute/virtualMachines/${s(a.name)}' under resource group '${RG}' was not found.` };
        return { value: names.map((n) => obj({ Name: n, ResourceGroupName: RG, Location: 'eastus', Id: rid(`Microsoft.Compute/virtualMachines/${n}`) })) };
      },
    }),
  },
  'Get-AzMetric': {
    params: ['ResourceId', 'MetricName', 'TimeGrain'],
    mandatory: ['ResourceId'],
    build: (a) => ({ az: ['monitor', 'metrics', 'list', '--resource', last(a.resourceid), '-g', RG, '--metric', s(a.metricname ?? 'Percentage CPU')] }),
  },
  'Invoke-AzOperationalInsightsQuery': {
    params: ['WorkspaceId', 'Query', 'Timespan'],
    mandatory: ['WorkspaceId', 'Query'],
    build: (a) => ({
      az: ['monitor', 'log-analytics', 'query', '-w', last(prop(a.workspaceid, 'CustomerId') ?? a.workspaceid), '--analytics-query', s(a.query)],
      json: true,
      shape: (rows) => obj({ Results: toList(rows).map((r) => (isObj(r) ? obj({ ...r }) : r)), Error: null }),
    }),
  },
  'Get-AzOperationalInsightsWorkspace': {
    params: ['ResourceGroupName', 'Name'],
    build: () => ({ value: obj({ Name: 'law-ops', ResourceGroupName: RG, Location: 'eastus', CustomerId: 'law-ops', ResourceId: rid('Microsoft.OperationalInsights/workspaces/law-ops') }) }),
  },
  'New-AzDataCollectionRuleAssociation': {
    params: ['TargetResourceId', 'AssociationName', 'RuleId', 'DataCollectionRuleId'],
    mandatory: ['TargetResourceId', 'AssociationName'],
    build: (a) => ({
      az: ['monitor', 'data-collection', 'rule', 'association', 'create', '--name', s(a.associationname), '--resource', last(a.targetresourceid), '--rule-id', last(a.ruleid ?? a.datacollectionruleid ?? 'dcr-ops'), '-g', RG],
      json: true,
      shape: pascalKeys,
    }),
  },
  'New-AzDiagnosticSetting': {
    params: ['Name', 'ResourceId', 'WorkspaceId'],
    mandatory: ['Name', 'ResourceId', 'WorkspaceId'],
    build: (a) => ({ az: ['monitor', 'diagnostic-settings', 'create', '--name', s(a.name), '--resource', last(a.resourceid), '--workspace', last(a.workspaceid)] }),
  },
  'New-AzActionGroupReceiver': {
    params: ['Name', 'EmailAddress'],
    switches: ['EmailReceiver'],
    mandatory: ['Name', 'EmailAddress'],
    build: (a) => ({ value: obj({ Name: s(a.name), EmailAddress: s(a.emailaddress), Status: 'Enabled' }) }),
  },
  'New-AzActionGroup': {
    params: ['Name', 'ResourceGroupName', 'Location', 'ShortName|GroupShortName', 'EmailReceiver'],
    mandatory: ['Name', 'ResourceGroupName', 'EmailReceiver'],
    build: (a) => {
      const r = toList(a.emailreceiver)[0];
      return {
        az: ['monitor', 'action-group', 'create', '-n', s(a.name), '-g', s(a.resourcegroupname), '--action', 'email', s(prop(r, 'Name')), s(prop(r, 'EmailAddress'))],
        json: true,
        shape: (v) => obj({ ...(pascalKeys(v) as object), Id: rid(`Microsoft.Insights/actionGroups/${s(a.name)}`), ResourceGroupName: s(a.resourcegroupname) }),
      };
    },
  },
  'New-AzMetricAlertRuleV2Criteria': {
    params: ['MetricName', 'TimeAggregation', 'Operator', 'Threshold'],
    mandatory: ['MetricName', 'TimeAggregation', 'Operator', 'Threshold'],
    build: (a) => {
      if (!AGG[s(a.timeaggregation).toLowerCase()]) return { error: `Cannot convert value "${s(a.timeaggregation)}" to type "Microsoft.Azure.Management.Monitor.Models.AggregationType". Use Average, Minimum, Maximum, Total or Count.` };
      if (!OP[s(a.operator).toLowerCase()]) return { error: `Cannot convert value "${s(a.operator)}" to an operator. Use GreaterThan, LessThan, GreaterThanOrEqual, LessThanOrEqual or Equals.` };
      return { value: obj({ MetricName: s(a.metricname), TimeAggregation: s(a.timeaggregation), Operator: s(a.operator), Threshold: Number(s(a.threshold)) }) };
    },
  },
  'Add-AzMetricAlertRuleV2': {
    params: ['Name', 'ResourceGroupName', 'TargetResourceId', 'Condition', 'ActionGroupId|ActionGroup', 'WindowSize', 'Frequency', 'Severity', 'Description'],
    mandatory: ['Name', 'ResourceGroupName', 'TargetResourceId', 'Condition'],
    build: (a): Build => {
      const c = toList(a.condition)[0];
      const agg = AGG[s(prop(c, 'TimeAggregation')).toLowerCase()];
      const op = OP[s(prop(c, 'Operator')).toLowerCase()];
      if (!agg || !op) return { error: '-Condition must come from New-AzMetricAlertRuleV2Criteria.' };
      const groups = toList(a.actiongroupid).map((g) => last(prop(g, 'Id') ?? g));
      return {
        az: [
          'monitor', 'metrics', 'alert', 'create', '-n', s(a.name), '-g', s(a.resourcegroupname), '--scopes', last(a.targetresourceid),
          '--condition', `${agg} ${s(prop(c, 'MetricName'))} ${op} ${s(prop(c, 'Threshold'))}`,
          '--window-size', span(a.windowsize, '5m'), '--evaluation-frequency', span(a.frequency, '1m'),
          ...(groups.length ? ['--action', ...groups] : []),
        ],
        json: true,
        shape: pascalKeys,
      };
    },
  },
  'Get-AzMetricAlertRuleV2': { params: ['ResourceGroupName', 'Name'], build: (a) => ({ az: ['monitor', 'metrics', 'alert', 'list', '-g', s(a.resourcegroupname ?? RG)] }) },
  'Remove-AzMetricAlertRuleV2': {
    params: ['ResourceGroupName', 'Name'],
    mandatory: ['ResourceGroupName', 'Name'],
    build: (a) => ({ az: ['monitor', 'metrics', 'alert', 'delete', '-n', s(a.name), '-g', s(a.resourcegroupname)] }),
  },
  'New-AzRecoveryServicesVault': {
    params: ['Name', 'ResourceGroupName', 'Location'],
    mandatory: ['Name', 'ResourceGroupName', 'Location'],
    build: (a) => ({
      az: ['backup', 'vault', 'create', '-n', s(a.name), '-g', s(a.resourcegroupname), '--location', s(a.location)],
      json: true,
      shape: (v) => obj({ Name: s(prop(v, 'name')), Location: s(prop(v, 'location')), ResourceGroupName: s(a.resourcegroupname), Id: rid(`Microsoft.RecoveryServices/vaults/${s(a.name)}`), Type: 'Microsoft.RecoveryServices/vaults' }),
    }),
  },
  'Get-AzRecoveryServicesBackupProtectionPolicy': {
    params: ['VaultId', 'Name', 'WorkloadType'],
    mandatory: ['VaultId'],
    build: (a) => ({
      read: ['backup', 'policy', 'list', ...vault(a.vaultid)],
      then: (current) => {
        const rows = toList(current).map(s).filter((l) => /^\w/.test(l) && !l.startsWith('Name '));
        const pols = rows.map((l) => obj({ Name: l.split(/\s+/)[0], WorkloadType: 'AzureVM', Id: rid(`Microsoft.RecoveryServices/vaults/${last(a.vaultid)}/backupPolicies/${l.split(/\s+/)[0]}`) }));
        return { value: pols.filter((p) => !a.name || s(p.Name).toLowerCase() === s(a.name).toLowerCase()) };
      },
    }),
  },
  'Enable-AzRecoveryServicesBackupProtection': {
    params: ['VaultId', 'Policy', 'Name', 'ResourceGroupName'],
    mandatory: ['VaultId', 'Policy', 'Name', 'ResourceGroupName'],
    build: (a) => ({ az: ['backup', 'protection', 'enable-for-vm', ...vault(a.vaultid), '--vm', s(a.name), '--policy-name', s(prop(a.policy, 'Name') ?? a.policy)], json: true, shape: pascalKeys }),
  },
  'Get-AzRecoveryServicesBackupItem': {
    params: ['VaultId', 'BackupManagementType', 'WorkloadType', 'Name'],
    mandatory: ['VaultId'],
    build: (a) => ({ value: obj({ Name: s(a.name ?? 'batch-vm'), ContainerName: s(a.name ?? 'batch-vm'), VaultId: s(a.vaultid), WorkloadType: 'AzureVM' }) }),
  },
  'Backup-AzRecoveryServicesBackupItem': {
    params: ['VaultId', 'Item'],
    mandatory: ['VaultId', 'Item'],
    build: (a) => ({ az: ['backup', 'protection', 'backup-now', ...vault(a.vaultid), '--container-name', s(prop(a.item, 'ContainerName')), '--item-name', s(prop(a.item, 'Name'))], json: true, shape: pascalKeys }),
  },
  'Get-AzRecoveryServicesBackupJob': { params: ['VaultId'], mandatory: ['VaultId'], build: (a) => ({ az: ['backup', 'job', 'list', ...vault(a.vaultid)] }) },
  'Get-AzRecoveryServicesBackupRecoveryPoint': {
    params: ['VaultId', 'Item'],
    mandatory: ['VaultId', 'Item'],
    build: (a) => ({
      read: ['backup', 'recoverypoint', 'list', ...vault(a.vaultid), '--container-name', s(prop(a.item, 'ContainerName')), '--item-name', s(prop(a.item, 'Name'))],
      then: (current) => ({
        value: toList(current)
          .map(s)
          .filter((l) => /^\w/.test(l) && !l.startsWith('Name '))
          .map((l) => obj({ RecoveryPointId: l.split(/\s+/)[0], Name: l.split(/\s+/)[0], RecoveryPointTime: l.split(/\s+/)[1], RecoveryPointType: 'CrashConsistent', ItemName: s(prop(a.item, 'Name')) })),
      }),
    }),
  },
  'Restore-AzRecoveryServicesBackupItem': {
    params: ['VaultId', 'RecoveryPoint', 'StorageAccountName', 'StorageAccountResourceGroupName', 'TargetResourceGroupName'],
    mandatory: ['VaultId', 'RecoveryPoint', 'StorageAccountName', 'StorageAccountResourceGroupName'],
    build: (a) => ({
      az: ['backup', 'restore', 'restore-disks', ...vault(a.vaultid), '--container-name', s(prop(a.recoverypoint, 'ItemName') ?? 'batch-vm'), '--item-name', s(prop(a.recoverypoint, 'ItemName') ?? 'batch-vm'), '--rp-name', s(prop(a.recoverypoint, 'RecoveryPointId')), '--storage-account', s(a.storageaccountname), '--target-resource-group', s(a.targetresourcegroupname ?? RG)],
    }),
  },
};
