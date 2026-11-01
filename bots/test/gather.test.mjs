import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gatherResource } from '../gather.mjs';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('minecraft-data')('1.21.4');
const { Vec3 } = require('vec3');

test('gathering skips the protected home and an unreachable nearest tree, then digs the selected reachable block', async () => {
  const positions = [1, 10, 14].map(x => new Vec3(x, 64, 0));
  const blocks = positions.map(position => ({ name: 'oak_log', position, canHarvest: () => true }));
  const paths = [], dug = [], pickups = [], waits = [];
  let policy;
  const bot = {
    registry, game: { gameMode: 'survival', dimension: 'overworld' }, health: 20,
    world: {}, entity: { position: new Vec3(0, 64, 0) },
    findBlocks: () => positions,
    blockAt: p => blocks.find(block => block.position.x === p.x),
    pathfinder: {
      setMovements: value => { policy = value; },
      getPathFromTo: function* (movement, start, goal) { paths.push(goal.pos.x); yield { result: { status: goal.pos.x === 10 ? 'noPath' : 'success' } }; },
      goto: async goal => { bot.entity.position = goal.pos.offset(-1, 0, 0); }
    }, tool: { equipForBlock: async () => {} }, lookAt: async () => {},
    dig: async block => { dug.push(block.position.x); }, waitForTicks: async ticks => { waits.push(ticks); }
  };
  await gatherResource({ bot }, ['oak_log'], { x: 0, y: 64, z: 0, dimension: 'overworld' }, {
    pickupNearbyItems: async () => pickups.push(true)
  });
  assert.deepEqual(paths, [10, 14]);
  assert.deepEqual(dug, [14]);
  assert.equal(pickups.length, 1);
  assert.deepEqual(waits, [12, 4], 'pickup is observed after the vanilla ten-tick delay');
  assert.equal(policy.maxDropDown, 2);
  assert.equal(policy.allowParkour, false);
  assert.equal(policy.dontCreateFlow, true);
});
