# Night Shift

AZ-104 drill #6 (monitoring and backup): **Azure Monitor metrics and logs, alert rules, action groups, alert processing rules and Azure Backup**.

It is 02:12 and `batch-vm` is in trouble: the on-call phone is buzzing and a runaway job will delete the VM at 03:15.
From a simulated Cloud Shell you have to:

- find the busy VM and who started the job, with metrics and a KQL query in Log Analytics,
- build the alert you would want (average CPU above 85%, paging an action group with a real email receiver),
- silence the page storm from a rule you are not allowed to edit,
- back batch-vm up before 03:15, then restore it after the job deletes it.

Every `az` command costs a minute of the night, and the clock is in the side panel. Type `cat ticket.txt` in the game to
start, `hint` if you get stuck, `wait` to skip ahead to the next event and `submit` to hand over.

Concepts covered:

- Platform metrics need no setup. Guest logs need the Azure Monitor Agent and a data collection rule, flow only from the moment you add it, and arrive after a few minutes.
- Virtual machines have no resource logs, so a diagnostic setting on one has nothing to route.
- An alert rule is a condition plus action groups; the evaluation frequency cannot exceed the window size.
- An alert processing rule (`RemoveAllActionGroups`) silences notifications without editing the rule.
- VM backup needs a Recovery Services vault in the VM's own region; a Backup vault cannot protect VMs. A backup has to exist before the disaster.

The game logic is in `src/engine.ts` (a simulated slice of Azure Monitor and Backup); `src/App.tsx` is the terminal UI.

Scratch folder: `~/scratch` holds `ticket.txt`, `query.kql`, `actiongroup.json`, `alert.json` and `silence.json`. Edit them live in the panel under the terminal:

```
az monitor log-analytics query -w law-ops --analytics-query @query.kql
az rest --method put --url .../Microsoft.Insights/actionGroups/oncall-ag --body @actiongroup.json
az rest --method put --url .../Microsoft.Insights/metricAlerts/high-cpu --body @alert.json
az rest --method put --url .../Microsoft.AlertsManagement/actionRules/silence --body @silence.json
az rest --method get --url .../Microsoft.Insights/metricAlerts/cpu-test > cpu.json
```

Lines starting with `//` in a KQL file are comments. Every command still costs a minute of the night. `cpu-test` is owned by the platform team and cannot be changed through `az rest` either. The folder resets on `restart`.

```
npm install
npm run dev
```

## Shell

The terminal is a simulated bash shell around the `az` CLI.

- **Multi-line:** end a line with `\`, leave a quote open, or press Shift+Enter. Pasted blocks run as typed.
- **JSON in:** `@file.json`, an inline `'{...}'` argument, `"$(cat file.json)"`, a heredoc (`cat > f.json <<'EOF'` ... `EOF`) or `echo '{...}' > f.json`. `jq` reads values back.
- Scripts written in the editor run with `bash script.sh` or `./script.sh`.
