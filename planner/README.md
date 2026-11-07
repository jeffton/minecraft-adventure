# Minecraft Adventure planner

A dedicated Pi Durable 1.4.0 Harness uses Codex Sol (`gpt-6.1-sol`, medium reasoning, 4096 output tokens) for strategic reviews and Terra (`gpt-6.1-terra`, low reasoning, 2048 output tokens) for individual repair decisions. Mindcraft retains its local gameplay/skill loop.

- `POST http://127.0.0.1:8766/v1/chat/completions`: non-streaming OpenAI chat, text messages, `user` equal to Roy/Spruce/Flint/Moss, bearer credential from `PLANNER_RELAY_TOKEN`. Repair model/output budget are fixed server-side at Terra/2048 tokens, low reasoning; client model names cannot change routing. Model tools are not accepted.
- `POST /diary`: authenticated diary observations, narrated as one short English paragraph by Terra through the same queue and durable Harness. No mission context is appended; model/format failures fail publication explicitly. The quarter-hour publisher preserves older entries and camera images.
- `GET /mission`: authenticated latest shared mission. The same JSON is published to `/var/lib/minecraft-adventure/control/mission.json`.
- `GET /strategy`: authenticated durable strategy, evidence ledger, verified programs and revision.
- `GET /healthz`: local status, queue and mission error; `models.mission` and `models.repair` report their model and thinking level. No credentials. This replaces the singular `model` field.
- Globally one generation at a time, starts at least 20 seconds apart, queue capacity eight, 120-second model deadline and no automatic provider retries.
- Mindcraft submits full context; each request resets the Harness model view rather than duplicating history. Original turns and idempotent request results remain in SQLite. Optional `X-Request-ID` reuses a persisted result after restart.
- Sol reviews persistent objectives every five minutes, after a bot completes useful program work, after observed goal completion, or after three distinct failures in the same controller/precondition context without active-goal progress. Reviews carry measurable criteria, completed dependencies, intervention outcomes, hunger/equipment changes and bounded verified program examples. Sol explicitly continues or changes strategy; code evaluates completion. Model-view resets preserve the strategic document in the same Pi Durable SQLite store.
- Structured producer sessions/sequences deduplicate evidence; gaps are visible. Historical achievements do not imply current readiness, offline inventory is unknown, and one verified lodge placement is not a completed building. Meal counters require server-confirmed consumption; earlier plugin-only notifications remain explicitly unverified audit data. Program examples enter memory only after real controller postconditions pass.
- Planning runs in the background while valid programs and survival actions continue. Repairs are bound to mission, bot session and generation; obsolete replies cannot issue commands. A first real failure is repaired promptly, while repeated identical failures retain backoff. Completed/no-op programs are distinguished from pending repairs; no-op checks do not request new plans.
- Incomplete or failed generations leave the dated mission intact. Local skills handle combat and survival reflexes without model calls. Mission programs, supported acquisition items and coordinates are validated before publication; stale/offline observations do not trigger inference.

## Planning vision

Every Sol strategy review receives current 960×540 WebP image input, including ordinary food, navigation and resource planning. Capture batches rotate Roy → Spruce → Flint → Moss, skipping offline actors, so Sol sees each bot's actual first-person perspective. Relevant construction reviews also receive an elevated base view at most every two minutes when an online actor has that terrain loaded; an unavailable base view is explicitly labelled. Sol returns `strategy.visualAssessment` alongside its executable mission. Block/event checks remain authoritative; pictures cannot prove inventory transfers, spawn acknowledgements or events outside their views. Terra repairs remain text-only.

Capture attempts are at least one minute apart. Reviews inside that interval reuse the same explicitly timestamped images only while they are under 60 seconds old and their actor sessions/dimensions remain valid. Reconnects invalidate the cache. A failed capture fails the review visibly rather than substituting old images or a text-only answer. All attached images must still be under 90 seconds old at provider admission.

`minecraft-building-camera.service` runs separately as `minecraft-diary`, capped at 768 MiB and one active browser. Its loopback-only `POST /capture` on port 8935 accepts bounded current-world camera observations and a requested actor, not paths or commands. POV and optional base captures run sequentially, closing each browser before opening another. Capture preparation is outside the model queue so Terra repairs can proceed while Chromium renders; bot programs and survival reflexes continue locally. The full terrain/texture/completed-frame barrier remains required. Post-capture producer session/dimension checks reject reconnects; provider admission rechecks ordered image metadata, age, base where applicable and SHA-256 after pacing or recovery. Journal events `planning_views`, `vision_model_input` and `planning_visual_review` link actor/cadence metadata, actual model image blocks and the resulting assessment. Images persist in the existing durable transcript, not the public repository.

The diary installer installs the camera helper and service; enable/start `minecraft-building-camera.service` before starting a vision-enabled planner. It uses the existing diary Playwright installation and requires no model credentials. Both services must be stopped before switching the active world; the camera receives fresh namespaced observations from the planner and stores no world facts.

## State and permissions

`/var/lib/minecraft-planner/planner.sqlite` stores the durable transcript and authoritative `minecraft.adventure-state` document. Strategy, evidence and mission commit atomically with revision checks. `mission.json` is a repairable projection, reconstructed at startup and each poll. `status.json` stores cadence/errors; an admitted pending mission retains its input/request ID after restart while fresh. Existing dated missions are imported into the document before the first strategic review. Observations come from `/var/lib/minecraft-adventure/observations/state.json`, containing `updatedAt` and `bots` with per-bot `status`/`updatedAt`. Both aggregate state and an online bot must be at most 60 seconds old.

Mission schema:

```json
{
  "id": "uuid",
  "goalId": "stable-objective-id",
  "observedAt": "ISO timestamp",
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

`program` is required: 1–6 exact-schema steps, limited to `ensure_item`, `equip`, Roy-only `build_lodge`, and argument-free `regroup`. Item IDs are checked against the pinned Minecraft 1.21.4 registry in `item-ids.json`; inventory minima are integers 1–64. Programs contain no JavaScript, shell or arbitrary action names. Controllers check desired state before each step and reread the mission `id` revision at operation boundaries, rather than replaying completed work. Each admitted execution emits one attempt identity and exactly one completed/failed terminal event, with actual end inventory/health/food or a classified blocker. The action API does not implement supply transfer, portals or dragon combat; roadmaps must distinguish those capability gaps from executable missions.

`home` becomes observed `{x,y,z}` coordinates when known. Phases: survival, homestead, equipment, nether, stronghold, end, completed, recovery.

## Credentials

The planner runs as `minecraft-planner`, with its private group and shared `minecraft-adventure-project` group, **not** the server's private group.

A separate root-owned broker has no model Harness, execution API or TCP listener. Its group-restricted Unix socket serves resolved Codex access auth at `/auth` and canonical Codex model descriptors at `/models`, never refresh credentials. It calls the same SDK locked canonical credential store as Batty (`/home/roy/github/.batty/auth.json`), so OAuth refresh ownership is shared through the existing file lock rather than duplicated token files. Batty's cached model catalog is mounted read-only into the broker; the planner needs no filesystem access to Batty state. Models absent from the canonical catalog fail explicitly rather than using an older alias. No bot receives provider credentials.

The relay token is a separate random local bearer credential. Bots receive that token as `OPENAI_API_KEY`; only the planner sees short-lived provider access auth. Nothing is exposed through nginx.

## Installation

Deploy matching planner and bot code together: the planner imports the bot controller's supported acquisition list. Run `bash install.sh` as root after review. It installs root-owned code/dependencies under `/opt/minecraft-adventure/planner`, the dedicated account, unit files and a root-only `/etc/minecraft-adventure/planner.env`. It does not start services. Set the bots' `OPENAI_API_KEY` to the relay token through their root-managed environment file without printing it.

Start/enable `minecraft-planner-auth.service` and `minecraft-planner.service`. They use the existing `minecraft-adventure.slice`; planner memory is capped at 512 MiB and broker at 256 MiB. Shutdown waits for admitted model work; interrupted turns resume from SQLite.

`npm ci --ignore-scripts && npm test && npm run check` verifies the relay, actual Pi Durable persistence/recovery, admission pacing, stale state rejection and credential contract. Dependencies are pinned to the latest stable 1.4.0 release; its SQLite schema v2 cannot be reopened by Pi 1.3.
