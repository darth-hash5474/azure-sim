# No Route

AZ-104 drill #5 (networking): **virtual network peering, user-defined routes, NSG rule priority and Network Watcher**.

`web-vm` (vnet-web) cannot reach SQL on `db-vm` (vnet-data) after a network change. From a simulated Cloud Shell you
have to find what broke and restore the connection with the smallest change, while:

- keeping the firewall default route in place,
- keeping the database closed to everyone except the web subnet, including the rest of vnet-web and the internet,
- using five changes or fewer.

There are three stacked faults, and fixing one reveals the next. Type `cat ticket.txt` in the game to start, `hint` if you
get stuck and `submit` to run the connectivity review.

Concepts covered:

- Debug in packet order: routing first, then NSGs. `test-ip-flow` checks NSGs only; `test-connectivity` and `show-next-hop` find routing faults.
- A user-defined route beats a system route for the same prefix, and the longest prefix always wins first.
- A peering needs both halves, and the CLI needs `--allow-vnet-access` to let traffic through.
- NSG rules are evaluated by priority number, lowest first. A broad Deny shadows a narrower Allow behind it.
- Peering extends the `VirtualNetwork` tag across both networks.

The game logic is in `src/engine.ts` (a simulated slice of Azure networking); `src/App.tsx` is the terminal UI.

Scratch folder: `~/scratch` holds `ticket.txt`, `rule.json` and `peering.json`. Edit them live in the panel under the terminal and send them with `az rest`:

```
az rest --method put --url /subscriptions/<sub>/resourceGroups/net-rg/providers/Microsoft.Network/networkSecurityGroups/nsg-db/securityRules/allow-sql-web --body @rule.json
az rest --method put --url .../virtualNetworks/vnet-data/virtualNetworkPeerings/data-to-web --body @peering.json
az rest --method get --url .../networkSecurityGroups/nsg-db > nsg.json
```

`az rest` also works on `routeTables/rt-web/routes/<name>`. A PUT replaces the whole resource with exactly what the body says, and every PUT or DELETE counts toward the change limit. `help` shows the paths. The folder resets on `restart`.

```
npm install
npm run dev
```

## Shell: bash and PowerShell

The terminal is a real-feeling shell. Switch with the **bash / PowerShell** tabs in the title bar, or type `pwsh` and `bash` (`exit` also goes back). The `az` CLI works in both; PowerShell adds Az cmdlets (`cmdlets` lists them: Get-AzRouteTable, Remove-AzRouteConfig, Set-AzNetworkSecurityRuleConfig, Add-AzVirtualNetworkPeering, Get-AzNetworkWatcherNextHop, Test-AzNetworkWatcherIPFlow).

- **Multi-line:** end a line with `\` (bash) or a backtick (PowerShell), leave a quote or `@(`/`{` open, or press Shift+Enter. Pasted blocks run as typed.
- **JSON in:** `@file.json`, an inline `'{...}'` argument, `"$(cat file.json)"`, a heredoc (`cat > f.json <<'EOF'` ... `EOF`) or `echo '{...}' > f.json`. `jq` reads values back.
- **PowerShell JSON:** `$o = Get-Content f.json -Raw | ConvertFrom-Json`, edit `$o.a.b = 1`, then `$o | ConvertTo-Json -Depth 10 | Set-Content f.json` (watch the default depth of 2).
- **Same job, both ways:** `az rest --method put --body @peering.json` or `Set-AzRouteTable (after Remove-AzRouteConfig), Set-AzNetworkSecurityGroup, Add-AzVirtualNetworkPeering`.
- Scripts written in the editor run with `bash script.sh` or `./script.ps1`.

