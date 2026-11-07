import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createMinecraftRpc } from '../rpc.mjs';

// Use the same installed Java registry and recipes as the runtime. No live connection.
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('minecraft-data')('1.21.4');
const { Recipe } = require('prismarine-recipe')('1.21.4');
const { Vec3 } = require('vec3');
const installFurnace = require('mineflayer/lib/plugins/furnace.js');

function fixture(initial) {
  const inventory = new Map(Object.entries(initial));
  const events = [];
  const placed = new Map();
  const furnacePosition = new Vec3(0, 64, 1);
  const referencePosition = new Vec3(1, 63, 0);
  const furnace = Object.assign(new EventEmitter(), {
    id: 1, type: 'minecraft:furnace', slots: [null, null, null],
    inventoryStart: 3, inventoryEnd: 39,
    close() { this.emit('close'); },
  });
  const item = (name, count, slot) => ({ name, count, slot, type: registry.itemsByName[name].id, metadata: 0 });
  const change = (name, amount) => {
    const next = (inventory.get(name) ?? 0) + amount;
    assert.ok(next >= 0, `fixture cannot consume absent ${name}`);
    inventory.set(name, next);
  };
  const recipes = id => Recipe.find(id, null);
  const bot = {
    registry, entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {},
    health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' },
    inventory: { items: () => [...inventory].filter(([, count]) => count > 0).map(([name, count], index) => item(name, count, index + 9)) },
    _client: new EventEmitter(),
    blockAt(p) {
      const name = placed.get(p.toString()) ?? (p.equals(furnacePosition) ? 'furnace' : p.equals(referencePosition) ? 'stone' : 'air');
      return { name, type: registry.blocksByName[name].id, position: p, getProperties: () => ({}) };
    },
    recipesAll: id => recipes(id),
    recipesFor: id => recipes(id).filter(recipe => recipe.delta.every(ingredient => ingredient.count >= 0
      || (inventory.get(registry.items[ingredient.id].name) ?? 0) >= -ingredient.count)),
    async craft(recipe, repetitions, table) {
      assert.equal(table, null, 'torches fit the personal crafting grid');
      for (const ingredient of recipe.delta) change(registry.items[ingredient.id].name, ingredient.count * repetitions);
    },
    async equip(held, destination) {
      assert.equal(destination, 'hand');
      assert.ok((inventory.get(held.name) ?? 0) > 0);
      bot.heldItem = held;
    },
    async placeBlock(reference, face) {
      assert.equal(bot.heldItem?.name, 'torch');
      assert.equal(reference.name, 'stone');
      change('torch', -1);
      placed.set(reference.position.plus(face).toString(), 'torch');
    },
    async openBlock(block) {
      assert.equal(block.name, 'furnace');
      return furnace;
    },
    async transfer(options) {
      assert.equal(options.window, furnace);
      assert.equal(options.sourceStart, 3);
      assert.equal(options.sourceEnd, 39);
      assert.equal(options.destEnd, options.destStart + 1);
      assert.equal(options.metadata, null);
      const name = registry.items[options.itemType].name;
      change(name, -options.count);
      furnace.slots[options.destStart] = item(name, options.count, options.destStart);
    },
    async putAway(slot) {
      const stack = furnace.slots[slot];
      assert.ok(stack, 'cannot retrieve unfinished output');
      change(stack.name, stack.count);
      furnace.slots[slot] = null;
    },
  };
  // Exercise Mineflayer's actual furnace methods, including inventory transfer,
  // output retrieval and listener cleanup, rather than inventing an RPC-shaped API.
  installFurnace(bot);
  const rpc = createMinecraftRpc(bot, { Vec3, goals: {}, onEvent: event => events.push(event) });
  return {
    bot, rpc, events, inventory, furnace, furnacePosition, referencePosition,
    completeServerSmelt() {
      // minecraft-data has no smelting table. This is an explicit simulated
      // server outcome for log + fuel -> charcoal, not a verified live smelt.
      assert.equal(furnace.slots[0]?.name, 'oak_log');
      assert.equal(furnace.slots[1]?.name, 'oak_planks');
      furnace.slots[0] = null;
      furnace.slots[1] = null;
      furnace.slots[2] = item('charcoal', 1, 2);
      furnace.emit('update');
    },
  };
}

for (const fuel of ['coal', 'charcoal']) {
  test(`real 1.21.4 ${fuel} recipe crafts four torches and RPC retains three after observed placement`, async () => {
    const { rpc, referencePosition, inventory } = fixture({ [fuel]: 1, stick: 1 });
    const all = await rpc.call('recipesAll', ['torch', false]);
    const matching = all.find(recipe => recipe.delta.some(ingredient => ingredient.name === fuel && ingredient.count === -1));
    assert.ok(matching);
    assert.equal(matching.result.count, 4);
    assert.equal(matching.requiresTable, false);
    assert.ok(matching.delta.some(ingredient => ingredient.name === 'stick' && ingredient.count === -1));
    const crafted = await rpc.call('craft', ['torch']);
    assert.equal(crafted.inventory.find(stack => stack.name === 'torch').count, 4);
    assert.equal(inventory.get(fuel), 0);
    assert.equal(inventory.get('stick'), 0);
    await rpc.call('equip', ['torch']);
    const block = await rpc.call('placeBlock', [referencePosition, { x: 0, y: 1, z: 0 }]);
    assert.equal(block.name, 'torch');
    assert.deepEqual(block.position, { x: 1, y: 64, z: 0 });
    assert.equal((await rpc.call('blockAt', [block.position])).name, 'torch');
    assert.equal(rpc.observe().inventory.find(stack => stack.name === 'torch').count, 3);
    await assert.rejects(rpc.call('craft', ['torch']), /No currently craftable recipe/);
  });
}

test('existing RPC and real Mineflayer furnace plugin expose charcoal recovery before torch crafting', async () => {
  const fixtureState = fixture({ oak_log: 1, oak_planks: 1, stick: 1 });
  const { rpc, bot, furnacePosition, referencePosition, completeServerSmelt, events } = fixtureState;
  await assert.rejects(rpc.call('craft', ['torch']), /No currently craftable recipe/);
  const opened = await rpc.call('openFurnace', [furnacePosition]);
  assert.deepEqual([opened.input, opened.fuel, opened.output], [null, null, null]);
  await rpc.call('furnacePutInput', [opened.handle, 'oak_log', 1]);
  const loaded = await rpc.call('furnacePutFuel', [opened.handle, 'oak_planks', 1]);
  assert.equal(loaded.input.name, 'oak_log');
  assert.equal(loaded.fuel.name, 'oak_planks');
  assert.equal(loaded.output, null, 'putting fuel in is not proof that smelting completed');
  assert.equal(rpc.observe().inventory.some(stack => stack.name === 'charcoal'), false);
  completeServerSmelt();
  const finished = await rpc.call('furnaceItems', [opened.handle]);
  assert.equal(finished.output.name, 'charcoal');
  const taken = await rpc.call('furnaceTakeOutput', [opened.handle]);
  assert.equal(taken.name, 'charcoal');
  assert.equal(taken.count, 1);
  assert.equal((await rpc.call('furnaceItems', [opened.handle])).output, null);
  await rpc.call('closeContainer', [opened.handle]);
  assert.equal(bot._client.listenerCount('craft_progress_bar'), 0);
  await assert.rejects(rpc.call('furnaceItems', [opened.handle]), /closed or invalid/);
  await rpc.call('craft', ['torch']);
  await rpc.call('equip', ['torch']);
  assert.equal((await rpc.call('placeBlock', [referencePosition, { x: 0, y: 1, z: 0 }])).name, 'torch');
  assert.deepEqual(rpc.observe().inventory.map(({ name, count }) => ({ name, count })), [{ name: 'torch', count: 3 }]);
  assert.ok(events.some(event => event.method === 'furnaceTakeOutput' && event.result.name === 'charcoal'));
});
