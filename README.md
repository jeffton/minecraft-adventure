# Roycraft

An autonomous Minecraft player at **https://minecraft.roybot.se/**, with a live first-person camera, explored-world 3D map and a subjective field diary.

## Player

Roy runs a persistent AI-authored JavaScript controller: fresh observation → local decision → bounded skill → observed outcome. It chooses further work without model requests. Sol medium runs through Pi Durable in the background, sees real camera images and feedback, and submits versioned controller improvements. Candidates execute offline fixtures in the same OS sandbox before activation between actions; hotpatches preserve world-scoped controller state. The controller composes Minecraft navigation, digging, crafting, placement, combat, containers and furnaces without a fixed blueprint or mission menu.

Exactly one owner controls gameplay. Death and emergency reflexes invalidate pending decisions; subsequent work requires fresh observations. Eating, surfacing and immediate combat/escape remain local. Interruptions retain control ownership until host RPC and control cleanup finish. Readable skill names identify work in the UI while UUIDs identify records. Active handles and returned code do not establish useful progress.

Background engineering is event-driven: failed actions/RPCs, death, repeated stationary no-effect actions, sustained resource-free work, meaningful environmental changes and new materials supply coalesced evidence. There is no normal engineering cooldown. One model writer runs alongside gameplay, capture and deterministic analysis; unchanged evidence does not request more model turns. Existing model-round boundaries refresh state and recent images, while new evidence can extend an analysis. Candidates carry their source version; obsolete patches cannot replace newer code. Pending candidates wake idle scheduling immediately. Only demonstrated identical RPC failures in the current stationary attempt permit targeted interruption for a repair; ordinary mining, building and movement retain their natural boundary. Provider/opening failures use a visible bounded retry backoff.

Recipes expose named dependencies; bounded registry queries expose item, block, biome and entity semantics. Spatial memory retains only server-observed locations by world and dimension. Unknown terrain must be explored, not discovered through a seed or server locate command. Resource plans, exploration frontiers and tactical alternatives belong to the agent-authored controller, not host scripts.

Navigation is nondestructive walking by default; deliberate digging, scaffolding and sprinting require explicit per-call options. `harvest(position)` handles approach, tool selection, breaking and pickup while returning actual inventory changes. A persistent host-owned outcome history distinguishes waiting and resource-free travel from acquired supplies and placed blocks; a placed block does not certify a usable home.

Goals: survive, acquire tools and food, establish an attractive home with a bed and storage, then prepare for the Ender Dragon. This is an experiment, not a claim of competent autonomous completion.

## World and presentation

Paper 26.3 / Java 25 provides ordinary normal-difficulty survival. The public Velocity proxy requires Microsoft authentication and the existing human whitelist. Roy connects through a loopback-only offline proxy using Mineflayer protocol 1.21.4, translated by ViaBackwards.

The public site keeps one automatic read-only camera, compact live inventory, BlueMap's saved explored chunks and a Terra-written English diary every fifteen minutes. Camera images are real image blocks in the player's perception loop, with capture age metadata. A fifty-second background capture loop prepares views independently of model inference; only matching-session/life/dimension images under ninety seconds old are eligible. The separate renderer permits one capture browser at a time under a 768 MiB limit. The journal keeps previous worlds under its archive navigation.

Terrain lighting samples the server's propagated block-light and sky-light arrays. The compatibility loader decodes and encodes light payloads as sequential little-endian nibble bytes rather than palette longs; the mesher worker applies the same decoding. Light-only packets are coalesced for 100 ms, applied to mesher workers and invalidate affected sections and their neighbors. A 16×16 RGB lightmap follows [vanilla 1.21.4](https://assets.mcasset.cloud/1.21.4/assets/minecraft/shaders/core/lightmap.fsh) at default brightness 0.5, adding independent block and sky contributions. Terrain and atmosphere share the eased celestial angle; lamp brightness and skyless caves do not change at night. The Three r128 code-value pipeline applies no additional sRGB transfer or tone mapping. Atmosphere uses a clear-weather Overworld palette rather than biome-specific fog. Missing columns contribute no invented light. Entities retain the viewer's separate scene lighting.

Fresh worlds have distinct directories, map storage, observation identity, durable conversations and world notes. Reusable skill source is shared; verification records retain the world where the effects were observed. Prior coordinates, inventories and achievements are not imported as facts.

## Isolation

[Player capacity and isolation limits](player/LIMITS.md) documents model context, transport boundaries, remaining resource limits and measured audit evidence.

Generated JavaScript runs as a transient nonroot DynamicUser in a runtime-only filesystem, with an empty environment, no IP networking, read-only runtime files and CPU/memory/time limits. Bounded pipe RPC exposes explicit Minecraft methods, not host objects, files, shell or provider credentials. A root-owned Unix-socket broker starts the isolated process; it does not evaluate generated source itself. Killing an action also stops its host-side navigation, digging and controls.

Provider authentication uses the existing narrow credential broker and canonical locked Codex store. Gameplay, Paper, proxies, model harness and capture browser run unprivileged. Only TCP 25565 is public. Batty's service and data are independent.

## Operations

```sh
systemctl status minecraft-player minecraft-player-sandbox.socket minecraft-planner-auth
systemctl status minecraft-adventure-server minecraft-adventure-proxy@public minecraft-adventure-proxy@local
systemctl list-timers minecraft-adventure-diary.timer
journalctl -u minecraft-player -n 80
curl -fsS http://127.0.0.1:8766/healthz
cd player && npm test && npm run check
```

`player/install.sh` installs reviewed code without starting services or changing a world. `player/fresh-world.py --world-id <identity> --activate` performs an explicit stopped-state transition: full backup, retained original world, fresh map/world identity, removal of obsolete offline bot whitelist entries, and root-only rollback instructions. It leaves services stopped for coordinated activation.

Runtime state: `/var/lib/minecraft-player/`. Server and archives: `/var/lib/minecraft-adventure/`. Public diary: `/var/www/roybot.se/minecraft/`. Root-owned code: `/opt/minecraft-adventure/`. The retained `bots/` files supply protocol compatibility and read-only renderer patches; the retired four-player planner and its data are not the active gameplay controller.

Research: [Mine AI MCP](https://github.com/aibengineering/mine-ai-mcp), [Voyager](https://voyager.minedojo.org/), [programmable Minecraft agents](https://arxiv.org/html/2610.22319v1). These motivate reusable code and observed feedback; they do not establish pro-gamer performance.
