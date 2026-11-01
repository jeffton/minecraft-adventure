import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { scoutForResource } from '../scout.mjs';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('minecraft-data')('1.21.4');
const { Vec3 } = require('vec3');

test('injured hungry bot can walk toward actual food without digging, teleporting or inventing a Y', async () => {
  const walks = [];
  let movements;
  let cleared = false;
  const bot = {
    registry, game: { gameMode: 'survival' }, health: 2, food: 0,
    entity: { position: new Vec3(0, 64, 0) },
    entities: { sheep: { name: 'sheep', position: new Vec3(10, 66, 0) } },
    pathfinder: {
      setMovements: value => { movements = value; },
      goto: async goal => { walks.push(goal); bot.entity.position = new Vec3(goal.x, goal.y, goal.z); },
      setGoal: goal => { cleared = goal === null; }
    }, waitForTicks: async () => {}
  };
  const result = await scoutForResource({ name: 'Moss', bot }, 'food', 96);
  assert.match(result, /Observed sheep/);
  assert.equal(walks.length, 1);
  assert.equal(walks[0].y, 66, 'target Y is observed on the actual entity');
  assert.equal(movements.canDig, false);
  assert.equal(movements.allow1by1towers, false);
  assert.equal(movements.maxDropDown, 1);
  assert.equal(bot.health, 2);
  assert.equal(bot.food, 0);
  assert.equal(cleared, true);
});

test('unknown resource and creative mode are rejected without movement', async () => {
  const bot = { registry, game: { gameMode: 'creative' }, entity: { position: new Vec3(0, 64, 0) } };
  await assert.rejects(scoutForResource({ name: 'Roy', bot }, 'wood', 96), /survival/);
});
