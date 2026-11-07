import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMinecraftRpc } from '../rpc.mjs';
import { observationFeedback } from '../feedback.mjs';
import { planningObservation } from '../mission.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('minecraft-data')('1.21.4');
const Chunk = require('prismarine-chunk')('1.21.4');
const { Vec3 } = require('vec3');

function fixture() {
  const column = new Chunk();
  const origin = new Vec3(4, 64, 4);
  const bot = {
    entity: { id: 1, position: origin }, entities: {}, registry,
    inventory: { items: () => [] }, game: { dimension: 'overworld' },
    blockAt(p) {
      const block = column.getBlock(p);
      block.position = p;
      return block;
    },
  };
  return { column, origin, rpc: createMinecraftRpc(bot, { Vec3, goals: {} }), bot };
}

test('real received chunk light survives block queries and model projection even when air sensors are omitted', async () => {
  const { column, origin, rpc } = fixture();
  column.setBlockLight(origin, 0);
  column.setSkyLight(origin, 15);
  const outside = new Vec3(5, 64, 4);
  column.setBlockLight(outside, 9);
  column.setSkyLight(outside, 3);
  const measured = await rpc.call('blockAt', [outside]);
  assert.equal(measured.name, 'air');
  assert.equal(measured.blockLight, 9);
  assert.equal(measured.skyLight, 3);
  const payload = planningObservation(observationFeedback(rpc.observe()));
  assert.deepEqual(payload.light, { position: { x: 4, y: 64, z: 4 }, blockLight: 0, skyLight: 15 });
  assert.equal(payload.blocks.some(block => block.name === 'air'), false);
  // A received lighting change, not a placed-source count, changes the observation.
  column.setBlockLight(origin, 12);
  assert.equal(planningObservation(observationFeedback(rpc.observe())).light.blockLight, 12);
  assert.equal((await rpc.call('blockAt', [outside])).blockLight, 9);
});

test('absent light data is not invented as zero or inferred from daytime', async () => {
  const { bot, rpc } = fixture();
  bot.blockAt = p => ({ name: 'air', type: 0, position: p });
  bot.time = { timeOfDay: 6000, isDay: true };
  const encoded = JSON.parse(JSON.stringify(rpc.observe()));
  assert.deepEqual(encoded.light, { position: { x: 4, y: 64, z: 4 } });
  assert.equal(Object.hasOwn(encoded.blocks[0], 'blockLight'), false);
  assert.equal(Object.hasOwn(encoded.blocks[0], 'skyLight'), false);
});
