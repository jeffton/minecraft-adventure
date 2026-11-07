import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMinecraftRpc } from './rpc.mjs';
import { observationFeedback } from './feedback.mjs';
import { planningObservation } from './mission.mjs';

class Vec3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
  distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z); }
  plus(p) { return new Vec3(this.x + p.x, this.y + p.y, this.z + p.z); }
}
class GoalNear { constructor(x, y, z, range) { Object.assign(this, { x, y, z, range }); } }

function fixture() {
  const inventory = [];
  const counts = { stopped: 0, controls: 0, deactivated: 0 };
  const bot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {},
    health: 20, food: 18, oxygenLevel: 20, game: { dimension: 'overworld' },
    inventory: { items: () => inventory },
    registry: {
      itemsByName: { oak_log: { id: 1 }, oak_planks: { id: 2 } },
      items: { 1: { name: 'oak_log', stackSize: 64 }, 2: { name: 'oak_planks', stackSize: 64 } },
      blocksByName: { oak_log: { id: 1 }, air: { id: 0 } }
    },
    blockAt: p => ({ name: 'air', type: 0, position: p, getProperties: () => ({}) }),
    pathfinder: { setGoal() { counts.stopped++; }, async goto(goal) { bot.entity.position = new Vec3(goal.x, goal.y, goal.z); } },
    stopDigging() { counts.stopped++; }, clearControlStates() { counts.controls++; }, deactivateItem() { counts.deactivated++; },
    recipesAll: () => [{ result: { id: 2, count: 4 }, delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }] }],
    recipesFor: () => inventory.some(item => item.name === 'oak_log') ? bot.recipesAll() : [],
    async craft() { inventory.splice(0, inventory.length, { name: 'oak_planks', type: 2, count: 4, slot: 9 }); }
  };
  return { bot, inventory, counts, rpc: createMinecraftRpc(bot, { Vec3, goals: { GoalNear } }) };
}

test('fresh RPC and strategic observations expose game clock and distinguish rain from thunder', () => {
  const { bot, rpc } = fixture();
  bot.time = { day: 8, timeOfDay: 11600, isDay: true, doDaylightCycle: true };
  bot.isRaining = true;
  bot.rainState = 1;
  for (const thunderLevel of [0, 1, 0.4]) {
    bot.thunderState = thunderLevel;
    const payload = planningObservation(observationFeedback(rpc.observe()));
    assert.equal(payload.time.day, 8);
    assert.equal(payload.time.minecraftTime, '17:36');
    assert.equal(payload.time.secondsUntilNextNightAt20Tps, 70);
    assert.equal(payload.time.secondsUntilNextSunsetAt20Tps, 20);
    assert.deepEqual(payload.weather, { isRaining: true, rainLevel: 1, thunderLevel });
  }
  bot.isRaining = false;
  bot.rainState = 0;
  bot.thunderState = 0;
  assert.deepEqual(rpc.observe().weather, { isRaining: false, rainLevel: 0, thunderLevel: 0 });
});

test('recipe inspection reveals unmet requirements but crafting still rejects missing live materials', async () => {
  const { rpc, inventory } = fixture();
  assert.equal((await rpc.call('recipesAll', ['oak_planks']))[0].delta[0].count, -1);
  await assert.rejects(rpc.call('craft', ['oak_planks']), /No currently craftable/);
  inventory.push({ name: 'oak_log', type: 1, count: 1, slot: 9 });
  await assert.rejects(rpc.call('craft', ['oak_planks', 4]), /Insufficient oak_log/);
  const result = await rpc.call('craft', ['oak_planks']);
  assert.equal(result.inventory[0].name, 'oak_planks');
  assert.equal(result.inventory[0].count, 4);
});

test('waitForIdle waits for cancelled inventory RPC server acknowledgement, not just the abort signal', async () => {
  const { bot, rpc, inventory } = fixture();
  inventory.push({ name: 'oak_log', type: 1, count: 1 });
  let acknowledge;
  bot.craft = () => new Promise(resolve => { acknowledge = resolve; });
  const pending = rpc.call('craft', ['oak_planks']);
  const rejected = assert.rejects(pending, /cancelled/);
  rpc.cancel();
  let idle = false;
  const barrier = rpc.waitForIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);
  acknowledge();
  await rejected;
  await barrier;
  assert.equal(idle, true);
  assert.equal((await rpc.call('observe')).health, 20);
});

test('long tick waits have no fixed tick quota and cancellation drains without leaving listeners', async () => {
  const { bot, rpc } = fixture();
  const events = new EventEmitter();
  bot.on = events.on.bind(events);
  bot.removeListener = events.removeListener.bind(events);
  const completed = rpc.call('waitTicks', [250]);
  for (let tick = 0; tick < 250; tick++) events.emit('physicsTick');
  assert.equal((await completed).health, 20);
  const pending = rpc.call('waitTicks', [1_000_000]);
  const rejected = assert.rejects(pending, /cancelled/);
  rpc.cancel();
  await rejected;
  await rpc.waitForIdle();
  assert.equal(events.listenerCount('physicsTick'), 0);
  assert.equal((await rpc.call('observe')).health, 20);
});

test('RPC cannot traverse host bot internals or invoke arbitrary properties', async () => {
  const { rpc } = fixture();
  for (const method of ['constructor', '__proto__', 'pathfinder.goto', '_client.write', 'chat', 'loadPlugin', 'quit']) {
    await assert.rejects(rpc.call(method, []), /not allowed/);
  }
  await assert.rejects(rpc.call('blockAt', [{ x: NaN, y: 64, z: 0 }]), /Invalid x/);
  await assert.rejects(rpc.call('findBlocks', [{ names: ['__proto__'] }]), /Unknown block/);
});

test('goto returns actual current position and rejects invalid coordinate injection', async () => {
  const { rpc } = fixture();
  assert.deepEqual(await rpc.call('goto', [{ x: 4, y: 65, z: 3 }, 1]), { x: 4, y: 65, z: 3 });
  assert.deepEqual(rpc.observe().position, { x: 4, y: 65, z: 3 });
  await assert.rejects(rpc.call('goto', [{ x: 1, y: 1e20, z: 3 }]), /Invalid y/);
});

test('cancelled late container open closes host window and cannot leak stale handle into next action', async () => {
  const { bot, rpc, counts } = fixture();
  let resolve;
  let closed = 0;
  bot.openContainer = () => new Promise(done => { resolve = done; });
  const opening = rpc.call('openContainer', [{ x: 0, y: 64, z: 0 }]);
  rpc.cancel();
  await assert.rejects(rpc.call('observe'), /still settling/);
  resolve({ close() { closed++; } });
  await assert.rejects(opening, /cancelled/);
  assert.equal(closed, 1);
  assert.ok(counts.stopped && counts.controls && counts.deactivated);
  assert.equal((await rpc.call('observe')).health, 20);
  await assert.rejects(rpc.call('containerItems', ['made-up-handle']), /invalid/);
});

test('abort stops Minecraft host work, not only the isolated JavaScript process', async () => {
  const { bot, rpc, counts } = fixture();
  let rejectGoto;
  bot.pathfinder.goto = () => new Promise((resolve, reject) => { rejectGoto = reject; });
  bot.pathfinder.setGoal = goal => { if (goal === null) { counts.stopped++; rejectGoto?.(new Error('path interrupted')); } };
  const controller = new AbortController();
  const pending = rpc.call('goto', [{ x: 100, y: 64, z: 0 }], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /path interrupted/);
  assert.ok(counts.controls > 0);
  assert.equal((await rpc.call('observe')).position.x, 0);
});
