import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { installReflexes, nearbyThreats } from '../reflexes.mjs';
import { playerState, skillEvidence } from '../observations.mjs';

function fixture() {
  const events = [];
  const position = { x: 1, y: 64, z: 2, distanceTo: target => Math.hypot(target.x - 1, target.y - 64, target.z - 2) };
  const bot = {
    entity: { position, isInWater: false }, entities: {}, health: 20, food: 12, oxygenLevel: 20,
    _client: { ended: false }, game: { dimension: 'overworld' }, version: '1.21.4',
    registry: { foodsByName: { cooked_beef: { foodPoints: 8 } } },
    inventory: { items: () => [{ name: 'cooked_beef', count: 1, type: 5 }] },
    pathfinder: { setGoal: goal => events.push(['goal', goal]) },
    setControlState: (...args) => events.push(['control', ...args]),
    equip: async item => events.push(['equip', item.name]),
    consume: async () => { bot.food = 20; }, attack: enemy => events.push(['attack', enemy.name]),
  };
  return { bot, events };
}

test('local eating interrupts a program and reports only observed hunger increase', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { bot, events } = fixture();
  const stop = installReflexes(bot, { acquire: async reason => events.push(['interrupt', reason]), release: () => events.push(['release']), goals: {}, emit: (...args) => events.push(args), onError: error => { throw error; } });
  t.mock.timers.tick(500);
  await setImmediate();
  stop();
  assert.equal(bot.food, 20);
  assert.deepEqual(events[0], ['interrupt', 'eating']);
  assert.deepEqual(events.find(event => event[0] === 'equip'), ['equip', 'cooked_beef']);
  assert.equal(events.find(event => event[0] === 'eat')[2].verified, true);
});

test('drowning interrupts before upward swimming, without starting inventory work', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { bot, events } = fixture();
  bot.entity.isInWater = true;
  bot.oxygenLevel = 3;
  const stop = installReflexes(bot, { acquire: async reason => events.push(['interrupt', reason]), release: () => events.push(['release']), goals: {}, emit: (...args) => events.push(args), onError: error => { throw error; } });
  t.mock.timers.tick(500);
  await setImmediate();
  stop();
  assert.deepEqual(events[0], ['interrupt', 'surfacing for air']);
  assert.ok(events.some(event => event[0] === 'control' && event[1] === 'jump' && event[2]));
  assert.equal(events.some(event => event[0] === 'equip'), false);
});

test('safety retains exclusive ownership throughout asynchronous consumption', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { bot, events } = fixture();
  let finishMeal;
  bot.consume = () => new Promise(resolve => { finishMeal = () => { bot.food = 20; resolve(); }; });
  const stop = installReflexes(bot, { acquire: async reason => events.push(['acquire', reason]), release: () => events.push(['release']), goals: {}, emit: (...args) => events.push(args), onError: error => { throw error; } });
  t.mock.timers.tick(500);
  await setImmediate();
  t.mock.timers.tick(2000);
  await setImmediate();
  assert.equal(events.filter(event => event[0] === 'acquire').length, 1);
  assert.equal(events.some(event => event[0] === 'release'), false);
  finishMeal();
  await setImmediate();
  assert.equal(events.filter(event => event[0] === 'release').length, 1);
  stop();
});

test('neutral animals are not threats and one current-world Roy is projected', () => {
  const { bot } = fixture();
  const animalPosition = { x: 2, y: 64, z: 2, distanceTo: () => 1 };
  bot.entities = { 1: { name: 'cow', position: animalPosition }, 2: { name: 'enderman', position: animalPosition, metadata: {} } };
  assert.equal(nearbyThreats(bot).length, 0);
  const state = playerState(bot, { worldId: 'fresh', session: 'new', life: 1, notes: {}, events: [], action: 'mining', thinking: true, error: null });
  assert.equal(state.worldId, 'fresh');
  assert.equal(state.bots.length, 1);
  assert.equal(state.bots[0].task, 'mining');
  assert.equal(state.bots[0].life, 1);
});

test('verified inventory deltas aggregate server stacks rather than replacing duplicate slots', () => {
  const effects = skillEvidence({ health: 20, food: 12, inventory: [{ name: 'oak_log', count: 64 }, { name: 'oak_log', count: 2 }] }, { health: 18, food: 20, inventory: [{ name: 'oak_log', count: 64 }, { name: 'oak_log', count: 5 }] });
  assert.deepEqual(effects, { inventoryDelta: { oak_log: 3 }, healthDelta: -2, foodDelta: 8 });
});
