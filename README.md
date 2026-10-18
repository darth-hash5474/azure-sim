# AZ-104 Sim

Five browser games for practising the Microsoft **AZ-104: Azure Administrator** exam, one for each domain in the skills outline. Each game drops you into a simulated Cloud Shell with a realistic ticket to work through. You use the real `az` CLI syntax (or Az PowerShell cmdlets) against a simulated Azure environment that reacts the way the real one does, including its gotchas.

No Azure subscription needed, and nothing you do costs money.

## The games

| Game | Exam domain | Format | What you practise |
| --- | --- | --- | --- |
| **Manage Resources** | Identities and governance (20–25%) | CLI cleanup puzzle | Tags (no inheritance, merge vs replace), moving resources between groups, locks and RBAC |
| **Cold Storage** | Storage (15–20%) | Ops shift ticket queue | Redundancy and access tiers, SAS and stored access policies, soft delete, lifecycle rules, Azure Files, the storage firewall |
| **Slot Swap** | Compute (20–25%) | CLI launch-night drill | Bicep what-if and deployment modes, App Service slots and sticky settings, scale up vs out, VM sizes and zones |
| **No Route** | Networking (15–20%) | CLI troubleshooting puzzle | VNet peering, user-defined routes, NSG rule priority, Network Watcher |
| **Night Shift** | Monitoring (10–15%) | Timed CLI incident | Metrics and KQL, alert rules, action groups and processing rules, Recovery Services backup and restore |

Each game folder has its own README with the scenario and concepts in more detail.

## How it works

- **Simulated Azure, not a quiz.** Each game has a pure TypeScript engine (`src/engine.ts`) that models a small slice of Azure: route selection by longest prefix, NSG evaluation by priority, slot swaps with sticky settings and so on. Your commands change that state, and later steps run against whatever you left behind.
- **A real-feeling shell.** The terminal runs bash or PowerShell (switch with the tabs or type `pwsh` / `bash`), with pipes, variables, heredocs, multi-line input, `jq`, and `ConvertFrom-Json` / `ConvertTo-Json`.
- **A scratch folder.** Every game has `~/scratch` with JSON templates you can edit in a panel under the terminal and send with `az rest --body @file.json`, the way you would against the real ARM API.
- **Menu.** `Menu/` is the launcher. Its build compiles every game and bundles them into one static site under `games/<id>/`.

## Run it locally

Requires Node.js 22.12 or later.

```bash
# install every app (they are separate Vite projects)
for d in Menu Manage-Resources Cold-Storage Slot-Swap No-Route Night-Shift; do (cd "$d" && npm ci); done

# start the menu; it builds any game that has not been built yet
cd Menu && npm run dev
```

`npm run build` in `Menu/` produces the full static site in `Menu/dist/`.

To work on one game by itself, run `npm run dev` in that game's folder.

## Tech

React 19, TypeScript, Vite and Tailwind CSS. There is no backend: the whole simulation runs in the browser.

## Repository layout

```
Menu/               launcher and build that bundles every game
Manage-Resources/   identity and governance
Cold-Storage/       storage
Slot-Swap/          compute
No-Route/           networking
Night-Shift/        monitoring
```
