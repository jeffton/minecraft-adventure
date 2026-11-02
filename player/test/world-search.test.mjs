import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { findLoadedBlocks } from '../world-search.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('minecraft-data')('1.21.4');
const Chunk = require('prismarine-chunk')('1.21.4');
const { Vec3 } = require('vec3');

function fixture() {
  const first = new Chunk({ minY: -64, worldHeight: 384 });
  const remote = new Chunk({ minY: -64, worldHeight: 384 });
  for (let index = 0; index < 80; index++) first.setBlockStateId(new Vec3(index % 16, 64, Math.floor(index / 16)), registry.blocksByName.furnace.minStateId);
  remote.setBlockStateId(new Vec3(1, 70, 2), registry.blocksByName.furnace.minStateId);
  const loaded = new Map([['0,0', first], ['20,0', remote]]);
  return {
    loaded,
    bot: {
      registry, entity: { position: new Vec3(0, 64, 0) },
      world: {
        getColumns: () => [...loaded].map(([key, column]) => ({ chunkX: Number(key.split(',')[0]), chunkZ: 0, column })),
        getColumn: (x, z) => loaded.get(`${x},${z}`),
      },
    },
  };
}

test('loaded-only search has no radius/count quota and honors explicit caller filters', async () => {
  const { bot } = fixture();
  const all = await findLoadedBlocks(bot, Vec3, ['furnace']);
  assert.equal(all.length, 81);
  assert.deepEqual(all.at(-1), new Vec3(321, 70, 2));
  assert.equal((await findLoadedBlocks(bot, Vec3, ['furnace'], { count: 70 })).length, 70);
  assert.equal((await findLoadedBlocks(bot, Vec3, ['furnace'], { radius: 30_000_000 })).length, 81);
  assert.deepEqual(await findLoadedBlocks(bot, Vec3, ['furnace'], { radius: 0 }), [new Vec3(0, 64, 0)]);
});

test('nearest-count queries retain only requested candidates and impossible replies fail before accumulation', async () => {
  const { bot } = fixture();
  let packed = 0;
  const nearest = await findLoadedBlocks(bot, Vec3, ['furnace'], { count: 1, pack: position => { packed++; return position; } });
  assert.deepEqual(nearest, [new Vec3(0, 64, 0)]);
  assert.equal(packed, 1, 'Noncompetitive matches are not retained or packed');
  packed = 0;
  await assert.rejects(findLoadedBlocks(bot, Vec3, ['furnace'], { pack: position => { packed++; return { position, detail: 'x'.repeat(20_000) }; } }), /1 MiB RPC frame/);
  assert.ok(packed < 81, 'Stop at actual wire capacity, not after materializing the entire domain');
});

test('search yields and does not use a column unloaded during the query', async () => {
  const { bot, loaded } = fixture();
  setImmediate(() => loaded.delete('20,0'));
  const found = await findLoadedBlocks(bot, Vec3, ['furnace']);
  assert.equal(found.length, 80);
  let checks = 0;
  await assert.rejects(findLoadedBlocks(bot, Vec3, ['furnace'], {}, () => {
    if (++checks > 2) throw new Error('cancelled by real action owner');
  }), /cancelled/);
});
