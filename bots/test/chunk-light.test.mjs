import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchChunkLightSource, patchChunkLightWorker } from '../chunk-light.mjs';

const root = process.env.MINDCRAFT_ROOT || '/opt/minecraft-mindcraft';
const require = createRequire(`${root}/package.json`);
const filename = require.resolve('prismarine-chunk/src/pc/1.18/ChunkColumn.js');
const source = readFileSync(filename, 'utf8');
const worker = readFileSync(`${root}/node_modules/prismarine-viewer/public/worker.js`, 'utf8');
const module = { exports: {} };
vm.runInNewContext(patchChunkLightSource(source), {
  module, require: createRequire(filename), Buffer, Int8Array, Uint8Array
}, { filename });
const registry = require('minecraft-data')('1.21.4');
const Chunk = module.exports(require('prismarine-block')(registry), registry);
const mask = indices => [[0, indices.reduce((bits, index) => bits | (1 << index), 0)]];
const sectionIndex = y => Math.floor((y + 64) / 16) + 1;

// Build wire bytes independently of prismarine-chunk's dumpLight/BitArray code.
function wireSection(entries) {
  const bytes = Buffer.alloc(2048);
  for (const { x, y, z, value } of entries) {
    const index = ((y & 15) << 8) | (z << 4) | x;
    bytes[index >> 1] |= value << ((index & 1) * 4);
  }
  return [...bytes];
}

function receive(chunk, { sky = [], block = [], skyMask = [], blockMask = [], emptySky = [], emptyBlock = [] }) {
  chunk.loadParsedLight(sky, block, mask(skyMask), mask(blockMask), mask(emptySky), mask(emptyBlock));
}

function asymmetricRow(y, z) {
  return Array.from({ length: 16 }, (_, x) => ({ x, y, z, value: (x * 7 + 3) & 15 }));
}

test('raw protocol nibbles preserve every X, both channels and negative/edge Y', () => {
  const chunk = new Chunk();
  for (const y of [-80, -65, -64, -49, -48, -1, 0, 15, 16, 70, 76, 82, 319, 320, 335]) {
    const entries = asymmetricRow(y, 6);
    const bytes = wireSection(entries);
    receive(chunk, { block: [bytes], sky: [bytes], blockMask: [sectionIndex(y)], skyMask: [sectionIndex(y)] });
    for (const pos of entries) {
      assert.equal(chunk.getBlockLight(pos), pos.value, `block ${JSON.stringify(pos)}`);
      assert.equal(chunk.getSkyLight(pos), pos.value, `sky ${JSON.stringify(pos)}`);
    }
  }
});

test('multiple section masks consume payloads in ascending order, partial and empty updates preserve unrelated data', () => {
  const chunk = new Chunk();
  const low = { x: 4, y: -64, z: 6, value: 14 };
  const high = { x: 1, y: 82, z: 7, value: 13 };
  receive(chunk, {
    block: [wireSection([low]), wireSection([high])],
    blockMask: [sectionIndex(low.y), sectionIndex(high.y)],
    sky: [wireSection([{ ...low, value: 15 }])], skyMask: [sectionIndex(low.y)]
  });
  assert.equal(chunk.getBlockLight(low), 14);
  assert.equal(chunk.getBlockLight(high), 13);
  const original = chunk.dumpLight();
  receive(chunk, { emptySky: [sectionIndex(low.y)], emptyBlock: [sectionIndex(high.y)] });
  assert.equal(chunk.getBlockLight(low), 14);
  assert.equal(chunk.getSkyLight(low), 0);
  assert.equal(chunk.getBlockLight(high), 0);
  assert.equal(chunk.blockLightMask.get(sectionIndex(low.y)), 1);
  assert.equal(chunk.blockLightMask.get(sectionIndex(high.y)), 0);
  assert.equal(chunk.emptyBlockLightMask.get(sectionIndex(high.y)), 1);
  assert.deepEqual(original.blockLight[0], Uint8Array.from(wireSection([low])));
  receive(chunk, {});
  assert.equal(chunk.getBlockLight(low), 14);
  receive(chunk, { block: [wireSection([high])], blockMask: [sectionIndex(high.y)] });
  assert.equal(chunk.getBlockLight(high), 13);
  assert.equal(chunk.emptyBlockLightMask.get(sectionIndex(high.y)), 0);
});

test('dumpLight emits independent protocol bytes and JSON retains distinct empty masks', () => {
  const chunk = new Chunk();
  const entries = asymmetricRow(76, 6);
  for (const pos of entries) {
    chunk.setBlockLight(pos, pos.value);
    chunk.setSkyLight(pos, pos.value);
  }
  receive(chunk, { emptySky: [2], emptyBlock: [3] });
  const light = chunk.dumpLight();
  assert.deepEqual([...light.blockLight[0]], wireSection(entries));
  assert.deepEqual([...light.skyLight[0]], wireSection(entries));
  const restored = Chunk.fromJson(chunk.toJson());
  assert.deepEqual(restored.emptySkyLightMask.toLongArray(), chunk.emptySkyLightMask.toLongArray());
  assert.deepEqual(restored.emptyBlockLightMask.toLongArray(), chunk.emptyBlockLightMask.toLongArray());
  const receiver = new Chunk();
  receiver.loadParsedLight(light.skyLight, light.blockLight, light.skyLightMask,
    light.blockLightMask, light.emptySkyLightMask, light.emptyBlockLightMask);
  for (const pos of entries) assert.equal(receiver.getBlockLight(pos), pos.value);
});

test('worker patch corrects both bundled decoders with explicit LE words', () => {
  const patched = patchChunkLightWorker(worker);
  const decoder = 'for(let w=0;w<u.data.length;w++)u.data[w]=e.readUInt32LE(w*4)';
  assert.equal(patched.split(decoder).length - 1, 2);
  assert.ok(!patched.includes('u.readBuffer(l.fromBuffer(e))'));
  new vm.Script(patched);
  const decode = new Function('e', 'u', decoder);
  const entries = asymmetricRow(-1, 9);
  const data = new Uint32Array(512);
  decode(Buffer.from(wireSection(entries)), { data });
  for (const pos of entries) {
    const index = ((pos.y & 15) << 8) | (pos.z << 4) | pos.x;
    assert.equal((data[index >> 3] >>> ((index & 7) * 4)) & 15, pos.value);
  }
  assert.ok(patched.includes('emptySkyLightMask:i.fromLongArray(t.emptySkyLightMask,1)'));
  assert.ok(patched.includes('emptyBlockLightMask:i.fromLongArray(t.emptyBlockLightMask,1)'));
});

test('source and worker patchers reject changed or already patched integration points', () => {
  assert.throws(() => patchChunkLightSource(''), /integration point changed/);
  assert.throws(() => patchChunkLightSource(patchChunkLightSource(source)), /decoder integration point changed/);
  assert.throws(() => patchChunkLightWorker(''), /worker decoder integration point changed/);
  assert.throws(() => patchChunkLightWorker(patchChunkLightWorker(worker)), /worker decoder integration point changed/);
  const missingEncoder = source.replace('skyLight.push(Uint8Array.from(smartBuffer.toBuffer()))', 'changed()');
  assert.throws(() => patchChunkLightSource(missingEncoder), /skyLight encoder integration point changed/);
  const missingMask = worker.replace('emptySkyLightMask:i.fromLongArray(t.emptyBlockLightMask,1)', 'changed');
  assert.throws(() => patchChunkLightWorker(missingMask), /worker sky empty mask integration point changed/);
});
