# Deploy

## Pause and resume

Stop autonomous model use without stopping Paper, the map or the website:

```sh
systemctl stop minecraft-adventure-diary.timer minecraft-adventure-diary.service minecraft-player.service
```

Resume explicitly:

```sh
systemctl start minecraft-player.service minecraft-adventure-diary.timer
```

The timer may publish one catch-up diary entry on resume. World/inventory, agent history, notes and saved skills persist; in-memory programs and their queued continuations do not.

## Send a live operator task

The running player accepts `POST /operator/task` on its existing loopback-only
HTTP listener (`127.0.0.1:8766`). The request uses the server relay credential
from root-owned `/etc/minecraft-adventure/planner.env`; it is not a public API.
Sandbox programs receive neither this credential nor host network access.

```sh
sudo -n node --env-file=/etc/minecraft-adventure/planner.env \
  /opt/minecraft-adventure/player/operator-task.mjs <<'JSON'
{"worldId":"player-20261107-plains","id":"unique-user-request-id","text":"The user's gameplay instruction"}
JSON
```

Keep the same `id` when retrying a request; `queued` confirms persistence,
`already_received` confirms a duplicate. Neither means the work is completed.
The player handles the request at the next safe planning boundary without
interrupting the current action or disconnecting. The message is explicitly
an operator-relayed user request, not an in-game player or world observation;
acknowledgments remain local. Real player chat keeps its original channels.
Do not edit the inbox file while the player is running.

## Publish code

Existing installation, Node 24+, root access and `trash` are required. Run from a reviewed checkout; the scripts do not pull or commit code.

```sh
bash player/deploy.sh
bash diary/publish-ui.sh
```

`player/deploy.sh` tests the player and viewer, stages locked production dependencies and builds the viewer worker before stopping `minecraft-player.service`. It installs player modules, viewer/compatibility modules and the built worker, refreshes the sandbox runtime, then starts only the player. Paper, proxies, map, diary timer and world data remain running and untouched. Initial user/unit/static-asset provisioning remains in the installers.

Early health returns HTTP 503 with phase `starting`, `recovering` or `blocked` and Durable task IDs/reasons; HTTP 200 with `ready:true` requires completed recovery and a fresh observation. SIGTERM during startup closes cleanly without aborting/deleting persisted tasks; blocked recovery requires explicit diagnosis/`retryTask`, not automatic retries.

The final check waits up to two minutes for ready health and a fresh online observation from a new player session, then checks feed HTTP and live Socket.IO state. Blocked recovery fails immediately with the health diagnostics. No browser or model call is needed. Failures exit visibly; there is no automatic rollback/restart recovery. A failure after stopping can leave the player stopped; inspect the reported command/error before starting it.

Static publication syntax-checks JavaScript, runs inventory/clock tests and copies only the eight UI files. It does not install dependencies, rebuild item assets, alter journal data, install units or reload services. Publisher/capture/service changes still use `diary/install.sh`.

Test path overrides: `PLAYER_DEPLOY_ROOT`, `PLAYER_OBSERVATION_FILE`, `DIARY_UI_ROOT`. Staging directories, including replaced dependencies, go to trash on exit. Deploying interrupts in-memory actions/continuations; world state, inventory and Durable history remain persisted, and the player observes its current situation after reconnecting.

```sh
node --test player/test/deploy.test.mjs
```

The deploy sequence tests use a temporary fake installation and command fakes; they never restart a service. The readiness tests cover parked startup, old/stale observations and feed disconnection.
