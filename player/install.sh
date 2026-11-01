#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Install as root; player runs nonroot.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
target=/opt/minecraft-adventure/player
install -d -m0755 "$target"
for file in "$source_dir"/*.mjs "$source_dir"/package*.json "$source_dir"/fresh-world.py; do
    install -o root -g root -m0644 "$file" "$target/"
done
npm ci --prefix "$target" --omit=dev --ignore-scripts --no-audit --no-fund
chmod -R a+rX "$target/node_modules"
node "$target/sandbox-install.mjs"
install -m0644 "$source_dir"/minecraft-player*.service "$source_dir"/minecraft-player*.socket /etc/systemd/system/
install -d -o minecraft-bots -g minecraft-bots -m0750 /var/lib/minecraft-player
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/minecraft-player.service /etc/systemd/system/minecraft-player-sandbox.service /etc/systemd/system/minecraft-player-sandbox.socket
echo 'Installed without starting services or changing any world.'
