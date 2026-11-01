#!/usr/bin/env bash
set -euo pipefail
trap 'echo "UI publication failed at line $LINENO: $BASH_COMMAND" >&2' ERR
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
target=${DIARY_UI_ROOT:-/var/www/roybot.se/minecraft}
files=(index.html style.css app.js map.css map.js inventory.css inventory.js world-clock.js)
for file in "${files[@]}"; do
    test -r "$source_dir/$file"
done
for file in app.js map.js inventory.js world-clock.js; do
    node --check "$source_dir/$file"
done
node --test "$source_dir/test-inventory.mjs" "$source_dir/test-world-clock.mjs"
test -d "$target"
for file in "${files[@]}"; do
    install -m0644 "$source_dir/$file" "$target/$file"
done
printf '%s\n' 'Static UI published. Journal data, assets, services and dependencies unchanged.'
