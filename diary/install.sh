#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
getent group minecraft-diary >/dev/null || groupadd --system minecraft-diary
id minecraft-diary >/dev/null 2>&1 || useradd --system --gid minecraft-diary --home-dir /nonexistent --shell /usr/sbin/nologin minecraft-diary
setfacl -m u:minecraft-diary:r-X,d:u:minecraft-diary:r-X /var/lib/minecraft-adventure/observations
install -d -m 0755 /opt/minecraft-adventure/diary
for file in publish.py capture.mjs vision-capture.mjs package.json package-lock.json; do
    install -m 0644 "$source_dir/$file" /opt/minecraft-adventure/diary/
done
npm ci --ignore-scripts --prefix /opt/minecraft-adventure/diary
chmod -R a+rX /opt/minecraft-adventure/diary/node_modules
install -d -o minecraft-diary -g minecraft-diary -m 0755 /var/www/roybot.se/minecraft
python3 "$source_dir/build-item-assets.py" \
    /opt/minecraft-mindcraft/node_modules/minecraft-assets/minecraft-assets/data/26.1 \
    /var/www/roybot.se/minecraft/item-assets
for file in index.html style.css app.js map.css map.js inventory.css inventory.js; do
    install -m 0644 "$source_dir/$file" /var/www/roybot.se/minecraft/
done
test -r /etc/letsencrypt/live/minecraft.roybot.se/fullchain.pem
install -m 0644 "$source_dir/minecraft.roybot.se.conf" /etc/nginx/sites-available/minecraft.roybot.se
if [[ ! -e /etc/nginx/sites-enabled/minecraft.roybot.se ]]; then
    ln -s /etc/nginx/sites-available/minecraft.roybot.se /etc/nginx/sites-enabled/minecraft.roybot.se
fi
install -m 0644 "$source_dir/nginx.conf" /etc/nginx/snippets/roycraft-diary.conf
install -m 0644 "$source_dir/minecraft-adventure-diary.service" /etc/systemd/system/
install -m 0644 "$source_dir/minecraft-adventure-diary.timer" /etc/systemd/system/
install -m 0644 "$source_dir/minecraft-building-camera.service" /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/minecraft-adventure-diary.service /etc/systemd/system/minecraft-adventure-diary.timer
nginx -t
systemctl reload nginx
printf '%s\n' 'Canonical HTTPS site installed. Legacy roybot.se redirect uses snippets/roycraft-diary.conf; enable diary timer after the real bot-camera smoke.'
