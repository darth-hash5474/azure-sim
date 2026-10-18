# Slot Swap

AZ-104 drill #4 (compute): **Bicep deployments, App Service deployment slots and scaling, VM sizes and zones**.

Release v2 of `shop-web` goes live tonight. From a simulated Cloud Shell you have to:

- fix `main.bicep` and deploy it, so the staging slot exists (preview with `what-if` first),
- test v2 on staging and swap it into production without leaking the staging database into prod,
- scale the plan out for launch traffic,
- resize `batch-vm` to 4+ vCPU and 16+ GiB while keeping it in availability zone 2.

Type `ls` and `cat main.bicep` in the game to start, `hint` if you get stuck and `submit` to run the go-live review.

Concepts covered:

- Deployment slots need a Standard, Premium or Isolated plan; Free and Basic do not support them.
- `what-if` previews a deployment. Incremental mode leaves unlisted resources alone; Complete mode deletes them.
- A swap exchanges content and every setting that is not a slot setting. Sticky slot settings stay put. A second swap is the rollback.
- Scale up (SKU) vs scale out (instances), per-tier instance limits, and a template capacity parameter resetting the count on redeploy.
- A zonal VM can only use sizes offered in its zone, and a resize restarts it.

The game logic is in `src/engine.ts` (a simulated slice of ARM, App Service and the Azure CLI); `src/App.tsx` is the terminal UI.

Scratch folder: `~/scratch` holds `main.bicep`, an ARM `params.json` and an `appsettings.json`. Edit them live in the panel under the terminal and send them to the CLI:

```
az deployment group what-if -g launch-rg --template-file main.bicep --parameters @params.json
az webapp config appsettings set -n shop-web -g launch-rg --slot staging --settings @appsettings.json
az webapp config appsettings list -n shop-web -g launch-rg > appsettings.json
```

`params.json` is a real ARM parameters file (it overrides the template defaults; `name=value` pairs win over it). In `appsettings.json` a `"slotSetting": true` entry makes the setting stick to its slot. Also `ls`, `cat`, `edit`, `touch`, `rm` and `sed -i`. Broken JSON fails the command with a parse error. The folder resets on `restart`.

```
npm install
npm run dev
```

## Shell

The terminal is a simulated bash shell around the `az` CLI.

- **Multi-line:** end a line with `\`, leave a quote open, or press Shift+Enter. Pasted blocks run as typed.
- **JSON in:** `@file.json`, an inline `'{...}'` argument, `"$(cat file.json)"`, a heredoc (`cat > f.json <<'EOF'` ... `EOF`) or `echo '{...}' > f.json`. `jq` reads values back.
- Scripts written in the editor run with `bash script.sh` or `./script.sh`.
