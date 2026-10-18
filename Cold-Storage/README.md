# Cold Storage

AZ-104 drill #3 (implement and manage storage): **one storage ops shift**.

You run the shift for `contosodata` (StorageV2, Standard_LRS, East US) from a simulated Cloud Shell. Nine tickets
arrive in order. Do the work with `az` commands, then `submit`. Later incidents run against the account exactly
as you configured it, so earlier shortcuts come back to bite.

| Ticket  | Task                                   | Concept                                               |
| ------- | -------------------------------------- | ----------------------------------------------------- |
| CHG-301 | Survive a region outage, cheaply       | LRS / ZRS / GRS / RA-GRS / GZRS, zone conversions     |
| CHG-302 | Make deleted containers recoverable    | Container soft delete vs blob soft delete, versioning |
| CHG-303 | Read-only partner access to `invoices` | Account vs service vs user delegation SAS             |
| CHG-304 | 100 GiB finance file share             | Azure Files tiers and quotas                          |
| CHG-305 | Pick the right lifecycle policy        | Lifecycle rules, prefixMatch, day counts              |
| INC-306 | `media` container deleted              | Restoring a soft-deleted container                    |
| INC-307 | Archived ledger needed within the hour | Archive rehydration, Standard vs High priority        |
| INC-308 | Partner SAS leaked                     | Stored access policies, delegation keys, key rotation |
| CHG-309 | Close the public endpoint              | Storage firewall, service endpoints, IP rule limits   |

`help` lists every supported command, `hint` nudges on the open ticket, and `skip` closes it as failed.

Scratch folder: `~/scratch` holds the three lifecycle policy drafts as real files (`logs-v1.json`, `logs-v2.json`, `logs-v3.json`). Edit them live in the panel under the terminal, fix a broken one if you like, then apply it:

```
az storage account management-policy create --account-name contosodata -g data-rg --policy @logs-v2.json
az storage account management-policy show --account-name contosodata -g data-rg > mine.json
```

The policy is checked as it was when you applied it, so editing a file afterwards changes nothing until you apply it again. A file that is not a valid policy (no `rules`, a bad `type`, a missing `definition.actions`) is rejected on apply. The old `policies/<file>` spelling still works. The folder resets on `restart`.

The game logic now lives in `src/engine.ts`; `src/App.tsx` is the UI.

```
npm install
npm run dev
```

## Shell

The terminal is a simulated bash shell around the `az` CLI.

- **Multi-line:** end a line with `\`, leave a quote open, or press Shift+Enter. Pasted blocks run as typed.
- **JSON in:** `@file.json`, an inline `'{...}'` argument, `"$(cat file.json)"`, a heredoc (`cat > f.json <<'EOF'` ... `EOF`) or `echo '{...}' > f.json`. `jq` reads values back.
- Scripts written in the editor run with `bash script.sh` or `./script.sh`.
