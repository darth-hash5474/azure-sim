// Game registry. Shared by the menu UI and vite.config.ts (which serves and bundles each game).
// To add a game: create its Vite app as a sibling folder of Menu/, set `base: './'` in its
// vite.config.ts, then add an entry here.

export type Az104Domain = 'identity' | 'storage' | 'compute' | 'networking' | 'monitoring';

export interface Game {
  /** URL slug: the game is served at games/<id>/ */
  id: string;
  /** Folder name under d:\azure-admin */
  dir: string;
  title: string;
  domain: Az104Domain;
  /** One-line hook shown in the list */
  tagline: string;
  /** Mission briefing shown in the detail panel */
  briefing: string;
  /** Concepts the player practises */
  skills: string[];
  format: string;
}

// The five domains of the AZ-104 skills outline, with their exam weightings.
export const DOMAINS: Record<Az104Domain, { label: string; weight: string }> = {
  identity: { label: 'Manage Azure identities and governance', weight: '20–25%' },
  storage: { label: 'Implement and manage storage', weight: '15–20%' },
  compute: { label: 'Deploy and manage Azure compute resources', weight: '20–25%' },
  networking: { label: 'Implement and manage virtual networking', weight: '15–20%' },
  monitoring: { label: 'Monitor and maintain Azure resources', weight: '10–15%' },
};

export const GAMES: Game[] = [
  {
    id: 'manage-resources',
    dir: 'Manage-Resources',
    title: 'Manage Resources',
    domain: 'identity',
    tagline: 'Tag, move and retire a sprawling resource group before the finance audit lands.',
    briefing:
      "The shop team's dev estate is piled into one resource group and finance audits at end of day. " +
      'Tag every resource with its cost center, move each one into its team group and retire the old group, ' +
      'all from a simulated Azure CLI, while a lock and your RBAC role keep getting in the way.',
    skills: [
      'Resource tags: no inheritance, merge vs replace',
      'Moving resources between resource groups',
      'Resource group lifecycle, locks and who can remove them',
    ],
    format: 'CLI cleanup puzzle',
  },
  {
    id: 'cold-storage',
    dir: 'Cold-Storage',
    title: 'Cold Storage',
    domain: 'storage',
    tagline: 'Work a storage ops shift where every config choice comes back as an incident.',
    briefing:
      'You own contosodata for one shift. Nine tickets arrive in order: redundancy, soft delete, a partner SAS, ' +
      'a file share, lifecycle rules, then the incidents. A deleted container, an archived ledger due in an hour, ' +
      'a leaked token, a firewall cut-over. Later tickets run against the account exactly as you left it.',
    skills: [
      'Redundancy (LRS to RA-GZRS) and access tiers',
      'SAS types, stored access policies and key rotation',
      'Soft delete, lifecycle, Azure Files and the storage firewall',
    ],
    format: 'Ops shift ticket queue',
  },
  {
    id: 'slot-swap',
    dir: 'Slot-Swap',
    title: 'Slot Swap',
    domain: 'compute',
    tagline: 'Ship release v2 tonight: fix the Bicep, swap the slot, survive the traffic.',
    briefing:
      'Release v2 goes live tonight and the staging slot does not exist yet. Fix and deploy the Bicep template, ' +
      'test v2 on staging, swap it into production without dragging the staging database along, scale out for the ' +
      'launch and resize a zonal VM, all from a simulated Azure CLI.',
    skills: [
      'Bicep deployments: what-if, Incremental vs Complete mode',
      'App Service slots, sticky slot settings and swaps; scale up vs out',
      'VM sizes, availability zones and resizing',
    ],
    format: 'CLI launch-night drill',
  },
  {
    id: 'no-route',
    dir: 'No-Route',
    title: 'No Route',
    domain: 'networking',
    tagline: 'Three faults stand between a web VM and its database. Find them in packet order.',
    briefing:
      'web-vm cannot reach SQL on db-vm across two peered virtual networks since Monday\'s network change. ' +
      'Trace the packet with Network Watcher, fix the route, the peering and the NSG with the smallest change, ' +
      'and keep the firewall route and the database exposure exactly as they should be.',
    skills: [
      'Virtual network peering and effective routes',
      'User-defined routes and next hops',
      'NSG rule priority, test-ip-flow and test-connectivity',
    ],
    format: 'CLI troubleshooting puzzle',
  },
  {
    id: 'night-shift',
    dir: 'Night-Shift',
    title: 'Night Shift',
    domain: 'monitoring',
    tagline: 'A 2 a.m. pager storm and a runaway job. Be on call and get the VM back.',
    briefing:
      'The on-call phone will not stop and a runaway job will delete batch-vm at 03:15. Read metrics and query ' +
      'logs to find who started it, build a real alert, silence a rule you do not own, and back the VM up in ' +
      'time to restore it, with every command costing a minute of the night.',
    skills: [
      'Azure Monitor metrics, KQL log queries and data collection rules',
      'Alert rules, action groups and alert processing rules',
      'Recovery Services vaults, backup policies and restore',
    ],
    format: 'Timed CLI incident',
  },
];
