import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createReflexController, nearbyThreats } from '../reflexes.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Vec3 } = require('vec3');

function fixture({ name = 'zombie', position = new Vec3(2, 0, 0), barriers = [] } = {}) {
  const calls = { acquired: [], released: 0, goals: [], attacks: [], errors: [] };
  // Geometric test world: ray/axis-aligned-box intersection, with solid walls
  // independent of the reflex's exposure sampling implementation.
  const raycast = (origin, direction, distance) => {
    for (const [min, max] of barriers) {
      let enter = 0;
      let leave = distance;
      for (const axis of ['x', 'y', 'z']) {
        if (direction[axis] === 0) {
          if (origin[axis] < min[axis] || origin[axis] > max[axis]) { leave = -1; break; }
        } else {
          const ends = [(min[axis] - origin[axis]) / direction[axis], (max[axis] - origin[axis]) / direction[axis]].sort((a, b) => a - b);
          enter = Math.max(enter, ends[0]);
          leave = Math.min(leave, ends[1]);
        }
      }
      if (enter <= leave) return { name: 'stone' };
    }
    return null;
  };
  const movements = {
    canDig: true, allow1by1towers: true, scafoldingBlocks: [1, 4],
    allowSprinting: false, allowParkour: true, maxDropDown: 8,
    infiniteLiquidDropdownDistance: true,
  };
  const initial = { ...movements };
  let time = 10000;
  const bot = {
    entity: { id: 1, position: new Vec3(0, 0, 0), height: 1.8 },
    entities: { 2: { id: 2, name, position, height: 1.8 } },
    world: { raycast }, health: 20, food: 20, oxygenLevel: 20, _client: { ended: false },
    pathfinder: { movements, setGoal: goal => calls.goals.push(goal) },
    setControlState() {}, inventory: { items: () => [] },
    lookAt: async () => {}, attack: entity => calls.attacks.push(entity.id),
  };
  const options = {
    acquire: async reason => calls.acquired.push(reason), release: () => calls.released++,
    goals: { GoalNear: class { constructor(...args) { this.args = args; } }, GoalInvert: class { constructor(goal) { this.goal = goal; } } },
    emit() {}, onError: error => calls.errors.push(error), now: () => time,
  };
  const controller = createReflexController(bot, options);
  return { bot, calls, controller, initial, advance: amount => { time += amount; }, options };
}

const wall = [new Vec3(0.8, -1, -2), new Vec3(1.2, 4, 2)];
const roof = [new Vec3(-3, 2, -3), new Vec3(3, 3, 3)];

test('solid wall and sealed roof prevent reflex interruptions by nearby mobs', async () => {
  for (const args of [
    { barriers: [wall] },
    { name: 'creeper', barriers: [wall] },
    { name: 'skeleton', position: new Vec3(0, 3, 0), barriers: [roof] },
  ]) {
    const f = fixture(args);
    assert.deepEqual(nearbyThreats(f.bot), []);
    await f.controller.tick();
    assert.deepEqual(f.calls.acquired, []);
    assert.deepEqual(f.calls.goals, []);
    assert.deepEqual(f.bot.pathfinder.movements, f.initial);
    f.controller.close();
  }
});

test('low cover does not hide an exposed upper body; nearby exposed zombie is defended against', async () => {
  const f = fixture({ barriers: [[new Vec3(0.8, -1, -2), new Vec3(1.2, 1, 2)]] });
  assert.equal(nearbyThreats(f.bot).length, 1);
  await f.controller.tick();
  assert.deepEqual(f.calls.attacks, [2]);
  f.controller.close();
});

test('exposed creeper and ranged skeleton trigger non-destructive bounded escape', async () => {
  for (const args of [{ name: 'creeper' }, { name: 'skeleton', position: new Vec3(8, 0, 0) }]) {
    const f = fixture(args);
    await f.controller.tick();
    assert.deepEqual(f.calls.acquired, ['escaping immediate danger']);
    const movements = f.bot.pathfinder.movements;
    assert.equal(movements.canDig, false);
    assert.equal(movements.allow1by1towers, false);
    assert.deepEqual(movements.scafoldingBlocks, []);
    assert.equal(movements.allowSprinting, true);
    assert.equal(movements.allowParkour, false);
    assert.equal(movements.maxDropDown, 3);
    assert.equal(movements.infiniteLiquidDropdownDistance, false);
    f.advance(6001);
    await f.controller.tick();
    assert.deepEqual(movements, f.initial);
    assert.equal(movements.scafoldingBlocks, f.initial.scafoldingBlocks);
    assert.equal(f.calls.released, 1);
    assert.equal(f.calls.goals.at(-1), null);
    f.controller.close();
  }
});

test('ordinary drowned at range do not interrupt work or trigger recurring escapes', async () => {
  for (const heldItem of [null, { name: 'nautilus_shell' }]) {
    const f = fixture({ name: 'drowned', position: new Vec3(5, -1, 0) });
    f.bot.entities[2].heldItem = heldItem;
    for (let cycle = 0; cycle < 3; cycle++) {
      await f.controller.tick();
      f.advance(6500);
    }
    assert.deepEqual(f.calls.acquired, []);
    assert.deepEqual(f.calls.goals, []);
    assert.deepEqual(f.calls.errors, []);
    f.controller.close();
  }
});

test('trident-bearing drowned at range trigger escape, but not through a wall', async () => {
  for (const barriers of [[], [wall]]) {
    const f = fixture({ name: 'drowned', position: new Vec3(5, -1, 0), barriers });
    f.bot.entities[2].heldItem = { name: 'trident' };
    await f.controller.tick();
    assert.deepEqual(f.calls.acquired, barriers.length ? [] : ['escaping immediate danger']);
    assert.deepEqual(f.calls.errors, []);
    f.controller.close();
  }
});

test('ordinary drowned still trigger melee defense and low-health escape', async () => {
  for (const health of [20, 8]) {
    const f = fixture({ name: 'drowned' });
    f.bot.health = health;
    await f.controller.tick();
    assert.deepEqual(f.calls.acquired, [health === 20 ? 'defending against nearby enemy' : 'escaping immediate danger']);
    assert.deepEqual(f.calls.attacks, health === 20 ? [2] : []);
    f.controller.close();
  }
});

test('escape ends immediately when a wall provides shelter, restoring prior movement', async () => {
  const barriers = [];
  const f = fixture({ name: 'creeper', barriers });
  await f.controller.tick();
  barriers.push(wall);
  await f.controller.tick();
  assert.equal(f.calls.released, 1);
  assert.deepEqual(f.bot.pathfinder.movements, f.initial);
  f.controller.close();
});

test('death, shutdown and navigation error restore the original movement profile', async () => {
  for (const outcome of ['death', 'shutdown', 'error']) {
    const f = fixture({ name: 'creeper' });
    if (outcome === 'error') {
      const original = f.bot.pathfinder.setGoal;
      f.bot.pathfinder.setGoal = goal => {
        if (goal !== null) throw new Error('No escape path');
        original(goal);
      };
    }
    await f.controller.tick();
    if (outcome === 'death') { f.bot.health = 0; await f.controller.tick(); }
    if (outcome === 'shutdown') f.controller.close();
    assert.deepEqual(f.bot.pathfinder.movements, f.initial);
    assert.equal(f.calls.released, 1);
    assert.equal(f.calls.errors.length, outcome === 'error' ? 1 : 0);
    f.controller.close();
  }
});

test('shutdown during ownership acquisition cannot start a late escape', async () => {
  const f = fixture({ name: 'creeper' });
  let resume;
  const controller = createReflexController(f.bot, { ...f.options, acquire: () => new Promise(resolve => { resume = resolve; }) });
  const pending = controller.tick();
  controller.close();
  resume();
  await pending;
  assert.deepEqual(f.bot.pathfinder.movements, f.initial);
  assert.equal(f.calls.goals.filter(goal => goal !== null).length, 0);
});
