import '../bots/compat-loader.mjs';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { PersistentController } from './controller.mjs';
import { SkillSandbox } from './sandbox.mjs';
import { createMinecraftRpc } from './rpc.mjs';

// Run only inside the documented isolated server's private network namespace.
// This host imports neither the model adapter nor credentials/broker clients.
const root = process.env.CONTROLLER_E2E_ROOT;
assert(root?.startsWith('/var/lib/minecraft-controller-e2e/'), 'An isolated E2E directory is required');
assert.notEqual(process.getuid(), 0, 'The E2E player must be nonroot');
const durationMs = Number(process.env.CONTROLLER_E2E_DURATION_MS ?? 300_000);
assert(durationMs >= 300_000 && durationMs <= 600_000, 'Real E2E requires 5–10 minutes');
const socketPath = `${root}/sandbox.sock`;
const worldId = 'controller-e2e';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
// Independent of broker promises; systemd additionally kills the full probe cgroup.
const watchdog = setTimeout(() => { console.error('E2E watchdog expired'); process.exit(1); }, durationMs + 120_000);
const events = [];
const log = event => {
  const record = { at: new Date().toISOString(), ...event };
  events.push(record);
  console.log(JSON.stringify(record));
};

async function blockedConnection(options) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(options);
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); reject(new Error('Forbidden model/network endpoint was reachable')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Network block must fail explicitly, not time out')); });
    socket.once('error', error => resolve(error.code));
  });
}

const boundary = {
  external: await blockedConnection({ host: '1.1.1.1', port: 443 }),
  credentialSocket: await blockedConnection({ path: '/run/minecraft-planner-auth/auth.sock' }),
  productionProxy: await blockedConnection({ host: '127.0.0.1', port: 25567 }),
};
assert(['ENETUNREACH', 'EACCES', 'EPERM'].includes(boundary.external));
assert(['ENOENT', 'EACCES', 'EPERM'].includes(boundary.credentialSocket));
assert.equal(boundary.productionProxy, 'ECONNREFUSED');
log({ type: 'model-access-blocked', boundary });
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25576, username: 'ControllerProbe', auth: 'offline', version: '1.21.4', viewDistance: 'short' });
let fatal = null;
let deaths = 0;
let stopping = false;
let sandbox;
const abortAction = () => { if (sandbox?.activeId) sandbox.cancel(sandbox.activeId, 'Minecraft connection lost'); };
bot.on('kicked', reason => { fatal = new Error(`Kicked: ${JSON.stringify(reason)}`); abortAction(); });
bot.on('error', error => { fatal = error; log({ type: 'bot-error', error: error.message }); });
bot.on('death', () => { deaths++; log({ type: 'death' }); });
bot.on('end', () => { if (!stopping) { fatal = new Error('Minecraft connection ended'); abortAction(); } });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server spawn deadline exceeded')), 45_000);
    bot.once('spawn', () => { clearTimeout(timer); resolve(); });
    bot.once('error', reject);
    bot.once('kicked', reason => reject(new Error(JSON.stringify(reason))));
  });
  assert.equal(bot.game.gameMode, 'survival');
  bot.loadPlugin(pathfinder);
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowSprinting = false;
  movements.allowParkour = false;
  movements.maxDropDown = 3;
  movements.scafoldingBlocks = [];
  bot.pathfinder.setMovements(movements);
  const rpc = createMinecraftRpc(bot, { Vec3, goals, onEvent: event => {
    if (event.type === 'block-mined' || event.method === 'placeBlock') log({ type: 'world-effect', event });
  } });
  sandbox = new SkillSandbox({ rpc, socketPath, onEvent: event => {
    if (event.type === 'rpc-result') log({ type: 'rpc', method: event.call.method, error: event.call.error ?? null });
  } });
  const controller = await new PersistentController({ directory: `${root}/state`, worldId, socketPath, isActionActive: () => Boolean(sandbox.activeId), onEvent: log }).open();
  const observe = () => {
    const snapshot = rpc.observe();
    // Controllers can request detailed surroundings through the action RPC;
    // decisions receive bounded snapshots just like the production adapter.
    return { ...snapshot, blocks: snapshot.blocks.slice(0, 24), worldId, session: 'isolated-e2e', life: deaths };
  };
  const source = await readFile(fileURLToPath(new URL('./test/fixtures/controller-survival.mjs', import.meta.url)), 'utf8');
  const fixtures = [{ observation: observe() }, { observation: observe(), state: { generation: 5 }, lastResult: { state: 'failed', error: 'Observed path failure' } }];
  const first = await controller.candidate({ name: 'AI-authored survival revision one', code: source, fixtures });
  const second = await controller.candidate({ name: 'AI-authored survival revision two', code: source.replace("revision: 'one'", "revision: 'two'").replace('Establish supplies and a crafting foothold', 'Expand retained materials and crafting supplies'), fixtures });
  for (const version of [first.version, second.version]) {
    const validation = await controller.validate(version);
    assert.equal(validation.status, 'validated', validation.error);
  }
  await controller.activate(first.version);
  const started = Date.now();
  const initial = observe();
  const samples = [{ elapsedMs: 0, observation: initial }];
  let lastResult = null;
  let switched = false;
  let rejectedMidAction = false;
  let actionCount = 0;
  let activeMs = 0;
  const completedVersions = new Set();
  const sampler = setInterval(() => {
    const sample = { elapsedMs: Date.now() - started, observation: observe() };
    samples.push(sample);
    log({ type: 'sample', ...sample });
  }, 15_000);
  try {
    while (Date.now() - started < durationMs) {
      if (fatal) throw fatal;
      assert.equal(deaths, 0, 'Survival E2E failed: player died');
      if (switched === false && rejectedMidAction) {
        await controller.activate(second.version);
        switched = true;
        log({ type: 'version-switch', previous: first.version, current: controller.current().version });
      }
      const decision = await controller.decide(observe(), lastResult && {
        state: lastResult.state, error: lastResult.error, name: lastResult.name,
      });
      if (!decision.action) {
        log({ type: 'idle', reason: decision.reason });
        await sleep(decision.wakeAfterMs);
        continue;
      }
      const action = decision.action;
      const actionStarted = Date.now();
      const id = sandbox.start(action.code, { name: action.name, input: action.input, worldId });
      log({ type: 'action-start', id, version: controller.current().version, name: action.name, revision: action.input.revision });
      if (!rejectedMidAction) {
        await assert.rejects(controller.activate(second.version), /boundary/);
        rejectedMidAction = true;
        log({ type: 'mid-action-version-switch-rejected', id });
      }
      const remaining = durationMs - (Date.now() - started);
      const deadline = setTimeout(() => sandbox.cancel(id, 'Five-minute E2E window completed'), Math.max(1, remaining));
      try { lastResult = await sandbox.wait(id); }
      finally { clearTimeout(deadline); }
      activeMs += Date.now() - actionStarted;
      actionCount++;
      if (lastResult.state === 'completed') completedVersions.add(controller.current().version);
      log({ type: 'action-end', id, state: lastResult.state, error: lastResult.error ?? null, inventory: lastResult.after?.inventory, result: lastResult.value });
    }
  } finally { clearInterval(sampler); }
  if (fatal) throw fatal;
  assert.equal(deaths, 0, 'Survival E2E failed: player died');
  const final = observe();
  const counts = observation => Object.fromEntries(observation.inventory.map(item => [item.name, observation.inventory.filter(i => i.name === item.name).reduce((n, i) => n + i.count, 0)]));
  const before = counts(initial);
  const after = counts(final);
  const inventoryDelta = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].map(name => [name, (after[name] ?? 0) - (before[name] ?? 0)]).filter(([, delta]) => delta));
  const positiveItems = Object.entries(inventoryDelta).filter(([, delta]) => delta > 0);
  const effects = events.filter(event => event.type === 'world-effect');
  const report = { startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, modelAccess: boundary, modelCalls: 0, deaths, actionCount, activeMs, activeRatio: activeMs / (Date.now() - started), switched, rejectedMidAction, versions: [first.version, second.version], inventoryDelta, initial, final, samples, worldEffectCount: effects.length, completedVersions: [...completedVersions], events };
  await writeFile(`${root}/output/report.json`, JSON.stringify(report, null, 2));
  assert(switched && rejectedMidAction, 'Both the protected boundary and version switch must be observed');
  assert(actionCount >= 2, 'More than one controller action must execute');
  assert(completedVersions.has(first.version) && completedVersions.has(second.version), 'Successful actions required under both versions');
  const lateEffects = effects.filter(event => Date.parse(event.at) >= started + durationMs - 60_000);
  assert(lateEffects.length > 0, 'Real progression required in the final minute, not just an early burst');
  for (let minute = 0; minute < Math.ceil(durationMs / 60_000); minute++) {
    const windowEffects = effects.filter(event => Date.parse(event.at) >= started + minute * 60_000 && Date.parse(event.at) < started + (minute + 1) * 60_000);
    assert(windowEffects.length > 0, `No meaningful world effect observed in minute ${minute + 1}`);
  }
  assert(positiveItems.length >= 2, 'Meaningful retained inventory progression required');
  assert(effects.length >= 3, 'Real server-backed world effects required');
  assert.equal(final.health > 0, true);
  log({ type: 'passed', report: `${root}/output/report.json`, elapsedMs: report.elapsedMs, actionCount, inventoryDelta, worldEffectCount: effects.length, activeRatio: report.activeRatio });
} finally {
  stopping = true;
  if (sandbox?.activeId) {
    const id = sandbox.activeId;
    sandbox.cancel(id, 'E2E cleanup');
    await sandbox.wait(id);
  }
  bot.quit();
  clearTimeout(watchdog);
}
