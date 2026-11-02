# Skill execution boundary

`SkillSandbox` submits generated async JavaScript to a root-owned Unix-socket broker. The broker launches a **nonroot DynamicUser** process in a runtime-only `RootDirectory`. No generated code runs in the bot process or broker. No host credentials, plugins, arbitrary paths, shell commands, environment variables, or network access cross this boundary.

The sandbox contains Node, its linked libraries, and `sandbox-worker.mjs`. Its filesystem is read-only apart from an 8 MiB temporary directory. It has a private network namespace, denies IP socket families, hides other users' processes, drops capabilities, and has limits of 192 MiB RAM, zero swap, 24 tasks, 50% CPU and 120 seconds. RPC, source, input and result messages share a 1 MiB JSON frame bound. There are no separate 20/32 KiB code or 8/16 KiB state/input caps; complete serialized frames are validated before admission. One skill executes at a time; host Minecraft operations are also serialized. RPC call counts and retained action history have no quota. The execution deadline and OS cgroup protections still terminate runaway work.

The broker socket is `root:minecraft-adventure-project`, mode `0660`. The socket directory is traversable (`0755`), but the socket itself is group-restricted. The bot service needs that supplementary group and permission to reach this socket through its filesystem restrictions. It does **not** need root, sudo or permission to create systemd units.

## Installation (trusted administrator only)

Install these files in `/opt/minecraft-adventure/player/`:

- `sandbox-broker.mjs`, `sandbox-protocol.mjs`, `sandbox-worker.mjs`, `sandbox-install.mjs`
- The client also needs `sandbox.mjs`; the bot process imports `rpc.mjs` and `skills.mjs`.

Prepare the runtime-only root, then install and activate the supplied socket/service units:

```sh
node /opt/minecraft-adventure/player/sandbox-install.mjs /var/lib/minecraft-player-sandbox/root
install -m 0644 /opt/minecraft-adventure/player/minecraft-player-sandbox.{socket,service} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now minecraft-player-sandbox.socket
```

Re-run preparation after a Node or worker update. Do not place the root under `/tmp` or `/var/tmp`: DynamicUser's private temporary mounts hide those paths. Keep its ownership root-only; the installer is trusted code and must never receive model-controlled paths. The runtime library directory used by `SkillLibrary` belongs to the nonroot bot service and is separate from this root.

These steps are deployment instructions. Implementation tests create only transient test services and do not install or start the production broker.

## Host interface

```js
const rpc = createMinecraftRpc(bot, { Vec3, goals, onEvent });
const sandbox = new SkillSandbox({ rpc, onEvent });
const actionId = sandbox.start(code, { worldId, input }); // Immediate handle
const status = sandbox.status(actionId);                // No waiting
const finalStatus = await sandbox.wait(actionId);       // For runtime supervision
sandbox.cancel(actionId, 'death');                      // Immediate cancellation handle; stops host work
await sandbox.wait(actionId);                          // Cleanup settled; a successor can start
```

`onEvent` receives **one object**, with `type` and event-specific fields. Runtime death, disconnect, emergency reflex and world-change handlers must cancel the current action before taking control. Cancellation kills the worker cgroup and stops pathfinding, digging, controls, item use and open containers in Mineflayer. In-flight protocol operations such as crafting may settle after cancellation; new RPC is rejected until they settle rather than run concurrently. A safety reflex that takes direct bot control must cancel the sandbox, await `sandbox.wait(id)`, call `rpc.cancel()`, then await `rpc.waitForIdle()` before touching inventory. The idle barrier waits for the actual pending host call's final settlement, including a delayed server acknowledgement.

Action status contains `id`, `worldId`, `sourceHash`, `state`, `settled`, timestamps, trusted `before`/`after` observations, `callCount`, and the last 32 RPC call records. `value` is the **untrusted** generated-code return. `completed` means the function returned without an exception, not that its goal succeeded. `cancel()` returns immediately, while the overlap lock remains held until broker cleanup finishes. `wait()` resolves only after that cleanup; `settled` then becomes true. Normal completion is delivered after worker exit so its immediate successor can start. Skill actions are not resumed/replayed automatically after restart: inspect fresh server state first.

Generated code receives `mc`, `input`:

```js
const initial = await mc.observe();
const recipes = await mc.call('recipesAll', 'oak_planks');
await mc.call('craft', 'oak_planks', 1);
return await mc.observe();
```

`RPC_DESCRIPTION` documents the complete callable API. It exposes composable low-level operations, not missions or roles. There is no arbitrary `bot[property]` access, host callback invocation, chat/server-command tool, packet-writing tool or plugin loading.

## Reusable skills

```js
const library = new SkillLibrary({ directory: '/var/lib/minecraft-player/skills' });
library.save({ name: 'make-planks', description: 'Craft planks from available logs', code });
const skill = library.get('make-planks');
const id = sandbox.start(skill.code, { worldId });
// The host retrieves the real status; never accept a model-provided action object.
const action = await sandbox.wait(id);
library.verify(skill.name, {
  worldId,
  action,
  expected: { inventoryDelta: { oak_planks: 4 } }
});
```

`verify` requires matching source hash and world, completed execution, explicit host-observed postconditions and relevant observed progress. Supported expectations: `inventory`, `inventoryDelta`, `position:{x,y,z,within}`, `health:{min}`, `blocks:[{x,y,z,name}]`. Existing possession or an unobserved old block does not establish a new success. Block checks use only the final local host snapshot, not historical RPC results. A verifier is evidence of observed postconditions, not a claim of causality or reliability across seeds. Evidence stays tied to its world and action; reusable source carries no world coordinates or mission state unless the author explicitly put those in the source. Changing source clears its verification.

## Tests

```sh
node --test player/rpc.test.mjs player/skills.test.mjs player/sandbox.test.mjs player/sandbox-access.test.mjs
```

The sandbox integration tests require root and systemd, and skip otherwise. They execute real untrusted code, inspect uid/files/environment/socket restrictions, bridge real pipe RPC and cancel a spinning worker. They do not connect to Minecraft or mutate a world.

## Design sources

- [Mine AI MCP](https://github.com/aibengineering/mine-ai-mcp): asynchronous action handles, current state inspection before retries, observed results. Its Bun cache is explicitly not a sandbox.
- [Voyager](https://github.com/MineDojo/Voyager): executable reusable skills, iterative improvement and explicit verification. This implementation uses OS isolation rather than executing generated code in the host bot process.
