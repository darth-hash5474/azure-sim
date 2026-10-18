# Manage Resources

AZ-104 drill #3 (identities and governance): **tags, moving resources and resource group lifecycle**.

Finance audit FA-26-Q4 lands at end of day and the shop team's dev estate is piled into `sprawl-rg`.
From a simulated Cloud Shell you have to:

- tag every resource with the right `CostCenter` (the audit reads resource tags, not group tags) without losing the existing `Env` tag,
- create the team resource groups and move each resource into its own,
- retire `sprawl-rg` once it is empty, without losing anything.

Type `cat audit.txt` in the game for the brief, `hint` if you get stuck and `submit` to file the audit.

Concepts covered:

- Resource group tags are not inherited by the resources in them (Azure Policy can copy them down).
- `az resource tag` replaces the whole tag set unless you pass `--is-incremental`; `az tag update --operation Merge` merges.
- A move changes the resource group and the resource ID, never the region, and tags travel with the resource.
- A VM, its NIC and its managed disk have to move together.
- A `CanNotDelete` lock blocks moving or deleting out of a group, and only Owner or User Access Administrator can remove it.
- Deleting a resource group deletes everything in it.

Scratch folder: the game has a small in-memory `~/scratch` with editable files (`tags.json`, `ids.json`). Edit them live in the panel under the terminal and feed them to the CLI:

```
az resource tag --ids shop-web shop-plan --tags @tags.json --is-incremental
az resource move --destination-group app-rg --ids @ids.json
az resource list -o json > inventory.json
```

Also `ls`, `cat`, `edit`, `touch` and `rm`. Broken JSON fails the command with a parse error. The folder resets on `restart`.

The game logic is in `src/engine.ts` (a simulated slice of ARM and the Azure CLI); `src/App.tsx` is the terminal UI.

```
npm install
npm run dev
```

## Shell

The terminal is a simulated bash shell around the `az` CLI.

- **Multi-line:** end a line with `\`, leave a quote open, or press Shift+Enter. Pasted blocks run as typed.
- **JSON in:** `@file.json`, an inline `'{...}'` argument, `"$(cat file.json)"`, a heredoc (`cat > f.json <<'EOF'` ... `EOF`) or `echo '{...}' > f.json`. `jq` reads values back.
- Scripts written in the editor run with `bash script.sh` or `./script.sh`.
