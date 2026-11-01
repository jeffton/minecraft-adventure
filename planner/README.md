# Minecraft Adventure planner

A dedicated Pi Durable 1.4.0 Harness uses Codex Sol (`gpt-6.1-sol`, medium reasoning) for shared missions and Terra (`gpt-6.1-terra`, low reasoning) for individual repair decisions. Mindcraft retains its local gameplay/skill loop.

- `POST http://127.0.0.1:8766/v1/chat/completions`: non-streaming OpenAI chat, text messages, `user` equal to Roy/Spruce/Flint/Moss, bearer credential from `PLANNER_RELAY_TOKEN`. Repair model/output budget are fixed server-side at Terra/2048 tokens, low reasoning; client model names cannot change routing. Model tools are not accepted.
- `GET /mission`: authenticated latest shared mission. The same JSON is published to `/var/lib/minecraft-adventure/control/mission.json`.
- `GET /healthz`: local status, queue and mission error; `models.mission` and `models.repair` report their model and thinking level. No credentials. This replaces the singular `model` field.
- Globally one generation at a time, starts at least 20 seconds apart, queue capacity eight, 120-second model deadline and no automatic provider retries.
- Mindcraft submits full context; each request resets the Harness model view rather than duplicating history. Original turns and idempotent request results remain in SQLite. Optional `X-Request-ID` reuses a persisted result after restart.
- Every five minutes Sol rewrites each bot’s bounded declarative program from fresh world state, previous progress and controller failures. The same serialized Harness switches model configuration between requests and resets its model view; both roles share SQLite, the credential broker and admission pacing. Incomplete or failed generations are rejected without replacing the mission. Local skills handle combat and survival reflexes without model calls. Mission programs and coordinates are validated before atomic publication; stale/offline observations do not trigger inference.

## State and permissions

`/var/lib/minecraft-planner/planner.sqlite` stores the durable transcript. `status.json` stores cadence/errors; a pending mission is replayed after restart. Observations come from `/var/lib/minecraft-adventure/observations/state.json`, containing `updatedAt` and `bots` with per-bot `status`/`updatedAt`. Both aggregate state and an online bot must be at most 60 seconds old.

Mission schema:

```json
{
  "id": "uuid",
  "generatedAt": "ISO timestamp",
  "phase": "homestead",
  "objective": "Shared milestone and immediate goal",
  "bots": {
    "Roy": {"task": "Finish the shared lodge", "program": [{"action":"build_lodge"}]},
    "Spruce": {"task": "Stock timber", "program": [{"action":"ensure_item","item":"oak_log","count":32}]},
    "Flint": {"task": "Prepare mining tools", "program": [{"action":"ensure_item","item":"stone_pickaxe","count":1},{"action":"equip","item":"stone_pickaxe"}]},
    "Moss": {"task": "Return home", "program": [{"action":"regroup"}]}
  },
  "home": null
}
```

`program` is required: 1–6 exact-schema steps, limited to `ensure_item`, `equip`, Roy-only `build_lodge`, and argument-free `regroup`. Item IDs are checked against the pinned Minecraft 1.21.4 registry in `item-ids.json`; inventory minima are integers 1–64. Programs contain no JavaScript, shell or arbitrary action names. Controllers check desired state before each step and reread the mission `id` revision at operation boundaries, rather than replaying completed work.

`home` becomes observed `{x,y,z}` coordinates when known. Phases: survival, homestead, equipment, nether, stronghold, end, completed, recovery.

## Credentials

The planner runs as `minecraft-planner`, with its private group and shared `minecraft-adventure-project` group, **not** the server's private group.

A separate root-owned broker has no model Harness, execution API or TCP listener. Its group-restricted Unix socket serves resolved Codex access auth at `/auth` and canonical Codex model descriptors at `/models`, never refresh credentials. It calls the same SDK locked canonical credential store as Batty (`/root/github/.batty/auth.json`), so OAuth refresh ownership is shared through the existing file lock rather than duplicated token files. Batty's cached model catalog is mounted read-only into the broker; the planner needs no filesystem access to Batty state. Models absent from the canonical catalog fail explicitly rather than using an older alias. No bot receives provider credentials.

The relay token is a separate random local bearer credential. Bots receive that token as `OPENAI_API_KEY`; only the planner sees short-lived provider access auth. Nothing is exposed through nginx.

## Installation

Run `bash install.sh` as root after review. It installs root-owned code/dependencies under `/opt/minecraft-adventure/planner`, the dedicated account, unit files and a root-only `/etc/minecraft-adventure/planner.env`. It does not start services. Set the bots' `OPENAI_API_KEY` to the relay token through their root-managed environment file without printing it.

Start/enable `minecraft-planner-auth.service` and `minecraft-planner.service`. They use the existing `minecraft-adventure.slice`; planner memory is capped at 512 MiB and broker at 256 MiB. Shutdown waits for admitted model work; interrupted turns resume from SQLite.

`npm ci --ignore-scripts && npm test && npm run check` verifies the relay, actual Pi Durable persistence/recovery, admission pacing, stale state rejection and credential contract. Dependencies are pinned to the latest stable 1.4.0 release; its SQLite schema v2 cannot be reopened by Pi 1.3.
