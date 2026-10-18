// Az PowerShell cmdlets for No Route, mapped onto the az commands the lab already simulates.
// Objects passed between cmdlets (Get-AzNetworkSecurityGroup ... Set-AzNetworkSecurityGroup) are edited locally;
// the Set-* cmdlet compares them with the lab's current state and sends only what changed.
import { DB_IP, RG, SUB_ID, VNETS, WEB_IP } from './engine';
import { customObjects, isObj, pascalKeys, prop, toList, toStr, type Build, type CmdletTable } from './shellcore';

const s = toStr;
const last = (v: unknown) => s(v).split('/').pop() ?? '';
const rid = (path: string) => `/subscriptions/${SUB_ID}/resourceGroups/${RG}/providers/${path}`;
const obj = <T extends Record<string, unknown>>(o: T): T => (customObjects.add(o), o);
const rec = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

// engine and cmdlets import each other, so anything built from engine constants is built on demand
const vms = (): Record<string, { ip: string; nic: string }> => ({ 'web-vm': { ip: WEB_IP, nic: 'web-vm-nic' }, 'db-vm': { ip: DB_IP, nic: 'db-vm-nic' } });

// --- shapes ---

const peeringShape = (v: unknown) => {
  const p = rec(v);
  return obj({
    Name: p.name,
    VirtualNetworkName: p.vnet,
    ResourceGroupName: RG,
    RemoteVirtualNetwork: obj({ Id: rid(`Microsoft.Network/virtualNetworks/${s(p.remoteVirtualNetwork)}`) }),
    PeeringState: p.peeringState,
    AllowVirtualNetworkAccess: p.allowVirtualNetworkAccess,
  });
};

const nsgShape = (name: string) => (v: unknown) =>
  obj({ Name: name, ResourceGroupName: RG, Location: 'eastus', SecurityRules: toList(v).map(pascalKeys) });

const routeTableShape = (v: unknown) => obj({ Name: 'rt-web', ResourceGroupName: RG, Location: 'eastus', Routes: toList(v).map(pascalKeys) });

const ruleFlags = (r: Record<string, unknown>): string[] => [
  '--priority', s(r.Priority),
  '--access', s(r.Access),
  '--protocol', s(r.Protocol),
  '--source-address-prefixes', s(r.SourceAddressPrefix),
  '--destination-port-ranges', s(r.DestinationPortRange),
];

// --- Set-AzNetworkSecurityGroup: compare the object with the rules the lab holds now ---

function setNsg(nsg: unknown): Build {
  const name = s(prop(nsg, 'Name'));
  const want = toList(prop(nsg, 'SecurityRules')).map(rec);
  return {
    read: ['network', 'nsg', 'rule', 'list', '--nsg-name', name, '-g', RG],
    then: (current) => {
      const have = toList(current).map(rec);
      const base = ['network', 'nsg', 'rule'];
      const at = (cmd: string, rule: string) => [...base, cmd, '--nsg-name', name, '-g', RG, '-n', rule];
      const steps: string[][] = [];
      have.filter((h) => !want.some((w) => s(w.Name) === s(h.name))).forEach((h) => steps.push([...at('delete', s(h.name))]));
      const changed = want.filter((w) => {
        const h = have.find((x) => s(x.name) === s(w.Name));
        return h && (s(h.priority) !== s(w.Priority) || s(h.access) !== s(w.Access) || s(h.protocol) !== s(w.Protocol) || s(h.sourceAddressPrefix) !== s(w.SourceAddressPrefix) || s(h.destinationPortRange) !== s(w.DestinationPortRange));
      });
      // an update must not land on a priority another rule still holds; send the free ones first
      const taken = new Set(have.filter((h) => want.some((w) => s(w.Name) === s(h.name))).map((h) => s(h.priority)));
      const ordered: Record<string, unknown>[] = [];
      for (let pass = 0; pass < changed.length && ordered.length < changed.length; pass++) {
        for (const w of changed) {
          if (ordered.includes(w)) continue;
          const old = have.find((x) => s(x.name) === s(w.Name));
          if (!taken.has(s(w.Priority)) || s(old?.priority) === s(w.Priority)) {
            ordered.push(w);
            taken.delete(s(old?.priority));
            taken.add(s(w.Priority));
          }
        }
      }
      changed.filter((w) => !ordered.includes(w)).forEach((w) => ordered.push(w));
      ordered.forEach((w) => steps.push([...at('update', s(w.Name)), ...ruleFlags(w)]));
      want.filter((w) => !have.some((h) => s(h.name) === s(w.Name))).forEach((w) => steps.push([...at('create', s(w.Name)), ...ruleFlags(w)]));
      if (!steps.length) return { value: nsg };
      steps.push([...base, 'list', '--nsg-name', name, '-g', RG]);
      return { steps, json: true, shape: nsgShape(name) };
    },
  };
}

function setRouteTable(table: unknown): Build {
  const want = toList(prop(table, 'Routes')).map(rec);
  return {
    read: ['network', 'route-table', 'route', 'list', '--route-table-name', 'rt-web', '-g', RG],
    then: (current) => {
      const have = toList(current).map(rec);
      const adds = want.filter((w) => !have.some((h) => s(h.name) === s(w.Name)));
      if (adds.length) return { error: 'This lab can remove routes from rt-web but not add them; fix the problem by removing a route.' };
      const steps = have.filter((h) => !want.some((w) => s(w.Name) === s(h.name))).map((h) => ['network', 'route-table', 'route', 'delete', '--route-table-name', 'rt-web', '-n', s(h.name), '-g', RG]);
      if (!steps.length) return { value: table };
      steps.push(['network', 'route-table', 'route', 'list', '--route-table-name', 'rt-web', '-g', RG]);
      return { steps, json: true, shape: routeTableShape };
    },
  };
}

const watcher = () => obj({ Name: 'NetworkWatcher_eastus', ResourceGroupName: 'NetworkWatcherRG', Location: 'eastus', Id: `/subscriptions/${SUB_ID}/resourceGroups/NetworkWatcherRG/providers/Microsoft.Network/networkWatchers/NetworkWatcher_eastus` });

export const CMDLETS: CmdletTable = {
  'Get-AzVirtualNetwork': {
    params: ['Name', 'ResourceGroupName'],
    build: (a) => ({
      value: Object.entries(VNETS)
        .filter(([n]) => !a.name || n.toLowerCase() === s(a.name).toLowerCase())
        .map(([n, cidr]) => obj({ Name: n, ResourceGroupName: RG, Location: 'eastus', Id: rid(`Microsoft.Network/virtualNetworks/${n}`), AddressSpace: obj({ AddressPrefixes: [cidr] }) })),
    }),
  },
  'Get-AzVirtualNetworkPeering': {
    params: ['VirtualNetworkName', 'ResourceGroupName', 'Name'],
    mandatory: ['VirtualNetworkName', 'ResourceGroupName'],
    build: (a) => ({
      az: ['network', 'vnet', 'peering', 'list', '--vnet-name', s(a.virtualnetworkname), '-g', s(a.resourcegroupname)],
      json: true,
      shape: (v) => toList(v).map(peeringShape).filter((p) => !a.name || s(p.Name).toLowerCase() === s(a.name).toLowerCase()),
    }),
  },
  'Add-AzVirtualNetworkPeering': {
    params: ['Name', 'VirtualNetwork', 'RemoteVirtualNetworkId'],
    switches: ['BlockVirtualNetworkAccess', 'AllowForwardedTraffic', 'AllowGatewayTransit', 'UseRemoteGateways'],
    mandatory: ['Name', 'VirtualNetwork', 'RemoteVirtualNetworkId'],
    build: (a) => ({
      az: ['network', 'vnet', 'peering', 'create', '-n', s(a.name), '--vnet-name', s(prop(a.virtualnetwork, 'Name')), '--remote-vnet', last(a.remotevirtualnetworkid), ...(a.blockvirtualnetworkaccess ? [] : ['--allow-vnet-access']), '-g', RG],
      json: true,
      shape: peeringShape,
    }),
  },
  'Set-AzVirtualNetworkPeering': {
    params: ['VirtualNetworkPeering'],
    mandatory: ['VirtualNetworkPeering'],
    pipe: ['VirtualNetworkPeering'],
    build: (a) => {
      const p = a.virtualnetworkpeering;
      const vnet = prop(p, 'VirtualNetworkName');
      if (vnet === undefined) return { error: '-VirtualNetworkPeering must be an object from Get-AzVirtualNetworkPeering.' };
      return {
        az: ['network', 'vnet', 'peering', 'update', '-n', s(prop(p, 'Name')), '--vnet-name', s(vnet), '--set', `allowVirtualNetworkAccess=${prop(p, 'AllowVirtualNetworkAccess') ? 'true' : 'false'}`, '-g', RG],
        json: true,
        shape: peeringShape,
      };
    },
  },
  'Remove-AzVirtualNetworkPeering': {
    params: ['Name', 'VirtualNetworkName', 'ResourceGroupName'],
    switches: ['Force'],
    mandatory: ['Name', 'VirtualNetworkName', 'ResourceGroupName'],
    build: (a) => ({ az: ['network', 'vnet', 'peering', 'delete', '-n', s(a.name), '--vnet-name', s(a.virtualnetworkname), '-g', s(a.resourcegroupname)] }),
  },
  'Get-AzRouteTable': {
    params: ['Name', 'ResourceGroupName'],
    build: () => ({ az: ['network', 'route-table', 'route', 'list', '--route-table-name', 'rt-web', '-g', RG], json: true, shape: routeTableShape }),
  },
  'Remove-AzRouteConfig': {
    params: ['Name', 'RouteTable'],
    mandatory: ['Name', 'RouteTable'],
    build: (a) => {
      const t = rec(a.routetable);
      const key = Object.keys(t).find((k) => k.toLowerCase() === 'routes');
      if (!key) return { error: '-RouteTable must be an object from Get-AzRouteTable.' };
      t[key] = toList(t[key]).filter((r) => s(prop(r, 'Name')).toLowerCase() !== s(a.name).toLowerCase());
      return { value: t };
    },
  },
  'Set-AzRouteTable': { params: ['RouteTable'], mandatory: ['RouteTable'], pipe: ['RouteTable'], build: (a) => setRouteTable(a.routetable) },
  'Get-AzNetworkSecurityGroup': {
    params: ['Name', 'ResourceGroupName'],
    build: (a) => {
      const n = s(a.name ?? 'nsg-db');
      return { az: ['network', 'nsg', 'rule', 'list', '--nsg-name', n, '-g', RG], json: true, shape: nsgShape(n) };
    },
  },
  'Remove-AzNetworkSecurityRuleConfig': {
    params: ['Name', 'NetworkSecurityGroup'],
    mandatory: ['Name', 'NetworkSecurityGroup'],
    build: (a) => {
      const g = rec(a.networksecuritygroup);
      const key = Object.keys(g).find((k) => k.toLowerCase() === 'securityrules');
      if (!key) return { error: '-NetworkSecurityGroup must be an object from Get-AzNetworkSecurityGroup.' };
      g[key] = toList(g[key]).filter((r) => s(prop(r, 'Name')).toLowerCase() !== s(a.name).toLowerCase());
      return { value: g };
    },
  },
  'Set-AzNetworkSecurityRuleConfig': {
    params: ['Name', 'NetworkSecurityGroup', 'Priority', 'Access', 'Protocol', 'Direction', 'SourceAddressPrefix', 'SourcePortRange', 'DestinationAddressPrefix', 'DestinationPortRange'],
    mandatory: ['Name', 'NetworkSecurityGroup'],
    build: (a) => {
      const g = rec(a.networksecuritygroup);
      const rule = toList(g.SecurityRules).find((r) => s(prop(r, 'Name')).toLowerCase() === s(a.name).toLowerCase());
      if (!isObj(rule)) return { error: `The rule '${s(a.name)}' does not exist on this network security group object.` };
      const set: [string, unknown][] = [['Priority', a.priority], ['Access', a.access], ['Protocol', a.protocol], ['SourceAddressPrefix', a.sourceaddressprefix], ['DestinationPortRange', a.destinationportrange]];
      set.forEach(([k, v]) => v !== undefined && (rule[k] = typeof v === 'string' && k === 'Priority' ? Number(v) : v));
      return { value: g };
    },
  },
  'Add-AzNetworkSecurityRuleConfig': {
    params: ['Name', 'NetworkSecurityGroup', 'Priority', 'Access', 'Protocol', 'Direction', 'SourceAddressPrefix', 'SourcePortRange', 'DestinationAddressPrefix', 'DestinationPortRange', 'Description'],
    mandatory: ['Name', 'NetworkSecurityGroup', 'Access', 'Protocol', 'Direction', 'Priority', 'SourceAddressPrefix', 'SourcePortRange', 'DestinationAddressPrefix', 'DestinationPortRange'],
    build: (a) => {
      const g = rec(a.networksecuritygroup);
      if (!Array.isArray(g.SecurityRules)) return { error: '-NetworkSecurityGroup must be an object from Get-AzNetworkSecurityGroup.' };
      if (g.SecurityRules.some((r) => s(prop(r, 'Name')).toLowerCase() === s(a.name).toLowerCase())) return { error: `A rule named '${s(a.name)}' already exists on this object (use Set-AzNetworkSecurityRuleConfig).` };
      g.SecurityRules.push(obj({ Name: s(a.name), Priority: Number(s(a.priority)), Direction: s(a.direction), Access: s(a.access), Protocol: s(a.protocol), SourceAddressPrefix: s(a.sourceaddressprefix), DestinationPortRange: s(a.destinationportrange) }));
      return { value: g };
    },
  },
  'Set-AzNetworkSecurityGroup': { params: ['NetworkSecurityGroup'], mandatory: ['NetworkSecurityGroup'], pipe: ['NetworkSecurityGroup'], build: (a) => setNsg(a.networksecuritygroup) },
  'Get-AzEffectiveRouteTable': {
    params: ['ResourceGroupName', 'NetworkInterfaceName'],
    mandatory: ['ResourceGroupName', 'NetworkInterfaceName'],
    build: (a) => ({ az: ['network', 'nic', 'list-effective-route-table', '--name', s(a.networkinterfacename), '-g', s(a.resourcegroupname)] }),
  },
  'Get-AzVM': {
    params: ['Name', 'ResourceGroupName'],
    build: (a) => ({
      value: Object.entries(vms())
        .filter(([n]) => !a.name || n.toLowerCase() === s(a.name).toLowerCase())
        .map(([n, v]) => obj({ Name: n, ResourceGroupName: RG, Location: 'eastus', Id: rid(`Microsoft.Compute/virtualMachines/${n}`), NetworkProfile: obj({ NetworkInterfaces: [obj({ Id: rid(`Microsoft.Network/networkInterfaces/${v.nic}`) })] }) })),
    }),
  },
  'Get-AzNetworkInterface': {
    params: ['Name', 'ResourceGroupName'],
    build: (a) => ({
      value: Object.entries(vms())
        .filter(([, v]) => !a.name || v.nic.toLowerCase() === s(a.name).toLowerCase())
        .map(([n, v]) => obj({ Name: v.nic, ResourceGroupName: RG, Id: rid(`Microsoft.Network/networkInterfaces/${v.nic}`), VirtualMachine: obj({ Id: rid(`Microsoft.Compute/virtualMachines/${n}`) }), IpConfigurations: [obj({ Name: 'ipconfig1', PrivateIpAddress: v.ip })] })),
    }),
  },
  'Get-AzNetworkWatcher': { params: ['Name', 'ResourceGroupName', 'Location'], build: () => ({ value: watcher() }) },
  'Get-AzNetworkWatcherNextHop': {
    params: ['NetworkWatcher', 'TargetVirtualMachineId', 'SourceIPAddress', 'DestinationIPAddress'],
    mandatory: ['NetworkWatcher', 'TargetVirtualMachineId', 'SourceIPAddress', 'DestinationIPAddress'],
    build: (a) => ({ az: ['network', 'watcher', 'show-next-hop', '--vm', last(a.targetvirtualmachineid), '--source-ip', s(a.sourceipaddress), '--dest-ip', s(a.destinationipaddress), '-g', RG], json: true, shape: pascalKeys }),
  },
  'Test-AzNetworkWatcherIPFlow': {
    params: ['NetworkWatcher', 'TargetVirtualMachineId', 'Direction', 'Protocol', 'LocalIPAddress', 'LocalPort', 'RemoteIPAddress', 'RemotePort'],
    mandatory: ['NetworkWatcher', 'TargetVirtualMachineId', 'Direction', 'Protocol', 'LocalIPAddress', 'LocalPort', 'RemoteIPAddress', 'RemotePort'],
    build: (a) => ({
      az: ['network', 'watcher', 'test-ip-flow', '--vm', last(a.targetvirtualmachineid), '--direction', s(a.direction), '--protocol', s(a.protocol).toUpperCase(), '--local', `${s(a.localipaddress)}:${s(a.localport)}`, '--remote', `${s(a.remoteipaddress)}:${s(a.remoteport)}`, '-g', RG],
      json: true,
      shape: pascalKeys,
    }),
  },
  'Test-AzNetworkWatcherConnectivity': {
    params: ['NetworkWatcher', 'SourceId', 'DestinationId', 'DestinationPort'],
    mandatory: ['NetworkWatcher', 'SourceId', 'DestinationId', 'DestinationPort'],
    build: (a) => ({ az: ['network', 'watcher', 'test-connectivity', '--source-resource', last(a.sourceid), '--dest-resource', last(a.destinationid), '--dest-port', s(a.destinationport), '-g', RG], json: true, shape: pascalKeys }),
  },
};
