import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { installLadderWaypoints } from '../ladder-navigation.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('prismarine-registry')('1.21.4');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Physics, PlayerState } = require('prismarine-physics');

function followLadder(repair = () => () => {}, turns = 0, descending = false) {
  const rotate = (x, z) => {
    let dx = x - 3.5;
    let dz = z + 0.5;
    for (let turn = 0; turn < turns; turn++) [dx, dz] = [-dz, dx];
    return { x: dx + 3.5, z: dz - 0.5 };
  };
  const point = (x, y, z) => { const p = rotate(x, z); return new Vec3(p.x, y, p.z); };
  const world = new World().sync;
  for (let x = -1; x <= 0; x++) for (let z = -1; z <= 0; z++) {
    world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  const put = (x, y, z, name) => world.setBlockStateId(point(x + 0.5, y, z + 0.5).floored(), registry.blocksByName[name].minStateId);
  // A two-column shaft and its north gallery, matching the observed edge entry.
  for (let x = 0; x <= 5; x++) for (let z = -5; z <= 1; z++) for (let y = 0; y <= 8; y++) {
    put(x, y, z, y === 0 || (y < 7 && !(x === 3 && z >= -3 && z <= -1) && !(x === 4 && z === -1)) ? 'stone' : 'air');
  }
  const ladder = Block.fromProperties(registry.blocksByName.ladder.id, { facing: ['east', 'south', 'west', 'north'][turns], waterlogged: false }, 0);
  for (let y = 1; y <= 6; y++) world.setBlockStateId(point(3.5, y, -0.5).floored(), ladder.stateId);
  const controls = () => Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(name => [name, false]));
  const bot = Object.assign(new EventEmitter(), {
    registry, world, blockAt: position => world.getBlock(position), entities: {},
    entity: { id: 1, position: descending ? point(2.5, 7, -0.5) : point(3.300000011920929, 1, -1.525), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    inventory: { items: () => [], slots: [] }, health: 20, food: 20,
    game: { minY: -64, dimension: 'overworld', gameMode: 'survival' },
    controlState: controls(), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, version: '1.21.4',
  });
  bot.physics = Physics(registry, world);
  bot.setControlState = (name, value) => { bot.controlState[name] = value; };
  bot.clearControlStates = () => { bot.controlState = controls(); };
  bot.look = (yaw, pitch) => { Object.assign(bot.entity, { yaw, pitch }); };
  pathfinder(bot);
  const movements = new Movements(bot);
  Object.assign(movements, { canDig: false, allowParkour: false, allowSprinting: false, allow1by1towers: false, scafoldingBlocks: [] });
  bot.pathfinder.setMovements(movements);
  const paths = [];
  const remove = repair(bot);
  bot.on('path_update', result => paths.push(result.path.map(node => ({ x: node.x, y: node.y, z: node.z }))));
  const destination = descending ? point(3.5, 1, -1.5).floored() : point(2.5, 7, -0.5).floored();
  const goal = new goals.GoalNear(destination.x, destination.y, destination.z, 0);
  bot.pathfinder.setGoal(goal);
  for (let tick = 0; tick < 240 && bot.pathfinder.goal; tick++) {
    bot.emit('physicsTick');
    bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), world).apply(bot);
  }
  remove();
  return { bot, goal, paths };
}

test('upstream thin-panel waypoints stall real ladder entry', () => {
  const result = followLadder();
  assert.notEqual(result.bot.pathfinder.goal, null);
  assert.equal(result.bot.entity.position.y, 1);
  assert.ok(result.paths[0].some(node => node.x === 3.296875));
});

test('real path follower enters, climbs, exits and descends ladders in every orientation', () => {
  for (let turns = 0; turns < 4; turns++) for (const descending of [false, true]) {
    const result = followLadder(installLadderWaypoints, turns, descending);
    assert.equal(result.bot.pathfinder.goal, null, JSON.stringify({ turns, descending, position: result.bot.entity.position, paths: result.paths }));
    assert.ok(result.goal.isEnd(result.bot.entity.position.floored()));
    assert.equal(result.bot.listenerCount('path_update'), 1, 'repair listener removed without affecting observer');
  }
});
