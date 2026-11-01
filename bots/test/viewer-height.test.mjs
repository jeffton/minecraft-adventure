import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchViewerHeightClient, patchViewerHeightWorker } from '../viewer-height.mjs';

const root = process.env.MINDCRAFT_ROOT || '/opt/minecraft-mindcraft';
const require = createRequire(`${root}/package.json`);
const viewer = `${root}/node_modules/prismarine-viewer`;
const { Vec3 } = require('vec3');
const Chunk = require('prismarine-chunk')('1.21.4');
const registry = require('minecraft-data')('1.21.4');
const workerSource = fs.readFileSync(`${viewer}/public/worker.js`, 'utf8');
const clientSource = fs.readFileSync(`${viewer}/public/index.js`, 'utf8');
const blockStates = JSON.parse(fs.readFileSync(`${viewer}/public/blocksStates/1.21.4.json`, 'utf8'));

function worker(source) {
  const messages = [];
  let render;
  const context = vm.createContext({
    console, self: { AbortController, AbortSignal }, performance,
    setInterval(callback) { render = callback; },
    postMessage(message) { messages.push(message); }
  });
  try {
    vm.runInContext(source, context);
  } catch (error) {
    throw new Error(`Worker initialization failed: ${error.message}`);
  }
  // Structured-cloned browser messages belong to the worker's realm. The
  // mesher uses instanceof Array, so handing it host-realm arrays is incorrect.
  const send = data => {
    context.messageJson = JSON.stringify(data);
    vm.runInContext('self.onmessage({ data: JSON.parse(messageJson) })', context);
  };
  send({ type: 'version', version: '1.21.4' });
  send({ type: 'blockStates', json: blockStates });
  return { send, messages, render: () => render() };
}

function geometry(engine, y, stateId, localY = 8) {
  const chunk = new Chunk();
  chunk.setBlockStateId(new Vec3(8, y + localY, 8), stateId);
  engine.send({ type: 'chunk', x: 0, z: 0, chunk: chunk.toJson() });
  engine.send({ type: 'dirty', x: 0, y, z: 0, value: true });
  engine.render();
  return engine.messages.findLast(message => message.type === 'geometry' && message.key === `0,${y},0`);
}

test('real bundled worker emits full solid meshes at four heights and underground water', () => {
  const engine = worker(patchViewerHeightWorker(workerSource));
  for (const y of [-48, 0, 256, 304]) {
    const message = geometry(engine, y, registry.blocksByName.stone.minStateId);
    assert.ok(message, `No geometry emitted at section ${y}`);
    assert.equal(message.geometry.positions.length / 3, 24, `Missing stone faces at ${y}`);
    assert.equal(message.geometry.indices.length, 36);
    assert.ok(engine.messages.some(item => item.type === 'sectionFinished' && item.key === `0,${y},0`));
  }
  for (const [y, localY] of [[-64, 0], [304, 15]]) {
    const message = geometry(engine, y, registry.blocksByName.stone.minStateId, localY);
    assert.equal(message.geometry.positions.length / 3, 24, `Missing boundary faces at ${y + localY}`);
    assert.equal(message.geometry.indices.length, 36);
  }
  const below = geometry(engine, -48, registry.blocksByName.water.minStateId);
  const above = geometry(engine, 0, registry.blocksByName.water.minStateId);
  assert.ok(below.geometry.positions.length > 0);
  assert.equal(below.geometry.positions.length, above.geometry.positions.length);
  assert.equal(below.geometry.indices.length, above.geometry.indices.length);
});

test('actual patched client schedules and removes all 24 vertical sections', () => {
  const patched = patchViewerHeightClient(clientSource);
  new vm.Script(patched);
  const addStart = patched.indexOf('addColumn(t,e,i){this.loadedChunks');
  const removeStart = patched.indexOf('removeColumn(t,e){delete this.loadedChunks', addStart);
  const end = patched.indexOf('setBlockStateId(', removeStart);
  assert.ok(addStart > 0 && removeStart > addStart && end > removeStart);
  const context = { r: Vec3, l() {} };
  vm.runInNewContext(`this.Renderer=class {${patched.slice(addStart, end)}}`, context);
  const renderer = new context.Renderer();
  const scheduled = [];
  const removed = [];
  renderer.loadedChunks = {};
  renderer.workers = [{ postMessage() {} }];
  renderer.sectionMeshs = {};
  renderer.scene = { remove(mesh) { removed.push(mesh); } };
  renderer.setSectionDirty = (pos, value = true) => scheduled.push([pos.x, pos.y, pos.z, value]);
  renderer.addColumn(0, 0, '{}');
  const ownHeights = scheduled.filter(([x, , z]) => x === 0 && z === 0).map(([, y]) => y);
  assert.deepEqual(ownHeights, Array.from({ length: 24 }, (_, i) => -64 + 16 * i));
  for (const y of ownHeights) renderer.sectionMeshs[`0,${y},0`] = { y };
  scheduled.length = 0;
  renderer.removeColumn(0, 0);
  assert.equal(scheduled.length, 24);
  assert.ok(scheduled.every(([, , , value]) => value === false));
  assert.equal(removed.length, 24);
  assert.equal(Object.keys(renderer.sectionMeshs).length, 0);
  assert.equal(renderer.loadedChunks['0,0'], undefined);
});

test('serialized patch functions are self-contained and reject changed upstream anchors', () => {
  const context = {
    clientSource: 'postMessage({type:"chunk",x:t,z:e,chunk:i});for(let i=0;i<256;i+=16);postMessage({type:"unloadChunk",x:t,z:e});for(let i=0;i<256;i+=16)',
    workerSource: 'i.sections[Math.floor(a/16)];l.sections[Math.floor(n/16)];if(g.position.y<0)continue;if(n.position.y<0)continue'
  };
  vm.runInNewContext(`this.client=(${patchViewerHeightClient.toString()})(clientSource);this.worker=(${patchViewerHeightWorker.toString()})(workerSource)`, context);
  assert.equal(context.client, patchViewerHeightClient(context.clientSource));
  assert.equal(context.worker, patchViewerHeightWorker(context.workerSource));
  assert.throws(() => patchViewerHeightClient('changed'), /integration changed/);
  assert.throws(() => patchViewerHeightWorker('changed'), /integration changed/);
});
