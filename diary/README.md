# Single-player journal

The site shows Roy’s automatic camera, live inventory, explored-world map and Terra’s first-person diary. Publication runs every fifteen minutes. Diary images and historical entries are retained.

## Runtime contract

`/var/lib/minecraft-adventure/observations/state.json` contains:

- `worldId`: immutable identity matching `[A-Za-z0-9][A-Za-z0-9_-]{0,79}`; use a new value for each fresh world.
- `updatedAt`: ISO timestamp, at most 120 seconds old at publication.
- `phase`: `settling`, `survival`, `homestead`, `equipment`, `nether`, `stronghold`, `end`, `completed` or `recovery`.
- `objective`, `longTerm`, `serverVersion`; `milestones: [{label, completed}]`.
- `bots`: one `{name: 'Roy', status, health, food, task, inventory}` observation.
- `events`: world-local `{id, at, bot: 'Roy', type, message, data}` observations.

Narrative facts include mined-block counts (`gather`, message `Mined <block> ...`), death, errors, milestone/delivery messages, confirmed crafting (`craft`, data `{item,count}`), verified meals (`eat`, data `{verified:true}`), verified non-air placements (`build`, data `{verified:true,material}`) and other verified outcomes (`action`, data `{verified:true}`). Plans and unverified action messages are excluded. Emit confirmed results, not model assertions.

`POST http://127.0.0.1:8766/diary` uses `PLANNER_RELAY_TOKEN` Bearer authentication. Request: `{worldId, observedAt, since, objective, facts, bots}`. Response: `{worldId, text, model, answerEntryId}`. Terra writes one short subjective English paragraph as Roy from these facts, without inventing achievements. A mismatched world identity rejects publication; inference failure preserves published history.

Roy’s viewer stays on loopback `8931`, public `/live/`. It exposes `roycraftConnected`, `roycraftState` (name/status/at/position/action/moving/digging/health/food/held/offhand/inventory) and the existing `roycraftCapture` image hook. The map remains `/map/` and must point to the new world during server rollout.

## World history

The first successful publication under a different `worldId` archives the prior `data.json` as `archives/<oldWorldId>/data.json`. Both worlds require explicit identities. Only same-world entries contribute the next `since` boundary. Current `data.json` lists previous archive paths. Images and individual entry files remain in place. Archive links select historical diary entries while the camera, status and objective continue showing the current world.

## Install and rollout

The installer does not move data or switch worlds. Coordinate the world/server/runtime rollout before publishing:

1. Back up the existing public journal, images and entries with the world backup.
2. Run `bash diary/install.sh` to install code/static files and units. This reloads nginx, not game services or the diary timer.
3. Start the new runtime with its fresh `worldId`, a current one-Roy observation and working authenticated `/diary` endpoint.
4. Run `systemctl start minecraft-adventure-diary.service`. Confirm `data.json.worldId`, a Terra paragraph and a fresh image, plus `archives/<oldWorldId>/data.json` after a world change. Model/capture failures appear in the unit journal; capture failure publishes an explicit missing-image error, not an old frame.
5. Enable the existing fifteen-minute timer after the successful smoke: `systemctl enable --now minecraft-adventure-diary.timer`.

If the timer remains enabled during rollout, stop it before changing worlds and start it after the first successful publication. Preserve archive/image directories when copying static assets. The code worker does not perform these operations.

## Checks

```sh
cd diary
python3 -m unittest test_publish test_item_assets
node --test test-inventory.mjs
node --check app.js
node test-browser.mjs
```

The browser fixture uses fake camera/map HTML, not WebGL. Run nonroot from a readable staging directory under 768 MiB/256 tasks. Real `test-live.mjs` renders the game: reserve a single browser slot and run with existing resource limits. Never overlap it with diary/building captures.
