# Cooperative survival agents

Live diary and read-only game feed: https://minecraft.roybot.se/

Four non-root Mindcraft agents connect to the private offline Velocity listener at `127.0.0.1:25567`. Public players still use authenticated Velocity and the server whitelist. The server is Paper 26.3; bots negotiate 1.21.4 through ViaBackwards so the Prismarine viewer uses matching block-state assets.

- **Roy:** shared timber-lodge construction and expedition coordination.
- **Spruce:** wood and building supplies.
- **Flint:** mining, smelting and equipment.
- **Moss:** food, beds and renewable supplies.

## Runtime

`launch.mjs` starts upstream Mindcraft. Terra writes short declarative behavior programs through the authenticated local relay at `127.0.0.1:8766/v1/chat/completions`; idle bots execute them locally, checking inventory and mission revisions between gameplay operations. A blocked program permits one model-selected repair action after 45 seconds. Its bearer token comes from the root-readable systemd environment file, not the repository. Generated JavaScript, cheat toggles, player attacks and peer-conversation loops are disabled. Shared plans, real deliveries and storage coordinate the team. External game chat cannot drive agent actions.

Authored commands add a surveyed shared site, incremental survival lodge construction and conservative expedition tools: earned obsidian portal construction, portal entry, Eye throwing, End-portal filling, and crystal/dragon combat. All use real inventories and world interactions. Dragon victory is an objective, not a guaranteed solved speedrun; finding a fortress/stronghold, sufficient equipment and successful navigation remain real work.

`bootstrap.mjs` supplies narrowly checked runtime integration hooks; upstream source stays unchanged. `compat-loader.mjs` matches vanilla Java float-backed player dimensions and closes Mineflayer's physics/teleport client ticks for Paper 26.3. Unexpected upstream integration points fail explicitly.

## Files and services

- Source dependency: `/opt/minecraft-mindcraft`, commit `e1c1fc3ffa481506c2445fc639e16dba504b5920`.
- Node runtime: `/opt/node-minecraft22`, Node 22.23.4; native canvas/gl dependencies match this ABI.
- Writable bot memory: `/var/lib/minecraft-adventure/bots`.
- Shared mission: `/var/lib/minecraft-adventure/control/mission.json`.
- Atomic state: `/var/lib/minecraft-adventure/observations/state.json`, every 10 seconds; per-bot observations every 5 seconds.
- Observed scene voxels: `observations/scene.json`, every 30 seconds, from Roy's received world chunks.
- Read-only first-person viewer: `127.0.0.1:8931`, eight public sockets plus one reserved local diary capture. Nginx must overwrite `X-Roycraft-Public-Viewer: 1` on every public request. `window.roycraftReady` requires rendered world geometry and live socket traffic; disconnects clear it.
- Mindcraft's private management socket: `127.0.0.1:8930`; never expose it through nginx.

The bot account belongs only to its private group and `minecraft-adventure-project`, not the server's secret-bearing group. Its network access is loopback-only. The service cannot write code or read home directories.

## Verification

Run `npm test` with the project Node runtime. `smoke.mjs` verifies a real whitelisted survival join, unknown-name rejection and direct-backend forwarding rejection; preload `compat-loader.mjs` for this standalone test. Installation is `bash install.sh --start` after review and after the relay/server are ready. Installation does not expose any tokens in output.
