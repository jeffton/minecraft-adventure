import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchCraftSource, patchInventorySource } from '../compat-loader.mjs';

const upstream = '/opt/minecraft-mindcraft/node_modules/mineflayer/lib/plugins/';

function craftFixture(output, remainder) {
  const source = patchCraftSource(readFileSync(upstream + 'craft.js', 'utf8'));
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: name => {
    if (name === 'assert') return assert;
    if (name === '../promise_utils') return { once() { throw new Error('No table window expected'); } };
    if (name === 'prismarine-item') return () => class Item {};
    if (name === 'prismarine-recipe') return () => ({ Recipe: {} });
    throw new Error(name);
  } });
  const collected = [];
  const window = { slots: [output, remainder, null, null, null], selectedItem: null, inventoryStart: 9, inventoryEnd: 45,
    updateSlot() { throw new Error('Crafting must not fabricate authoritative slots'); } };
  const bot = { registry: {}, inventory: window,
    putSelectedItemRange: async () => {},
    putAway: async slot => { collected.push(window.slots[slot]); window.slots[slot] = null; } };
  module.exports(bot);
  const recipe = { result: { id: 7, count: 4 }, inShape: [[{ id: -1 }]] };
  return { bot, collected, recipe };
}

test('crafting refuses an absent server result rather than fabricating successful output', async () => {
  const f = craftFixture(null, null);
  await assert.rejects(f.bot.craft(f.recipe, 1, null), /Server did not produce/);
  assert.equal(f.collected.length, 0);
});

test('crafting collects actual server output and remainder without rewriting ingredient slots', async () => {
  const output = { type: 7, count: 4 };
  const remainder = { type: 9, count: 1 };
  const f = craftFixture(output, remainder);
  await f.bot.craft(f.recipe, 1, null);
  assert.deepEqual(f.collected, [output, remainder]);
});

test('sync rejects an old window object even when its ID has been reused', async () => {
  const source = patchInventorySource(readFileSync(upstream + 'inventory.js', 'utf8'));
  const start = source.indexOf('  async function syncWindow (window) {');
  const end = source.indexOf('  bot._syncWindow = syncWindow', start);
  let clicks = 0;
  const bot = { supportFeature: () => true, inventory: { id: 0 }, currentWindow: { id: 4 } };
  const sync = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    bot, authoritativeInventory: { click: async () => { clicks++; } }
  });
  await assert.rejects(sync({ id: 4 }), /window replaced/);
  assert.equal(clicks, 0);
  await sync(bot.currentWindow);
  assert.equal(clicks, 1);
});

test('inventory and craft hooks compile against the installed upstream and reject changed anchors', () => {
  new vm.Script(patchInventorySource(readFileSync(upstream + 'inventory.js', 'utf8')));
  new vm.Script(patchCraftSource(readFileSync(upstream + 'craft.js', 'utf8')));
  assert.throws(() => patchInventorySource('changed upstream'), /integration point changed/);
  assert.throws(() => patchCraftSource('changed upstream'), /integration point changed/);
});
