import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { patchPathfinderGoals } from '../compat-loader.mjs';
import { gatherResource } from '../gather.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.4');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const { Movements, goals } = require('mineflayer-pathfinder');
const AStar = require('mineflayer-pathfinder/lib/astar');
const Move = require('mineflayer-pathfinder/lib/move');
const source = readFileSync(require.resolve('mineflayer-pathfinder/lib/goals.js'), 'utf8');

function originalGoals() {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    createRequire(require.resolve('mineflayer-pathfinder/lib/goals.js')), module, module.exports);
  return module.exports;
}

function fixture() {
  const world = new World().sync;
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  const put = (x, y, z, name) => world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].minStateId);
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) put(x, 0, z, 'stone');
  }
  const bot = {
    registry, world, blockAt: p => world.getBlock(p),
    entity: { position: new Vec3(0, 1, 0), effects: {} }, entities: {},
    inventory: { items: () => [] }, game: { minY: -64, gameMode: 'survival', dimension: 'overworld' },
    health: 20, pathfinder: { bestHarvestTool: () => null }
  };
  return { world, put, bot };
}

test('installed loader fixes overhead harvesting without relaxing exact reach or occlusion', () => {
  const { world, put, bot } = fixture();
  put(3, 5, 0, 'acacia_log');
  const target = new Vec3(3, 5, 0);
  const policy = new Movements(bot);
  Object.assign(policy, { canDig: false, allowParkour: false, allow1by1towers: false, maxDropDown: 2 });
  function search(Goal) {
    const astar = new AStar(new Move(0, 1, 0, 0, 0), policy,
      new Goal(target, world, { reach: 4.2 }), 600, 30, -1);
    let result;
    do { result = astar.compute(); } while (result.status === 'partial');
    return result;
  }
  assert.equal(search(originalGoals().GoalLookAtBlock).status, 'noPath');
  assert.equal(search(goals.GoalLookAtBlock).status, 'success');
  const goal = new goals.GoalLookAtBlock(target, world, { reach: 4.2 });
  assert.equal(goal.isEnd(new Vec3(3, 1, 0)), true);
  assert.equal(goal.isEnd(new Vec3(-5, 1, 0)), false, 'broad phase cannot grant out-of-range reach');
  put(3, 4, 0, 'stone');
  assert.equal(goal.isEnd(new Vec3(3, 1, 0)), false, 'existing face rays still reject occlusion');
  assert.throws(() => patchPathfinderGoals(source.replace('this.entityHeight, 0))', '99, 0))')), /integration point changed/);
  assert.throws(() => patchPathfinderGoals(source + source), /integration point changed/);
});

test('gather filters buried, protected and unknown faces before the 32-block cap', async () => {
  const { world, put, bot } = fixture();
  const buried = [];
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) buried.push(world.getBlock(new Vec3(x, -3, z)));
  }
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      for (let y = -4; y <= -2; y++) put(x, y, z, 'stone');
    }
  }
  put(20, 1, 20, 'stone');
  put(31, 1, 31, 'stone');
  // The edge target has stone on all known sides; missing columns are not air.
  for (const [x, y, z] of [[30, 1, 31], [31, 0, 31], [31, 2, 31], [31, 1, 30]]) put(x, y, z, 'stone');
  const exposed = new Vec3(3, 0, 0);
  let selected;
  bot.findBlocks = options => {
    assert.equal(options.maxDistance, 64);
    assert.equal(options.count, 32);
    const positions = [...buried.map(b => b.position), new Vec3(20, 1, 20), new Vec3(31, 1, 31), exposed];
    return positions.map(p => world.getBlock(p)).filter(options.useExtraInfo).slice(0, options.count).map(b => b.position);
  };
  bot.pathfinder = {
    setMovements: () => {},
    getPathFromTo: function* (movement, start, goal, options) {
      assert.deepEqual(options, { timeout: 600, tickTimeout: 30 });
      selected = goal.pos;
      yield { result: { status: 'success' } };
    },
    goto: async () => { throw new Error('selection observed; no gameplay performed'); }
  };
  await assert.rejects(gatherResource({ bot }, ['stone'],
    { x: 20, y: 1, z: 20, dimension: 'overworld' }, {}), /selection observed/);
  assert.deepEqual(selected, exposed);
});
