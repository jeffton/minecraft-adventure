import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { patchViewerRevisionClient, patchViewerRevisionWorker } from '../viewer-revisions.mjs';
import { patchViewerHeightClient, patchViewerHeightWorker } from '../viewer-height.mjs';

const require = createRequire(`${process.env.MINDCRAFT_ROOT || '/opt/minecraft-mindcraft'}/package.json`);
const viewer = `${process.env.MINDCRAFT_ROOT || '/opt/minecraft-mindcraft'}/node_modules/prismarine-viewer`;
const clientSource = fs.readFileSync(`${viewer}/public/index.js`, 'utf8');
const workerSource = fs.readFileSync(`${viewer}/public/worker.js`, 'utf8');
const { Vec3 } = require('vec3');

function client(source) {
  const start = source.indexOf('WorldRenderer:class') + 'WorldRenderer:'.length;
  const end = source.indexOf('}}}},484:', start) + 2;
  assert.ok(start > 0 && end > start);
  const context = {
    n: require('three'), r: Vec3, s: EventEmitter, l() {},
    Worker: class {
      constructor() { this.messages = []; }
      postMessage(message) { this.messages.push(message); }
    }
  };
  vm.runInNewContext(`this.Renderer=${source.slice(start, end)}`, context);
  const scene = new context.n.Scene();
  const renderer = new context.Renderer(scene, 1);
  return renderer;
}

function worker(source) {
  const messages = [];
  let render;
  const context = vm.createContext({
    console, self: { AbortController, AbortSignal }, performance,
    setInterval(callback) { render = callback; },
    postMessage(message) { messages.push(message); }
  });
  try { vm.runInContext(source, context); }
  catch (error) { throw new Error(`Worker initialization failed: ${error.message}`); }
  const send = message => {
    context.message = JSON.stringify(message);
    vm.runInContext('self.onmessage({data:JSON.parse(message)})', context);
  };
  return { send, messages, render: () => render() };
}

test('actual client and worker reject old completions, coalesce revisions, and isolate resets', () => {
  const renderer = client(patchViewerRevisionClient(patchViewerHeightClient(clientSource)));
  const engine = worker(patchViewerRevisionWorker(patchViewerHeightWorker(workerSource)));
  engine.send({ type: 'version', version: '1.21.4' });
  engine.send({ type: 'blockStates', json: JSON.parse(fs.readFileSync(`${viewer}/public/blocksStates/1.21.4.json`, 'utf8')) });
  const Chunk = require('prismarine-chunk')('1.21.4');
  const chunk = new Chunk();
  chunk.setBlockStateId(new Vec3(8, 8, 8), 1);
  engine.send({ type: 'chunk', x: 0, z: 0, chunk: chunk.toJson() });
  renderer.loadedChunks['0,0'] = true;
  const pos = new Vec3(0, 0, 0);
  const dirty = value => {
    renderer.setSectionDirty(pos, value);
    const message = renderer.workers[0].messages.at(-1);
    engine.send(message);
    return message.revision;
  };
  const flush = () => {
    const messages = engine.messages.splice(0);
    for (const data of messages) renderer.workers[0].onmessage({ data });
    return messages;
  };

  const first = dirty(true);
  engine.render();
  const oldMessages = engine.messages.splice(0);
  assert.equal(oldMessages.filter(message => message.type === 'geometry').length, 1);
  const second = dirty(true);
  for (const data of oldMessages) renderer.workers[0].onmessage({ data });
  assert.equal(renderer.sectionsOutstanding.has('0,0,0'), true);
  assert.equal(renderer.sectionMeshs['0,0,0'], undefined, 'Old geometry must not replace current scene');
  engine.render();
  const current = flush();
  assert.ok(current.every(message => message.revision === second));
  assert.ok(second > first);
  assert.equal(renderer.sectionsOutstanding.size, 0);
  assert.ok(renderer.sectionMeshs['0,0,0']);

  dirty(true);
  const latest = dirty(true);
  engine.render();
  const coalesced = flush();
  assert.equal(coalesced.filter(message => message.type === 'geometry').length, 1);
  assert.ok(coalesced.every(message => message.revision === latest));

  const unload = dirty(false);
  const cancelled = flush();
  assert.deepEqual(cancelled.map(message => [message.type, message.revision]), [['sectionFinished', unload]]);
  engine.render();
  assert.equal(engine.messages.length, 0);

  engine.send({ type: 'unloadChunk', x: 0, z: 0 });
  const absent = dirty(true);
  assert.equal(flush()[0].revision, absent, 'Missing chunk also acknowledges its revision');
  assert.equal(renderer.sectionsOutstanding.size, 0);

  dirty(true);
  renderer.resetWorld();
  assert.equal(renderer.sectionsOutstanding.size, 0);
  assert.equal(renderer.sectionRevisions.size, 0);
  assert.equal(Object.keys(renderer.loadedChunks).length, 0);
  renderer.loadedChunks['0,0'] = true;
  renderer.setSectionDirty(pos, true);
  const afterReset = renderer.workers[0].messages.at(-1).revision;
  assert.ok(afterReset > latest, 'Counter must survive reset to prevent revision reuse');
  for (const data of oldMessages) renderer.workers[0].onmessage({ data });
  assert.equal(renderer.sectionsOutstanding.has('0,0,0'), true);
  assert.equal(renderer.sectionMeshs['0,0,0'], undefined);
  engine.messages.length = 0;
  engine.send({ type: 'chunk', x: 0, z: 0, chunk: chunk.toJson() });
  engine.send({ type: 'dirty', x: 0, y: 0, z: 0, value: true, revision: afterReset });
  engine.send({ type: 'reset' });
  engine.send({ type: 'version', version: '1.21.4' });
  engine.send({ type: 'blockStates', json: JSON.parse(fs.readFileSync(`${viewer}/public/blocksStates/1.21.4.json`, 'utf8')) });
  engine.render();
  assert.equal(engine.messages.length, 0, 'Worker reset must discard queued revisions from the previous world');
});

test('serialized helpers are self-contained, strict, and compose in either height-patch order', () => {
  const context = { source: clientSource };
  vm.runInNewContext(`this.result=(${patchViewerRevisionClient.toString()})(source)`, context);
  assert.equal(context.result, patchViewerRevisionClient(clientSource));
  assert.equal(patchViewerRevisionClient(patchViewerHeightClient(clientSource)), patchViewerHeightClient(patchViewerRevisionClient(clientSource)));
  // Exercise the worker helper as serialized source without retaining another VM.
  const result = vm.runInNewContext(`(${patchViewerRevisionWorker.toString()})(source)`, { source: workerSource });
  assert.equal(result, patchViewerRevisionWorker(workerSource));
  assert.equal(patchViewerRevisionWorker(patchViewerHeightWorker(workerSource)), patchViewerHeightWorker(patchViewerRevisionWorker(workerSource)));
  assert.throws(() => patchViewerRevisionClient('changed'), /integration changed/);
  assert.throws(() => patchViewerRevisionWorker('changed'), /integration changed/);
});
