# Roycraft

A cooperative survival expedition at **minecraft.roybot.se**, with a field journal and read-only live bot camera at **https://minecraft.roybot.se/**.

## Runtime

- Paper 26.3 / Java 25: ordinary world generation, survival, normal difficulty, enforced historical whitelist.
- Public Velocity requires Microsoft authentication. A separate loopback-only Velocity admits the four offline bot identities. Both use secret-authenticated modern forwarding to the loopback backend.
- Mineflayer/Mindcraft: Roy builds, Spruce supplies timber, Flint mines and smiths, Moss supplies food. Client protocol 1.21.4 is translated by ViaBackwards and matches the renderer's actual block definitions.
- Codex 6.1 Sol (medium) reviews persistent objectives every five minutes and on observed completion or repeated stagnation; 6.1 Terra (low) selects short repair actions. One Pi Durable 1.4.0 harness stores strategy, measured outcomes, blocker context and verified declarative programs alongside its transcript. Both models share SQLite, a credential broker and a serialized queue paced at least twenty seconds apart. Strategic reviews pass queued repairs without interrupting active inference. Completion detection runs every five seconds; idle evidence persistence keeps its thirty-second cadence.
- Immediate movement, mining, combat, eating and retreat run locally. Threat assessment uses health, food, weapons, shields and enemy numbers/type; retreats last at most six seconds and preserve emergency safety. Emergency raw chicken is allowed without safer food, and meals require server consumption evidence. Sol supplies a bounded current program and one concrete lookahead per bot. A successful bot starts its lookahead locally while strategic planning continues; failure, death or a changed mission prevents stale continuation. Sol revises these declarative programs; arbitrary generated JavaScript and host commands are disabled. Inventory clicks wait for authoritative server state rather than optimistic client predictions.
- A systemd timer publishes observed status and an actual bot-camera WebP every fifteen minutes. The live viewer switches between all four first-person cameras, with live inventory and main/off-hand labels. Only the selected camera is connected; rendering runs in visitors' browsers with eight public viewers per bot. Neither interface controls the bots.
- Camera movement and look direction are smoothed locally. Captures wait for loaded chunks, terrain meshes and textures; fog bounds the 48-block viewing distance. Two meshing workers and a four-chunk radius bound browser memory. The upstream renderer does not draw held equipment on character models. Its older entity models use base coat variants; unsupported species can still appear as placeholders.

## Progression

Immediate food and defence → reachable shelter, shared chest and personal beds → timber-and-stone lodge → renewable supplies and iron equipment → diamond pickaxe and obsidian → Nether supplies → Eyes of Ender and stronghold → crystals and dragon.

The lodge uses an explicit survival-built blueprint: stone skirt, timber posts, recessed windows, pitched roof, overhangs, porch and lighting. Compatible local timber can be mixed with existing building blocks. Small verified building batches count as progress without claiming a completed house. The shared mission API covers gathering, equipment, lodge-building, regrouping, shared chest deposits/withdrawals and owned beds. Container transfers require confirmed changes on both sides; personal spawn requires a server acknowledgement, not merely a placed bed. Portals and dragon combat require additional mission actions. Milestones are based on observed inventory, blocks, dimensions or entity-death events, not a model claiming success. A completed dragon run is an expedition objective, not an integration-test assertion.

Strategy: [main adventure](https://minecraft.wiki/w/Tutorial:Complete_main_adventure), [Nether survival](https://minecraft.wiki/w/Tutorial:Nether_survival), [dragon combat](https://minecraft.wiki/w/Tutorial:Defeating_the_ender_dragon).

## Isolation

| Component | User | Listener |
| --- | --- | --- |
| Paper | `minecraft-adventure` | `127.0.0.1:25566` |
| Public Velocity | `minecraft-adventure` | TCP `25565` |
| Local bot Velocity | `minecraft-adventure` | `127.0.0.1:25567` |
| Bots / private Mindcraft UI / viewers | `minecraft-bots` | loopback `8930` / `8931–8934` |
| Sol/Terra planner | `minecraft-planner` | `127.0.0.1:8766` |
| Diary / capture browser | `minecraft-diary` | no listener |

The narrow root credential broker only resolves Codex access authentication through Batty's canonical credential lock. It runs no gameplay or model harness. Bots cannot read the OAuth store, forwarding secret or planner database. A separate shared project group carries observations and mission files; the diary has read-only observation ACLs.

Gameplay state lives under `/var/lib/minecraft-adventure/`; the Pi database under `/var/lib/minecraft-planner/`; public journal files under `/var/www/roybot.se/minecraft/`. Deployed code is root-owned under `/opt/minecraft-adventure/` and `/opt/minecraft-mindcraft/`.

The shared `minecraft-adventure.slice` has a 4 GiB ceiling and low CPU/I/O priority. Only TCP 25565 is opened publicly. Batty's service, data and existing scheduled jobs are independent.

## Operations

```sh
systemctl status minecraft-adventure-server minecraft-adventure-proxy@public minecraft-adventure-proxy@local
systemctl status minecraft-adventure-bots minecraft-planner minecraft-planner-auth
systemctl list-timers minecraft-adventure-diary.timer
journalctl -u minecraft-adventure-bots -u minecraft-planner -n 80
curl -fsS http://127.0.0.1:8766/healthz
```

Install order: `server/`, `planner/`, `bots/`, then `diary/`. Each component contains its installer and tests. The diary installer requires the existing Let's Encrypt certificate for `minecraft.roybot.se`; HTTP renewal challenges use `/var/www/roybot.se`. The legacy `/minecraft/` route redirects to the subdomain.

The Mineflayer compatibility hook closes real client ticks and teleport responses with `tick_end`. Mindcraft's separate delayed-movement wrapper is disabled because it breaks those packet boundaries. Source hooks verify unique upstream anchors and fail visibly if the pinned upstream source changes.

Server-side Java processes, bots, planner and renderers all run unprivileged. Old Minecraft worlds and their immutable Storage Box archive are not used or modified by this expedition.
