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

test('skill observations read the current canonical home state on every call', () => {
  const { bot } = fixture();
  let state = null;
  const rpc = createMinecraftRpc(bot, { Vec3, goals: { GoalNear }, homeState: () => state });
  assert.equal(rpc.observe().homeState, null);
  state = { knowledge: { furnace: 'Observed with coal' }, recordedAt: '2026-11-07T12:00:00Z' };
  assert.deepEqual(rpc.observe().homeState, state);
});

test('entity interaction uses a concrete hit without fabricating shearing or pickup success', async () => {
  const { bot, rpc, inventory } = fixture();
  const sheep = { id: 7, name: 'sheep', height: 1.3, position: new Vec3(1, 64, 0) };
  bot.entities[7] = sheep;
  let resolveInteraction;
  let selected;
  bot.activateEntity = () => { throw new Error('Legacy action 0 is discarded by ViaBackwards'); };
  bot.activateEntityAt = (target, hit) => {
    selected = { target, hit };
    return new Promise(resolve => { resolveInteraction = resolve; });
  };
  const pending = rpc.call('activateEntity', [7]);
  assert.equal(selected.target, sheep);
  assert.deepEqual(selected.hit, new Vec3(1, 64.65, 0));
  resolveInteraction();
  const result = await pending;
  assert.deepEqual(result.inventory, []);
  assert.deepEqual(inventory, [], 'sending a packet is not a wool receipt');
  await assert.rejects(rpc.call('activateEntity', [8]), /no longer visible/);
});

test('fresh sheep metadata and identified drops reach the planner independently of inventory pickup', () => {
  const { bot, rpc } = fixture();
  bot.registry.entitiesByName = { sheep: { metadataKeys: ['baby', 'wool'] } };
  bot.registry.supportFeature = name => { assert.equal(name, 'metadataIxOfItem'); return 8; };
  const sheep = { id: 7, name: 'sheep', position: new Vec3(1, 64, 0), metadata: [] };
  const drop = { id: 8, name: 'item', position: new Vec3(2, 64, 0), metadata: [], getDroppedItem: () => ({ name: 'brown_wool', count: 2, type: 221 }) };
  bot.entities = { 7: sheep, 8: drop };
  let payload = planningObservation(observationFeedback(rpc.observe()));
  assert.equal(payload.entities[0].sheared, undefined, 'spawn precedes metadata, so absence is not unshorn');
  assert.equal(payload.entities[1].item, undefined);
  sheep.metadata = [false, 12];
  payload = planningObservation(observationFeedback(rpc.observe()));
  assert.equal(payload.entities[0].woolColor, 'brown');
  assert.equal(payload.entities[0].sheared, false);
  assert.equal(payload.entities[0].baby, false);
  sheep.metadata[1] = 12 | 16;
  drop.metadata[8] = {};
  payload = planningObservation(observationFeedback(rpc.observe()));
  assert.equal(payload.entities[0].sheared, true);
  assert.equal(payload.entities[1].item.name, 'brown_wool');
  assert.equal(payload.entities[1].item.count, 2);
  assert.deepEqual(payload.inventory, [], 'visible wool is not yet collected');
  sheep.metadata[1] = 12;
  assert.equal(rpc.observe().entities[0].sheared, false, 'grass regrowth must replace the old sheared state');
});

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

test('home chest RPCs expose crafting, placement and verified storage/retrieval without losing carried gear', async () => {
  const { bot, rpc, inventory } = fixture();
  const items = { oak_planks: 2, chest: 3, beef: 4, stone_pickaxe: 5 };
  for (const [name, id] of Object.entries(items)) {
    bot.registry.itemsByName[name] = { id };
    bot.registry.items[id] = { name, stackSize: name === 'stone_pickaxe' ? 1 : 64 };
  }
  inventory.push(
    { name: 'oak_planks', type: 2, count: 24, slot: 9 },
    { name: 'beef', type: 4, count: 2, slot: 10 },
    { name: 'stone_pickaxe', type: 5, count: 1, slot: 11 },
  );
  const block = (name, p) => ({ name, type: name === 'air' ? 0 : 1, position: p, getProperties: () => ({}) });
  let placed = false;
  bot.blockAt = p => block(p.x === 0 ? 'crafting_table' : placed ? 'chest' : 'air', p);
  const recipe = { result: { id: 3, count: 1 }, delta: [{ id: 2, count: -8 }, { id: 3, count: 1 }] };
  bot.recipesFor = (id, metadata, count, table) => id === 3 && table.name === 'crafting_table' ? [recipe] : [];
  bot.craft = async (selected, count) => {
    assert.equal(selected, recipe);
    inventory[0].count -= 8 * count;
    inventory.push({ name: 'chest', type: 3, count, slot: 12 });
  };
  bot.placeBlock = async (reference, face) => {
    assert.equal(reference.name, 'crafting_table');
    assert.deepEqual(face, new Vec3(1, 0, 0));
    inventory.splice(inventory.findIndex(item => item.name === 'chest'), 1);
    placed = true;
  };
  const stored = [];
  const move = (from, to, id, count) => {
    const source = from.find(item => item.type === id);
    assert.ok(source && source.count >= count);
    source.count -= count;
    const target = to.find(item => item.type === id);
    if (target) target.count += count;
    else to.push({ ...source, count });
  };
  let closed = 0;
  bot.openContainer = async at => {
    assert.equal(at.name, 'chest');
    return {
      containerItems: () => stored,
      deposit: async (id, metadata, count) => move(inventory, stored, id, count),
      withdraw: async (id, metadata, count) => move(stored, inventory, id, count),
      close: () => { closed++; },
    };
  };
  await rpc.call('craft', ['chest', 1, { x: 0, y: 64, z: 0 }]);
  const chest = await rpc.call('placeBlock', [{ x: 0, y: 64, z: 0 }, { x: 1, y: 0, z: 0 }]);
  assert.equal(chest.name, 'chest');
  const opened = await rpc.call('openContainer', [{ x: 1, y: 64, z: 0 }]);
  assert.deepEqual(opened.items, []);
  const deposit = await rpc.call('deposit', [opened.handle, 'oak_planks', 12]);
  assert.equal(deposit.items[0].count, 12);
  assert.equal(deposit.inventory.find(item => item.name === 'oak_planks').count, 4);
  assert.equal(deposit.inventory.find(item => item.name === 'beef').count, 2);
  assert.equal(deposit.inventory.find(item => item.name === 'stone_pickaxe').count, 1);
  await rpc.call('closeContainer', [opened.handle]);
  await assert.rejects(rpc.call('withdraw', [opened.handle, 'oak_planks', 1]), /closed or invalid/);
  const reopened = await rpc.call('openContainer', [{ x: 1, y: 64, z: 0 }]);
  assert.equal((await rpc.call('containerItems', [reopened.handle]))[0].count, 12);
  const retrieved = await rpc.call('withdraw', [reopened.handle, 'oak_planks', 4]);
  assert.equal(retrieved.items[0].count, 8);
  assert.equal(retrieved.inventory.find(item => item.name === 'oak_planks').count, 8);
  await rpc.call('closeContainer', [reopened.handle]);
  assert.equal(closed, 2);
});

test('sleep RPC waits for bed-use acknowledgement, exposes wake state and rejects failed bed use', async () => {
  const { bot, rpc } = fixture();
  bot.isSleeping = false;
  let acknowledge;
  bot.sleep = bed => new Promise(resolve => {
    assert.deepEqual(bed.position, new Vec3(0, 64, 0));
    acknowledge = () => { bot.isSleeping = true; resolve(); };
  });
  let settled = false;
  const sleeping = rpc.call('sleep', [{ x: 0, y: 64, z: 0 }]).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'a click/pending call is not acknowledged sleep');
  acknowledge();
  assert.deepEqual(await sleeping, { isSleeping: true });
  bot.wake = async () => { bot.isSleeping = false; };
  assert.deepEqual(await rpc.call('wake'), { isSleeping: false });
  bot.sleep = async () => { throw new Error('there are monsters nearby'); };
  await assert.rejects(rpc.call('sleep', [{ x: 0, y: 64, z: 0 }]), /monsters nearby/);
  assert.equal(bot.isSleeping, false);
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
