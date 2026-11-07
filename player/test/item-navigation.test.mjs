import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { itemNavigationGoal } from '../item-navigation.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('prismarine-registry')('1.21.4');
const Block = require('prismarine-block')(registry);
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Physics, PlayerState } = require('prismarine-physics');

function waterFixture() {
  const world = {
    getBlock(position) {
      const name = position.y < 60 ? 'stone' : position.y < 63 ? 'water' : 'air';
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      block.position = position;
      return block;
    },
  };
  const item = { id: 2, name: 'item', position: new Vec3(0.5, 60.25, 0.5) };
  const controls = () => Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(name => [name, false]));
  const bot = Object.assign(new EventEmitter(), {
    registry, world, blockAt: position => world.getBlock(position), entities: { 2: item },
    entity: {
      id: 1, position: new Vec3(4.5, 62, 0.5), velocity: new Vec3(0, 0, 0),
      onGround: false, isInWater: true, yaw: 0, pitch: 0, effects: {}, attributes: {},
    },
    game: { minY: -64, dimension: 'overworld', gameMode: 'survival' },
    inventory: { slots: [], items: () => [] },
    version: '1.21.4', jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    controlState: controls(),
  });
  bot.setControlState = (name, value) => { bot.controlState[name] = value; };
  bot.clearControlStates = () => { bot.controlState = controls(); };
  bot.look = (yaw, pitch) => { Object.assign(bot.entity, { yaw, pitch }); };
  bot.physics = Physics(registry, world);
  pathfinder(bot);
  const movements = new Movements(bot);
  Object.assign(movements, { canDig: false, allow1by1towers: false, scafoldingBlocks: [], allowParkour: false, allowSprinting: false });
  bot.pathfinder.setMovements(movements);
  return { bot, item };
}

function pursue(follow) {
  const { bot, item } = waterFixture();
  const goal = follow ? itemNavigationGoal(bot, goals, item) : new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5);
  bot.pathfinder.setGoal(goal);
  let collected = false;
  const turns = [];
  for (let tick = 0; tick < 240; tick++) {
    // Deterministic server-item updates: a mined drop rises two blocks in water.
    item.position.y = Math.min(62.4, 60.25 + tick * 0.05);
    item.position.x = Math.max(-3.5, 0.5 - tick * 0.05);
    bot.emit('physicsTick');
    bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), bot.world).apply(bot);
    turns.push(bot.entity.yaw);
    if (!collected && bot.entity.position.distanceTo(item.position) < 0.8) {
      collected = true;
      delete bot.entities[item.id];
    }
    if (!bot.pathfinder.goal) break;
  }
  return { bot, goal, collected, turns };
}

test('real Pathfinder and Minecraft water physics collect a drifting drop instead of its stale spawn position', () => {
  const broken = pursue(false);
  assert.equal(broken.collected, false, 'snapshot goal leaves the floating item uncollected');
  const fixed = pursue(true);
  assert.equal(fixed.collected, true, `moving goal collects item from ${fixed.bot.entity.position}`);
  assert.equal(fixed.bot.pathfinder.goal, null, 'navigation releases controls after pickup');
  assert.equal(fixed.bot.controlState.forward, false);
  assert.equal(fixed.bot.controlState.jump, false);
});

test('drop goal follows received horizontal and vertical motion, then ends when the item disappears', () => {
  const { bot, item } = waterFixture();
  const goal = itemNavigationGoal(bot, goals, item);
  item.position = new Vec3(-0.8, 62.4, -2.46);
  assert.equal(goal.hasChanged(), true);
  assert.equal(goal.isEnd(new Vec3(-1, 62, -3)), true);
  assert.equal(goal.isEnd(new Vec3(0, 60, 0)), false);
  delete bot.entities[item.id];
  assert.equal(goal.hasChanged(), true);
  assert.equal(goal.isEnd(new Vec3(4, 62, 0)), true, 'removal ends pursuit without claiming inventory gain');
});
