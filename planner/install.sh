#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target=/opt/minecraft-adventure/planner

if [[ "$(id -u)" != 0 ]]; then
    echo "Run this installer as root." >&2
    exit 1
fi

getent group minecraft-adventure-project >/dev/null
if ! getent passwd minecraft-planner >/dev/null; then
    useradd --system --user-group --home-dir /var/lib/minecraft-planner --shell /usr/sbin/nologin minecraft-planner
fi
usermod -a -G minecraft-adventure-project minecraft-planner
install -d -o root -g root -m 0755 "$target"
install -d -o root -g root -m 0700 /etc/minecraft-adventure
install -d -o minecraft-planner -g minecraft-adventure-project -m 2770 /var/lib/minecraft-adventure/control
install -d -o minecraft-planner -g minecraft-planner -m 0750 /var/lib/minecraft-planner

for name in package.json package-lock.json contracts.mjs item-ids.json queue.mjs admission.mjs engine.mjs evidence.mjs strategy.mjs diary.mjs server.mjs credential-broker.mjs; do
    install -o root -g root -m 0644 "$source_dir/$name" "$target/$name"
done
(cd "$target" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
chmod -R a+rX "$target/node_modules"
install -o root -g root -m 0644 "$source_dir/minecraft-planner-auth.service" /etc/systemd/system/
install -o root -g root -m 0644 "$source_dir/minecraft-planner.service" /etc/systemd/system/

if [[ ! -f /etc/minecraft-adventure/planner.env ]]; then
    umask 077
    node --input-type=module - <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
writeFileSync('/etc/minecraft-adventure/planner.env',
    'PLANNER_RELAY_TOKEN=' + randomBytes(32).toString('hex') + '\n',
    { mode: 0o600, flag: 'wx' });
JS
fi

systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/minecraft-planner{,-auth}.service
echo "Installed. Services are not started or enabled by this script."
echo "Bots need OPENAI_API_KEY set to PLANNER_RELAY_TOKEN from /etc/minecraft-adventure/planner.env."
