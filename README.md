# AZ-104 Sim

Five browser games for practising the Microsoft **AZ-104: Azure Administrator** exam, one for each domain in the skills outline. Each game drops you into a simulated Cloud Shell with a realistic ticket to work through. You use real `az` CLI syntax against a simulated Azure environment that reacts the way the real one does, including its gotchas.

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

- **Simulated Azure, not a quiz.** Each game has a pure TypeScript engine (`src/engine.ts`) on top of the shared shell in `packages/shell` that models a small slice of Azure: route selection by longest prefix, NSG evaluation by priority, slot swaps with sticky settings and so on. Your commands change that state, and later steps run against whatever you left behind.
- **A real-feeling shell.** The terminal is a simulated bash shell around the `az` CLI, with pipes, variables, heredocs, multi-line input and `jq`.
- **A scratch folder.** Every game has `~/scratch` with JSON templates you can edit in a panel under the terminal and send with `az rest --body @file.json`, the way you would against the real ARM API.
- **Menu.** `Menu/` is the launcher. Its build compiles every game and bundles them into one static site under `games/<id>/`.

## Run it locally

Requires Node.js 22.12 or later.

```bash
npm ci        # one install at the root covers every app and the shared packages (npm workspaces)
npm run dev   # starts the menu; it builds any game that has not been built yet
```

`npm run build` produces the full static site in `Menu/dist/`. `npm run typecheck` and `npm run lint` run across every workspace.

To work on one game by itself, run `npm run dev -w No-Route` (or any other game folder).

## Tech

React 19, TypeScript, Vite and Tailwind CSS. There is no backend: the whole simulation runs in the browser.

## Repository layout

```
packages/
  shell/            the simulated bash shell: parsing, pipes, heredocs, quoting, ~/scratch (no React)
  terminal-ui/      shared React components (terminal prompt, scratch editor) and the CRT theme
Menu/               launcher and build that bundles every game
Manage-Resources/   identity and governance
Cold-Storage/       storage
Slot-Swap/          compute
No-Route/           networking
Night-Shift/        monitoring
```

Each game folder holds only what is specific to it: `src/engine.ts` (its slice of Azure) and `src/App.tsx` (its UI).
