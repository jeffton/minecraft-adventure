# World lifecycle

`world-scope.mjs` prepares an empty namespace from Paper's `world/uid.dat`. The host administrator reads this 16-byte identity; bots and planner receive only the UUID and namespace manifest, never server-private access.

## API

```js
const scope = await prepareWorldScope({
  root: '/var/lib/minecraft-adventure',
  uidFile: '/path/to/new/server/world/uid.dat',
  dryRun: true,
});
```

Dry-run reads the identity and returns paths without creating anything. Explicit `dryRun: false` creates only `worlds/<uuid>/world.json` and empty `control`, `observations`, `bots`, and `planner` directories. Repeating preparation preserves existing files. It does not select a world or change services, ownership, permissions on existing directories, server data, or credentials.

Integration bindings:

- Engine: `openEngine({ stateDir: '/var/lib/minecraft-planner', worldScope: scope, ... })`. Keep this shared database directory; do not pass `scope.plannerState` as the engine database directory.
- HTTP planner: `startPlanner({ stateDir: scope.plannerState, missionFile: scope.control + '/mission.json', observedFile: scope.observations + '/state.json', ... })`.
- Bots: `ADVENTURE_ROOT=scope.root`, `BOT_DATA_DIR=scope.botData`; working directory and service write permissions must match.
- Diary publisher: observation/control inputs must point to the same namespace. Diary history and pictures can remain in their existing publication directory.
- Planner startup calls `plannerWorldConfig(process.env)` to select these bindings from explicit `ADVENTURE_WORLD_ID` plus `ADVENTURE_ROOT`. An unselected deployment retains its existing unscoped paths. A selected world rejects mismatched root, manifest, mission-file or observation-file overrides.
- Call `assertWorldScope(scope)` before launching other consumers. `openEngine` also verifies the manifest before opening SQLite. An absent or mismatched manifest rejects startup.

The engine stores one session-scoped Pi Durable document per world UUID in the existing SQLite database. Old documents and transcripts stay stored; a new world's strategy, mission, evidence, counters and review markers start empty. Identical model request IDs in different worlds cannot replay each other's answers. Calling without `worldScope` retains the current unscoped live document; opting into a namespace does not import it.

## Later world switch

1. Finish and review the code. Do not reset the running world to test lifecycle handling.
2. Drain planner requests and stop planner and bots. Stop Paper gracefully before selecting a different server world. Do not let an old queued request continue across activation.
3. Create the new server world with a distinct Paper UUID. Never copy `uid.dat` from the old world. Archive/preserve the old server directory and its namespace.
4. Run preparation first as dry-run against the actual selected Paper `world/uid.dat`, then explicitly apply preparation. Check the returned UUID against that same file immediately before activation.
5. Grant bot/planner/diary users the required namespace permissions. Bind all consumers to that namespace using the bindings above and the UUID manifest. Keep the shared SQLite path unchanged. See service selection below.
6. Start Paper, planner and bots using the reviewed namespace bindings. Verify empty initial mission/evidence and no old home, observations, pending mission or bot memory before allowing execution. Verify the first new observation belongs to the selected world.

## Service selection

At activation, set `ADVENTURE_WORLD_ID=<uuid>` and `ADVENTURE_ROOT=/var/lib/minecraft-adventure/worlds/<uuid>` for planner and bots. Set `BOT_DATA_DIR=<root>/bots` for bots. The planner service currently defines legacy `PLANNER_MISSION_FILE` and `PLANNER_OBSERVED_FILE`; override both in its environment file with `<root>/control/mission.json` and `<root>/observations/state.json`. Conflicting legacy overrides deliberately fail startup rather than importing old facts.

Use systemd drop-ins to give the bot service `WorkingDirectory=<root>/bots` and write access to `<root>/bots`, `<root>/control`, `<root>/observations`. Give planner write access to its shared `/var/lib/minecraft-planner` directory, `<root>/planner` and `<root>/control`. Root prepares directory ownership/ACLs so bots write observations and control, planner reads observations and writes control, and diary reads observations. Preserve the shared `minecraft-adventure-project` group arrangement. Bots receive no access to the server directory or credential broker.

Update diary publication's `--state` input to `<root>/observations/state.json` (its CLI also uses a capture/output location; preserve publication history). Public telemetry, camera inputs, mission polling and any operator probe must read the selected namespace rather than a cached legacy path. Planner-side status and pending requests live under `<root>/planner`. Base utility locks and home/completion markers live under `<root>/control` through `ADVENTURE_ROOT`.

No service files or live environment files are changed by namespace preparation. Paper world selection/playerdata isolation and these service bindings are administrator activation steps, not an automatic reset operation.

Do not move old `home.json`, `mission.json`, completion markers, status/pending files, observations or Mindcraft memory into the new namespace. Player inventory and bed spawn are server-world data; the new Paper world must use fresh player data as well. Namespace preparation does not change server player data.

Portable tactics are the source-controlled prompts, action implementations, blueprint/resolvers, and test-verified program templates. Earned skills, completed milestones, coordinates and world-dependent prerequisites are not copied. There is no automatic learned-skill export.

Lifecycle unit/integration tests create two temporary Paper identity files, two namespaces and one temporary SQLite harness. They verify isolation, restart recovery, preserved legacy state, request-ID separation and fail-closed identity checks without accessing the live world.
