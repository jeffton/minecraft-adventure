import test from 'node:test';
import assert from 'node:assert/strict';
import { createMinecraftRpc } from '../rpc.mjs';

class Vec3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
  distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z); }
}
class GoalNear { constructor(x, y, z, range) { Object.assign(this, { x, y, z, range }); } }
class GoalLookAtBlock { constructor(position) { Object.assign(this, position); } }

function fixture() {
  const inventory = [];
  const target = { name: 'oak_log', type: 1, diggable: true, position: new Vec3(3, 64, 0) };
  const events = [];
  const movements = { canDig: true, allow1by1towers: true, allowSprinting: true, scafoldingBlocks: [9] };
  const bot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {}, world: {},
    inventory: { items: () => inventory }, health: 20, food: 20, oxygenLevel: 20,
    registry: { itemsByName: { dirt: { id: 9 } } },
    blockAt: p => p.x === 3 && p.y === 64 && p.z === 0 ? target : { name: 'air', type: 0, position: p },
    pathfinder: {
      movements, setMovements(value) { events.push({ ...value }); }, setGoal() {},
      bestHarvestTool: () => ({ name: 'wooden_axe', type: 5 }),
      async goto(goal) {
        bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
        if (goal instanceof GoalNear) { inventory.push({ name: 'oak_log', count: 1 }); bot.entities = {}; }
      },
    },
    async equip(item) { events.push(item.name); },
    async dig() {
      events.push('dig');
      bot.entities = { 7: { id: 7, name: 'item', position: new Vec3(3, 64, 0) } };
    },
    async waitForTicks() {}, stopDigging() {}, clearControlStates() {}, deactivateItem() {},
  };
  return { bot, events, inventory, rpc: createMinecraftRpc(bot, { Vec3, goals: { GoalNear, GoalLookAtBlock } }) };
}

test('ordinary navigation preserves shelter/materials and restores permissions after error', async () => {
  const { bot, rpc, events } = fixture();
  const original = structuredClone(bot.pathfinder.movements);
  bot.pathfinder.goto = async () => { throw new Error('No route'); };
  await assert.rejects(rpc.call('goto', [{ x: 0, y: 68, z: 0 }]), /No route/);
  assert.deepEqual(events[0], { canDig: false, allow1by1towers: false, allowSprinting: false, scafoldingBlocks: [] });
  assert.deepEqual(bot.pathfinder.movements, original);
  await assert.rejects(rpc.call('goto', [{ x: 0, y: 68, z: 0 }, 1, { canDig: 'true' }]), /Invalid navigation/);
});

test('intentional navigation permissions are scoped to one call', async () => {
  const { rpc, events } = fixture();
  await rpc.call('goto', [{ x: 2, y: 64, z: 0 }, 1, { canDig: true, allowSprinting: true }]);
  assert.equal(events[0].canDig, true);
  assert.equal(events[0].allowSprinting, true);
  assert.equal(events[0].allow1by1towers, false);
  assert.deepEqual(events[0].scafoldingBlocks, []);
});

test('harvesting equips a tool and verifies collected drops rather than counting a broken block', async () => {
  const { rpc, events } = fixture();
  const result = await rpc.call('harvest', [{ x: 3, y: 64, z: 0 }]);
  assert.ok(events.indexOf('wooden_axe') < events.indexOf('dig'));
  assert.deepEqual(result.inventoryDelta, { oak_log: 1 });
  assert.deepEqual(result.remainingDrops, []);
});

test('harvesting reports zero inventory gain when no item drops materialize', async () => {
  const { bot, rpc } = fixture();
  bot.dig = async () => {};
  const result = await rpc.call('harvest', [{ x: 3, y: 64, z: 0 }]);
  assert.deepEqual(result.inventoryDelta, {});
});

test('harvest cancellation during approach cannot resume digging after navigation resolves', async () => {
  const { bot, rpc, events } = fixture();
  let finish;
  bot.pathfinder.goto = () => new Promise(resolve => { finish = resolve; });
  const pending = rpc.call('harvest', [{ x: 3, y: 64, z: 0 }]);
  rpc.cancel();
  finish();
  await assert.rejects(pending, /cancelled/);
  assert.equal(events.includes('dig'), false);
});
