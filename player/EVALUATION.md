# Roycraft: observed play and improvement

Run this workflow when the Minecraft evaluation job fires. The mission is competent survival and real progression in the existing world, not more controller code.

## Authority and state

- Read the latest user instructions and current service status first. A user stop or changed mission takes precedence. If `minecraft-player.service` is inactive, do not start it: report that evaluation has stopped and delete this evaluation cron job. Never start the retired four bots. Do not restart Roy against a user stop.
- Preserve world, inventory, notes, full event/action/controller history and credentials. No resets, deletions, third-party messages, purchases or Batty changes.
- State: `/var/lib/minecraft-player/player-20261101/`. Current observations: `/var/lib/minecraft-adventure/observations/state.json`. Runtime code: `/opt/minecraft-adventure/player/`. Source: `/root/github/minecraft-adventure`. Public view: https://minecraft.roybot.se/.
- Read `/var/lib/minecraft-player/evaluation.json` if present. Record evaluation time, player session, source commit, active mission/version, observations, diagnosis, changes and evidence timestamps there after each evaluation. It is evaluation bookkeeping, not proof of gameplay.

## Evaluate actual outcomes

1. Verify Node 26 and player health (`http://127.0.0.1:8766/healthz`). Inspect actual observation, `progress.json`, controller state, recent events and action records since the last evaluation. Filter large files locally; do not paste whole histories or credential files into context. Use real POV/viewer if terrain or building quality matters.
2. Quantify inventory gains/losses, food/health/deaths, tools/bed/storage/building effects and navigation: net vs gross travel, explored new locations and repeated destinations. Separate historical totals from this evaluation interval. Action completion, service health and changing coordinates alone are not successful play.
3. Inspect the active mission, its expected outcome, actual result and remembered lessons. Check that the next strategy incorporates failures rather than replaying the same movement. Inspect model/tool errors, latency and token usage; do not repeatedly trigger expensive full-history analyses. The strategist must choose concrete achievable missions, with local skills and survival reflexes handling execution.
4. Observe enough new actual decisions/outcomes to distinguish a transient obstacle from a loop. Do not sleep or busy-poll subagents; use bounded fresh evidence collection or schedule an appropriate next evaluation. Never claim progression without observed evidence.

## Improve only a demonstrated weakness

- If play progresses intelligently, leave code alone. Report concrete progress even when no edit is needed.
- Diagnose the cause before an edit. Prefer improving the mission, useful memory, perception/outcome projection or a concrete RPC defect over a new universal decision tree or another anti-loop patch.
- Pull before coding, preserve unrelated dirty files (legacy `bots/` and `planner/` may contain pre-existing work), coordinate other workers, and implement only targeted Minecraft changes. Test/build using the relevant package scripts; obtain independent Sol-medium review before completion, address findings, commit and push owned changes. Deploy player changes through `bash player/deploy.sh`; static diary changes use `bash diary/publish-ui.sh`. Never deploy Batty or restart Paper to fix planner behavior.
- After any deployment or strategic change, verify actual subsequent gameplay, fresh source/version, health and real outcomes. If the provider or game is blocked, record/report the concrete blocker, not invented success or repeated model calls.
- Keep exactly one evaluation job. Its initial checks are roughly 10 and 30 minutes after activation, then every two hours. Preserve that cadence while Roy runs; stop/delete it when Roy is explicitly stopped. The cron prompt references this file instead of duplicating the workflow.

Deliver a short Danish result with observed progress, any demonstrated weakness/fix and important blocker. Do not repeat unchanged status verbatim; explain the current evaluation's actual evidence. Never include secrets.
