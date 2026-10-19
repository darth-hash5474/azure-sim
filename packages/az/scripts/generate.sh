#!/usr/bin/env bash
# Regenerates src/registry.json and the help fixtures from the Azure CLI installed on this machine.
# Uses the CLI's bundled Python so its modules import exactly as `az` does.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
py="$(dirname "$(readlink -f "$(command -v az)")")/../lib/azure-cli/bin/python3"
for candidate in "$py" /opt/az/bin/python3 /usr/lib/azure-cli/bin/python3; do
  if [ -x "$candidate" ]; then exec "$candidate" -I "$here/generate.py"; fi
done
echo "Could not find the Python bundled with the Azure CLI" >&2
exit 1
