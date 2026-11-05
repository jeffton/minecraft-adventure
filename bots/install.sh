#!/usr/bin/env bash
set -euo pipefail
umask 027
[[ $EUID -eq 0 ]] || { echo 'Install as root; runtime is non-root.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
target=/opt/minecraft-adventure/bots
getent passwd minecraft-bots >/dev/null
getent group minecraft-adventure-project >/dev/null
[[ -x /usr/bin/node && $(/usr/bin/node -p 'process.versions.node.split(".")[0]') == 26 && -d /opt/minecraft-mindcraft/node_modules ]]
install -d -m0755 "$target"
for file in "$source_dir"/*.mjs "$source_dir"/package.json; do
  install -o root -g root -m0644 "$file" "$target/"
done
/usr/bin/node "$target/build-viewer.mjs"
/usr/bin/node "$target/build-entity-assets.mjs"
install -d -o minecraft-bots -g minecraft-bots -m0750 /var/lib/minecraft-adventure/bots
install -d -o root -g root -m0700 /etc/minecraft-adventure
python3 - <<'PY'
import os
from pathlib import Path
values = {}
for line in Path('/etc/minecraft-adventure/planner.env').read_text().splitlines():
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        values[key] = value.strip().strip('"').strip("'")
token = values['PLANNER_RELAY_TOKEN']
if not token or '\n' in token or '\r' in token:
    raise ValueError('Invalid relay token')
fd = os.open('/etc/minecraft-adventure/bots.env', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('OPENAI_API_KEY=' + token + '\n')
os.chmod('/etc/minecraft-adventure/bots.env', 0o600)
PY
install -o root -g root -m0644 "$source_dir/minecraft-adventure-bots.service" /etc/systemd/system/
systemctl daemon-reload
if [[ ${1:-} == --start ]]; then
  systemctl enable --now minecraft-adventure-bots.service
fi
