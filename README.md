# Roycraft

An autonomous Minecraft player at **https://minecraft.roybot.se/**, with a live first-person camera, explored-world 3D map and a subjective field diary.

## Player

Roy is a single Pi Durable codeagent using Sol medium. He observes server-backed inventory, blocks, entities and current camera images; writes JavaScript skills; runs them asynchronously; inspects their actual effects; and stores reusable skills. The Minecraft API exposes navigation, digging, crafting, placement, combat, containers, furnaces and other composable low-level operations. There is no fixed house blueprint or mission-action menu.

One agent-authored next skill can start locally after a successful action. Failure, death and emergency reflexes discard queued work. Eating, surfacing and immediate combat/escape run locally while model calls are pending. Runtime telemetry distinguishes time with an active program from time without one; neither a returned program nor an active handle proves useful progress.

Goals: survive, acquire tools and food, establish an attractive home with a bed and storage, then prepare for the Ender Dragon. This is an experiment, not a claim of competent autonomous completion.

## World and presentation

Paper 26.3 / Java 25 provides ordinary normal-difficulty survival. The public Velocity proxy requires Microsoft authentication and the existing human whitelist. Roy connects through a loopback-only offline proxy using Mineflayer protocol 1.21.4, translated by ViaBackwards.

The public site keeps one automatic read-only camera, compact live inventory, BlueMap's saved explored chunks and a Terra-written English diary every fifteen minutes. Camera images are also real image blocks in the player's perception loop, with capture age metadata. The separate renderer permits one capture browser at a time under a 768 MiB limit. The journal keeps previous worlds under its archive navigation.

Fresh worlds have distinct directories, map storage, observation identity, durable conversations and world notes. Reusable skill source is shared; verification records retain the world where the effects were observed. Prior coordinates, inventories and achievements are not imported as facts.

## Isolation

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
