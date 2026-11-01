import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { configureFood, observeMeals, patchSurvivalSource, retreat, shouldFlee, safeToResume, interruptedProgramRetry, withSafetyAction } from '../survival.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { plugin } = require('mineflayer-auto-eat');
const { Vec3 } = require('vec3');
const registry = require('minecraft-data')('1.21.4');
const upstream = '/opt/minecraft-mindcraft/src/agent/';
const upstreamAgent = readFileSync(`${upstream}agent.js`, 'utf8');
const patchedAgent = patchSurvivalSource(upstreamAgent, `${upstream}agent.js`, '../survival.mjs');
const optionsBlock = patchedAgent.match(/this\.bot\.autoEat\.options = \{[\s\S]*?\n        \};/)[0];

function fixture(items = [{ name: 'chicken', count: 2 }]) {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.username = 'Test';
  bot.health = 6;
  bot.food = 2;
  bot.entity = { id: 1, position: new Vec3(0, 64, 0) };
  bot.entities = {};
  bot.inventory = { items: () => items, slots: [], requiresConfirmation: false };
  bot.registry = registry;
  bot.supportFeature = () => false;
  bot.getEquipmentDestSlot = hand => hand === 'off-hand' ? 45 : 36;
  bot.equip = async (item, hand) => { bot.inventory.slots[bot.getEquipmentDestSlot(hand)] = item; };
  bot.deactivateItem = () => {};
  bot.activateItem = () => {};
  bot.waitForTicks = async () => {};
  plugin(bot);
  vm.runInNewContext(optionsBlock, { bot });
  configureFood(bot);
  return bot;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('the real upstream options patch retains plugin timing, hand restoration and pickup defaults', () => {
  const bot = fixture();
  assert.equal(bot.autoEat.options.eatingTimeout, 3000);
  assert.equal(bot.autoEat.options.checkOnItemPickup, true);
  assert.equal(bot.autoEat.options.offhand, true);
  assert.equal(bot.autoEat.options.equipOldItem, true);
  assert.equal(bot.autoEat.options.startAt, 19);
  for (const item of ['chorus_fruit', 'suspicious_stew', 'golden_apple']) assert.ok(bot.autoEat.options.bannedFood.includes(item));
  assert.throws(() => patchSurvivalSource('', `${upstream}agent.js`, ''), /integration point changed/);
});

test('raw chicken is emergency food, not preferred over available safe food', async () => {
  const bot = fixture();
  assert.ok(!bot.autoEat.options.bannedFood.includes('chicken'));
  bot.food = 15; bot.health = 20;
  assert.ok(bot.autoEat.options.bannedFood.includes('chicken'));
  await assert.rejects(bot.autoEat.eat(), /No food found/);
  bot.food = 2;
  bot.inventory.items = () => [{ name: 'chicken', count: 2 }, { name: 'beef', count: 1 }];
  assert.ok(bot.autoEat.options.bannedFood.includes('chicken'));
  bot.inventory.items = () => [{ name: 'chicken', count: 2 }];
  bot.health = 6; bot.food = 10;
  assert.ok(!bot.autoEat.options.bannedFood.includes('chicken'));
  bot.emit('end');
});

test('actual autoeat waits for consumption and only server evidence confirms a meal once', async () => {
  const bot = fixture();
  const meals = [];
  let finished = false;
  observeMeals(bot, meal => meals.push(meal));
  const eating = bot.autoEat.eat().then(() => { finished = true; });
  await settle();
  assert.equal(finished, false);
  bot.emit('autoeat_finished', { name: 'chicken' });
  assert.equal(meals.length, 0);
  bot._client.emit('entity_status', { entityId: 2, entityStatus: 9 });
  assert.equal(meals.length, 0);
  bot._client.emit('entity_status', { entityId: 1, entityStatus: 9 });
  await eating;
  assert.equal(meals.length, 1);
  assert.equal(meals[0].verified, true);
  assert.equal(meals[0].item, 'chicken');
  assert.equal(meals[0].count, 1);
  bot.food = 4; bot.emit('health');
  assert.equal(meals.length, 1);
  bot.emit('end');
});

test('plugin timeout is not consumption evidence; death and equipment cancellation cannot count meals', async () => {
  const bot = fixture();
  bot.autoEat.options.eatingTimeout = 10;
  const meals = [];
  observeMeals(bot, meal => meals.push(meal));
  await bot.autoEat.eat();
  assert.equal(meals.length, 0);
  bot.inventory.slots[45] = { name: 'wooden_pickaxe', count: 1 };
  bot._client.emit('entity_status', { entityId: 1, entityStatus: 9 });
  assert.equal(meals.length, 0);
  bot.emit('death');
  bot.food = 4; bot.emit('health');
  assert.equal(meals.length, 0);
  bot.emit('end');
});

test('server food gain can confirm before consumption packet, without duplicate counting', () => {
  const bot = fixture();
  const meals = [];
  observeMeals(bot, meal => meals.push(meal));
  bot.autoEat.disable();
  bot.emit('autoeat_started', { name: 'chicken' }, false);
  bot.food = 4; bot.emit('health');
  assert.equal(meals.length, 1);
  bot._client.emit('entity_status', { entityId: 1, entityStatus: 9 });
  assert.equal(meals.length, 1);
  bot.emit('end');
});

function enemy(name, distance) {
  return { name, type: 'hostile', position: { distanceTo: () => distance } };
}

test('healthy armed bots can defend, while creepers, hunger and injury still require retreat', () => {
  const bot = fixture([{ name: 'stone_sword', count: 1 }]);
  bot.health = 20; bot.food = 20;
  assert.equal(shouldFlee(bot, enemy('zombie', 5)), false);
  assert.equal(shouldFlee(bot, enemy('creeper', 5)), true);
  bot.health = 6;
  assert.equal(shouldFlee(bot, enemy('zombie', 5)), true);
  bot.health = 20; bot.food = 2;
  assert.equal(shouldFlee(bot, enemy('zombie', 5)), true);
  bot.food = 20;
  bot.entities = { 2: enemy('zombie', 5), 3: enemy('zombie', 7) };
  assert.equal(shouldFlee(bot, bot.entities[2]), true);
  bot.entities = {};
  assert.equal(shouldFlee(bot, enemy('skeleton', 9)), true);
  bot.inventory.slots[45] = { name: 'shield' };
  assert.equal(shouldFlee(bot, enemy('skeleton', 3)), false);
  assert.equal(shouldFlee(bot, enemy('skeleton', 9)), true);
});

test('retreat is bounded, cancellable and never pauses emergency preservation', async () => {
  for (const cancel of [false, true]) {
    const bot = fixture();
    bot.entities = { 2: enemy('zombie', 5) };
    let time = 0;
    let moves = 0;
    let lastGoal;
    bot.pathfinder = {
      setMovements: () => {},
      setGoal: goal => { lastGoal = goal; moves++; }
    };
    await retreat(bot, { now: () => time, wait: async ms => {
      time += ms;
      if (cancel) bot.interrupt_code = true;
    } });
    assert.equal(time, cancel ? 250 : 6000);
    assert.equal(lastGoal, null);
    assert.ok(moves > 1);
  }
});

test('only safety interruption retries locally, after active safety work ends; sheltered enemies do not deadlock', () => {
  const bot = fixture();
  bot.entities = { 2: enemy('zombie', 4) };
  bot.adventureSafetyActions = 1;
  assert.equal(interruptedProgramRetry('interrupted', bot), false);
  bot.adventureSafetyActions = 0;
  // An enemy behind a wall does not trigger the actual safety modes. Mere
  // proximity must not stop a sheltered bot from preparing food and weapons.
  assert.equal(interruptedProgramRetry('interrupted', bot), true);
  for (const kind of ['navigation', 'precondition', 'execution', null]) assert.equal(interruptedProgramRetry(kind, bot), false);
  bot.health = 0;
  assert.equal(safeToResume(bot), false);
});

test('safety action ownership survives cancellation and clears even on failure', async () => {
  const bot = fixture();
  let release;
  const running = withSafetyAction(bot, () => new Promise(resolve => { release = resolve; }));
  assert.equal(safeToResume(bot), false);
  release();
  await running;
  assert.equal(safeToResume(bot), true);
  await assert.rejects(withSafetyAction(bot, async () => { throw new Error('cancelled'); }), /cancelled/);
  assert.equal(safeToResume(bot), true);
});

test('patched real defendSelf keeps cowardice eligible for injury or reinforcements', async () => {
  const patched = patchSurvivalSource(readFileSync(`${upstream}library/skills.js`, 'utf8'), `${upstream}library/skills.js`, '../survival.mjs');
  const body = patched.slice(patched.indexOf('export async function defendSelf('), patched.indexOf('export async function collectBlock('))
    .replace('export async function', 'async function');
  const paused = [];
  const bot = { modes: { pause: mode => paused.push(mode) }, pvp: { stop() {} } };
  const context = { bot, world: { getNearestEntityWhere: () => null }, mc: {}, log() {} };
  vm.createContext(context);
  vm.runInContext(body, context);
  await vm.runInContext('defendSelf(bot)', context);
  assert.deepEqual(paused, ['self_defense']);
});

test('patched upstream mode order keeps self-preservation first and permits armed self-defense', async () => {
  const source = patchSurvivalSource(readFileSync(`${upstream}modes.js`, 'utf8'), `${upstream}modes.js`, '../survival.mjs')
    .replace(/^import .*;?\n/gm, '').replace('export function initModes', 'function initModes');
  for (const armed of [false, true]) {
    const calls = [];
    const bot = fixture(armed ? [{ name: 'stone_sword', count: 1 }] : []);
    bot.health = 20; bot.food = 20;
    bot.blockAt = () => ({ name: 'air' });
    bot.lastDamageTime = 0;
    const agent = { bot, shut_up: true, isIdle: () => false,
      self_prompter: { isActive: () => false },
      prompter: { getInitModes: () => ({ unstuck: false }) },
      actions: { currentActionLabel: 'adventure:runProgram', resume_func: null,
        runAction: async (label, fn) => { calls.push(label); await fn(); return { interrupted: true }; } } };
    const context = { agent, Date, Math, console: { log() {} }, settings: { narrate_behavior: false },
      shouldFlee, retreat: async () => {}, mc: { isHostile: () => true },
      world: { getNearestEntityWhere: () => enemy('zombie', 5), isClearPath: async () => true },
      skills: { defendSelf: async () => {} }, convoManager: {} };
    vm.createContext(context);
    vm.runInContext(source + '\ninitModes(agent);', context);
    await vm.runInContext('agent.bot.modes.update()', context);
    await settle();
    assert.deepEqual(calls, [armed ? 'mode:self_defense' : 'mode:cowardice']);
    assert.ok(source.indexOf("name: 'self_preservation'") < source.indexOf("name: 'cowardice'"));
  }
});
