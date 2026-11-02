# Real persistent-controller E2E

Run as an administrator on the Minecraft host:

```sh
bash player/test-controller-live.sh
```

The runner creates a fresh normal survival world under a unique `/var/lib/minecraft-controller-e2e/` directory. It copies the installed Paper runtime and ViaVersion/ViaBackwards protocol adapters, not production worlds, plugins, configuration or credentials. Paper and the probe use a dedicated test UID, distinct from production. Executable trees and the sandbox root belong to root; only server/state/output directories are writable by the test UID. Paper runs with a 768 MiB heap, 1280 MiB memory cap and 120% CPU cap; the probe has a 384 MiB cap. Both use one private network namespace. No production service is restarted or written.

The probe cannot reach the internet or production's loopback proxy. Its mount namespace hides the credential socket and production state. It explicitly verifies those boundaries before connecting to Minecraft. It imports the controller store and Minecraft RPC, not the model adapter. A dedicated sandbox broker executes decisions and actions under the existing OS-isolated worker boundary, without sharing production's action slot. The existing Mineflayer compatibility loader supplies Paper's movement/inventory protocol fixes.

`test/fixtures/controller-survival.mjs` is AI-authored source supplied by the implementation assistant. It acquires materials and crafts locally through real Minecraft RPC. It is a bounded survival/resource fixture, not evidence that the production AI generalizes, builds a complete house or reaches the dragon. The host contains instrumentation and assertions, not resource-selection policy.

The probe validates two source versions offline, rejects activation during an action, switches at the next drained boundary, and measures five minutes without model access. Passing requires survival, successful actions under both versions, retained inventory progression, and server-backed mining/placement effects in every minute, including the final minute. Started actions and untrusted JavaScript return text are not sufficient evidence. Samples, actual RPC events, source versions and outcomes are retained in `output/report.json`; failures remain visible in the probe journal.

The launcher stops only its own test units on exit and preserves the test world/report. Cleanup drains only sandbox workers whose root directory matches this test run. Independent systemd deadlines bound the server, broker and probe. The probe also has an independent watchdog in case cancellation waits stall. No world rollback, item grants, time changes, teleportation or other cheats are used.
