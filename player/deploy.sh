#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Deploy failed at line $LINENO: $BASH_COMMAND" >&2' ERR
[[ $EUID -eq 0 ]] || { echo 'Deploy as root; player runs nonroot.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=${PLAYER_DEPLOY_ROOT:-/opt/minecraft-adventure}
observation=${PLAYER_OBSERVATION_FILE:-/var/lib/minecraft-adventure/observations/state.json}
command -v trash >/dev/null
stage=$(mktemp -d)
trap 'trash -- "$stage"' EXIT

# Test and prepare everything before interrupting play. No legacy gameplay files.
npm --prefix "$source_dir" test
npm --prefix "$source_dir" run check
node --test "$source_dir"/../bots/test/viewer*.test.mjs
install -d -m0755 "$stage/player" "$stage/bots"
install -m0644 "$source_dir"/*.mjs "$source_dir"/package*.json "$stage/player/"
install -m0644 "$source_dir"/../bots/viewer*.mjs \
    "$source_dir"/../bots/compat-loader.mjs "$source_dir"/../bots/inventory-controller.mjs \
    "$source_dir"/../bots/chunk-light.mjs \
    "$source_dir"/../bots/build-viewer.mjs "$stage/bots/"
npm ci --prefix "$stage/player" --omit=dev --ignore-scripts --no-audit --no-fund
chmod -R a+rX "$stage/player/node_modules"
node "$stage/bots/build-viewer.mjs"
# Bootstrap (install.sh) supplies users, units, sandbox and static Minecraft assets.
test -d "$root/player/node_modules"
test -d "$root/bots/assets/entities"
node -e 'const fs = require("node:fs"); const state = JSON.parse(fs.readFileSync(process.argv[1])); if (!state.bots[0].session) throw Error("Missing previous player session"); fs.writeFileSync(process.argv[2], state.bots[0].session)' "$observation" "$stage/previous-session"
started=$(date -u +%FT%T.000Z)

systemctl stop minecraft-player.service
install -m0644 "$stage/player"/*.mjs "$stage/player"/package*.json "$root/player/"
mv "$root/player/node_modules" "$stage/previous-node_modules"
mv "$stage/player/node_modules" "$root/player/node_modules"
install -m0644 "$stage/bots"/*.mjs "$root/bots/"
install -m0644 "$stage/bots/assets/worker.js" "$root/bots/assets/worker.js"
node "$root/player/sandbox-install.mjs"
systemctl start minecraft-player.service
node "$source_dir/check-deploy.mjs" "$observation" "$stage/previous-session" "$started"
printf '%s\n' 'Player deployed; health, feed and fresh observation verified. Paper was not restarted.'
