#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Install the plugin separately with map/install.py. This deployment never restarts Paper.
python3 "$root/map/marker_icons.py"
install -m 0644 "$root/diary/index.html" "$root/diary/map.css" "$root/diary/map.js" /var/www/roybot.se/minecraft/
install -m 0644 "$root/diary/minecraft.roybot.se.conf" /etc/nginx/sites-available/minecraft.roybot.se
nginx -t
systemctl reload nginx
curl --fail --silent --show-error https://minecraft.roybot.se/map/ >/dev/null
