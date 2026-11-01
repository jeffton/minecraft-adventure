import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { navigateHome } from '../navigation.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.4');

function fixture(start) {
  const bot = {
    registry,
    entity: { position: { ...start } },
    pathfinder: {
      setMovements(movements) { this.movements = movements; },
      async goto(goal) { this.goals.push(goal); }
    }
  };
  bot.pathfinder.goals = [];
  return bot;
}

function goalCenter(goal, position) {
  if (goal instanceof goals.GoalNearXZ) return { x: goal.x, y: position.y, z: goal.z };
  return { x: goal.x, y: goal.y, z: goal.z };
}

test('far home uses bounded horizontal waypoints and arrives by full XYZ distance', async () => {
  const bot = fixture({ x: 0, y: 64, z: 0 });
  bot.pathfinder.goto = async function (goal) {
    const from = bot.entity.position;
    const target = goalCenter(goal, from);
    assert.ok(Math.hypot(target.x - from.x, target.y - from.y, target.z - from.z) <= 32,
      'pathfinding goal stays inside the loaded-chunk horizon');
    if (goal instanceof goals.GoalNearXZ) {
      const horizontalDistance = Math.hypot(target.x - from.x, target.z - from.z);
      assert.ok(horizontalDistance <= 25, 'waypoint is no farther than one 24-block horizon');
    }
    this.goals.push(goal);
    bot.entity.position = target;
  };

  let checks = 0;
  await navigateHome(bot, { x: 200, y: 64, z: 0 }, () => { checks++; });

  assert.ok(bot.pathfinder.goals.length > 1);
  assert.ok(bot.pathfinder.goals.slice(0, -1).every(goal => goal instanceof goals.GoalNearXZ));
  assert.ok(bot.pathfinder.goals.at(-1) instanceof goals.GoalNear);
  assert.ok(checks >= bot.pathfinder.goals.length + 1);
  assert.ok(Math.hypot(bot.entity.position.x - 200, bot.entity.position.y - 64, bot.entity.position.z) <= 4);
  const movements = bot.pathfinder.movements;
  assert.equal(movements.canDig, true);
  assert.equal(movements.allowParkour, false);
  assert.equal(movements.allow1by1towers, false);
  assert.equal(movements.maxDropDown, 2);
  assert.equal(movements.dontCreateFlow, true);
});

test('does not treat matching XZ with a distant Y as arrival', async () => {
  const bot = fixture({ x: 10, y: 72, z: 0 });
  await assert.rejects(
    navigateHome(bot, { x: 10, y: 64, z: 0 }, () => {}),
    /no meaningful progress/i
  );
  assert.equal(bot.pathfinder.goals.length, 1);
  assert.ok(bot.pathfinder.goals[0] instanceof goals.GoalNear);
});

test('propagates parent interruption and pathfinder errors without retrying', async () => {
  const interrupted = fixture({ x: 0, y: 64, z: 0 });
  let checks = 0;
  await assert.rejects(
    navigateHome(interrupted, { x: 200, y: 64, z: 0 }, () => {
      if (++checks === 2) throw new Error('parent action interrupted');
    }),
    /parent action interrupted/
  );
  assert.equal(interrupted.pathfinder.goals.length, 1);

  const failed = fixture({ x: 0, y: 64, z: 0 });
  failed.pathfinder.goto = async function (goal) {
    this.goals.push(goal);
    throw new Error('No path to goal');
  };
  await assert.rejects(navigateHome(failed, { x: 200, y: 64, z: 0 }, () => {}), /No path to goal/);
  assert.equal(failed.pathfinder.goals.length, 1);
});

test('a traversable valley detour may temporarily increase vertical distance from home', async () => {
  const bot = fixture({ x: 0, y: 64, z: 0 });
  const home = { x: 30, y: 90, z: 0 };
  bot.pathfinder.goto = async function (goal) {
    this.goals.push(goal);
    bot.entity.position = this.goals.length === 1 ? { x: 24, y: 40, z: 0 } : { ...home };
  };
  await navigateHome(bot, home, () => {});
  assert.equal(bot.pathfinder.goals.length, 2);
  assert.deepEqual(bot.entity.position, home);
});

test('throws when a successful goto returns without moving', async () => {
  const bot = fixture({ x: 0, y: 64, z: 0 });
  await assert.rejects(
    navigateHome(bot, { x: 12, y: 64, z: 0 }, () => {}),
    /no meaningful progress/i
  );
  assert.equal(bot.pathfinder.goals.length, 1);
});
