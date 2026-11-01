import '../compat-loader.mjs';
import { patchChunkLightWorker } from '../chunk-light.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  attachGeometryLight, createViewerLightMaterial, installViewerLightClient,
  installViewerLightStream, patchViewerLightServer, patchViewerLightWorker, trackViewerLightColumns
} from '../viewer-light.mjs';
import { patchViewerHeightWorker } from '../viewer-height.mjs';

const root = process.env.MINDCRAFT_ROOT || '/opt/minecraft-mindcraft';
const require = createRequire(`${root}/package.json`);
const Chunk = require('prismarine-chunk')('1.21.4');
const { Vec3 } = require('vec3');
const THREE = require('three');
const registry = require('minecraft-data')('1.21.4');
const pause = () => new Promise(resolve => setTimeout(resolve, 130));

function loadLight(column, light) {
  column.loadParsedLight(light.skyLight, light.blockLight, light.skyLightMask,
    light.blockLightMask, light.emptySkyLightMask, light.emptyBlockLightMask);
}

function quad(sx = 0, sy = -64, sz = 0) {
  return {
    sx, sy, sz,
    positions: [1, 1, 1, 2, 1, 1, 2, 1, 2, 1, 1, 2],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]
  };
}

function fixture(t) {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  const columns = new Map([['-1,0', new Chunk()], ['0,0', new Chunk()]]);
  bot.world = {
    getColumn: (x, z) => columns.get(`${x},${z}`),
    getColumnAt: async pos => columns.get(`${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`)
  };
  trackViewerLightColumns(bot);
  const socket = new EventEmitter();
  const packets = [];
  socket.on('lightColumn', packet => packets.push(packet));
  const loaded = [];
  socket.on('loadChunk', packet => loaded.push(packet));
  const worldView = {
    loadedChunks: { '-16,0': true, '0,0': true },
    lastPos: new Vec3(0, 64, 0),
    viewDistance: 4,
    unloadChunk(pos) { delete this.loadedChunks[`${pos.x},${pos.z}`]; }
  };
  installViewerLightStream(bot, worldView, socket);
  t.after(() => socket.emit('disconnect'));
  return { bot, socket, columns, worldView, packets, loaded };
}

function packet(x = -1, changes = {}) {
  return {
    chunkX: x, chunkZ: 0,
    skyLightMask: [[0, 0]], blockLightMask: [[0, 0]],
    emptySkyLightMask: [[0, 0]], emptyBlockLightMask: [[0, 0]],
    ...changes
  };
}

test('actual patched upstream connection initializes WorldView and light stream without ASI invocation', t => {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.version = '1.21.4';
  bot.entity = { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 };
  bot.world = {};
  trackViewerLightColumns(bot);
  const io = new EventEmitter();
  const socket = new EventEmitter();
  t.after(() => socket.emit('disconnect'));
  let instance;
  class WorldView extends EventEmitter {
    constructor(world, distance, position, receivedSocket) {
      super();
      assert.equal(world, bot.world);
      assert.equal(receivedSocket, socket);
      this.loadedChunks = {};
      this.lastPos = position;
      this.viewDistance = distance;
      instance = this;
    }
    init(position) {
      assert.equal(position, bot.entity.position);
      assert.equal(bot._client.listenerCount('update_light'), 1, 'Light installer runs before init');
      this.initialized = true;
    }
    listenToBot(receivedBot) { assert.equal(receivedBot, bot); }
    removeListenersFromBot(receivedBot) { assert.equal(receivedBot, bot); }
    updatePosition() {}
  }
  let listenCalls = 0;
  const modules = {
    events: EventEmitter,
    '../viewer': { WorldView },
    express: () => ({}),
    http: { createServer: () => ({ listen() { listenCalls++; }, close() {} }) },
    'socket.io': () => io,
    './common': { setupRoutes() {} }
  };
  const upstream = readFileSync(`${root}/node_modules/prismarine-viewer/lib/mineflayer.js`, 'utf8');
  const patched = patchViewerLightServer(upstream, installViewerLightStream.toString());
  const module = { exports: {} };
  new Function('require', 'module', patched)(name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected upstream dependency: ${name}`);
    return modules[name];
  }, module);
  module.exports(bot, { port: 0 });
  assert.equal(listenCalls, 1, 'Upstream listen is mocked, not a real HTTP server');
  assert.doesNotThrow(() => io.emit('connection', socket));
  assert.equal(instance.initialized, true);
  assert.equal(bot.listenerCount('move'), 1);
  socket.emit('disconnect');
  assert.equal(bot._client.listenerCount('update_light'), 0);
  assert.equal(bot.listenerCount('move'), 0);
});

test('1.21.4 light survives binary structured clone and partial/empty section updates at minY', () => {
  const original = new Chunk();
  original.setBlockLight(new Vec3(1, -64, 1), 14);
  original.setSkyLight(new Vec3(1, -64, 1), 3);
  original.setBlockLight(new Vec3(2, 319, 2), 9);
  const receiver = new Chunk();
  loadLight(receiver, structuredClone(original.dumpLight()));
  assert.equal(receiver.getBlockLight(new Vec3(1, -64, 1)), 14);
  assert.equal(receiver.getSkyLight(new Vec3(1, -64, 1)), 3);
  assert.equal(receiver.getBlockLight(new Vec3(2, 319, 2)), 9);
  const partial = new Chunk();
  partial.setSkyLight(new Vec3(1, -64, 1), 15);
  loadLight(receiver, partial.dumpLight());
  assert.equal(receiver.getSkyLight(new Vec3(1, -64, 1)), 15);
  assert.equal(receiver.getBlockLight(new Vec3(1, -64, 1)), 14);
  loadLight(receiver, {
    skyLight: [], blockLight: [], skyLightMask: [[0, 0]], blockLightMask: [[0, 0]],
    emptySkyLightMask: [[0, 0]], emptyBlockLightMask: [[0, 2]]
  });
  assert.equal(receiver.getBlockLight(new Vec3(1, -64, 1)), 0);
  assert.equal(receiver.getBlockLight(new Vec3(2, 319, 2)), 9);
  assert.equal(receiver.getSkyLight(new Vec3(1, -64, 1)), 15);
});

test('quad lighting is position-specific, handles negative columns and avoids diagonal edge samples', () => {
  const column = new Chunk();
  column.setBlockLight(new Vec3(1, -63, 1), 12);
  column.setSkyLight(new Vec3(1, -64, 1), 7);
  // These diagonal cells must not bleed onto the quad corners.
  column.setBlockLight(new Vec3(2, -63, 2), 15);
  const world = { getColumn: (x, z) => x === -16 && z === -32 ? column : null };
  const first = attachGeometryLight(quad(-16, -64, -32), world);
  assert.deepEqual([...first.light], [12, 7, 12, 7, 12, 7, 12, 7]);
  const unlit = quad(-16, -64, -32);
  unlit.positions = unlit.positions.map((value, i) => i % 3 === 0 ? value + 5 : value);
  assert.ok([...attachGeometryLight(unlit, world).light].every(value => value === 0));
  assert.ok([...attachGeometryLight(quad(16), world).light].every(value => value === 0));
  assert.ok([...attachGeometryLight(quad(-16, -128, -32), world).light].every(value => value === 0));
});

test('real bundled mesher attaches finite water lighting and applies light-only updates without remapping blocks', () => {
  const messages = [];
  let render;
  const context = vm.createContext({
    console, self: { AbortController, AbortSignal }, performance,
    setInterval(callback) { render = callback; },
    postMessage(message) { messages.push(message); }
  });
  const upstream = readFileSync(`${root}/node_modules/prismarine-viewer/public/worker.js`, 'utf8');
  vm.runInContext(patchChunkLightWorker(patchViewerLightWorker(patchViewerHeightWorker(upstream))), context);
  const send = data => {
    context.messageJson = JSON.stringify(data);
    vm.runInContext('self.onmessage({ data: JSON.parse(messageJson) })', context);
  };
  send({ type: 'version', version: '1.21.4' });
  send({ type: 'blockStates', json: JSON.parse(readFileSync(`${root}/node_modules/prismarine-viewer/public/blocksStates/1.21.4.json`, 'utf8')) });
  const column = new Chunk();
  column.setBlockStateId(new Vec3(8, -56, 8), registry.blocksByName.water.minStateId);
  for (let x = 7; x <= 9; x++) {
    for (let y = -57; y <= -55; y++) {
      for (let z = 7; z <= 9; z++) column.setBlockLight(new Vec3(x, y, z), 13);
    }
  }
  send({ type: 'chunk', x: -16, z: 0, chunk: column.toJson() });
  const mesh = () => {
    send({ type: 'dirty', x: -16, y: -64, z: 0, value: true });
    render();
    return messages.findLast(message => message.type === 'geometry').geometry;
  };
  const lit = mesh();
  assert.ok(lit.positions.length > 0);
  assert.equal(lit.light.length, lit.positions.length / 3 * 2);
  assert.ok([...lit.light].every(Number.isFinite));
  assert.ok([...lit.light].filter((_, i) => i % 2 === 0).every(value => value === 13));
  send({ type: 'lightColumn', x: -16, z: 0, light: {
    skyLight: [], blockLight: [], skyLightMask: [[0, 0]], blockLightMask: [[0, 0]],
    emptySkyLightMask: [[0, 2]], emptyBlockLightMask: [[0, 2]]
  } });
  const dark = mesh();
  assert.deepEqual([...dark.positions], [...lit.positions]);
  assert.ok([...dark.light].every(value => value === 0));
});

test('server coalesces actual column light after partial/empty masks, including boundary sections', async t => {
  const f = fixture(t);
  await f.worldView.loadChunk({ x: -16, z: 0 });
  assert.equal(f.loaded.length, 0, 'No column loads before map_chunk readiness');
  f.bot._client.emit('map_chunk', { x: -1, z: 0 });
  await f.worldView.loadChunk({ x: -16, z: 0 });
  assert.equal(f.loaded.length, 1);
  const column = f.columns.get('-1,0');
  column.setBlockLight(new Vec3(1, -64, 1), 14);
  f.bot._client.emit('update_light', packet(-1, { blockLightMask: [[0, 2]] }));
  column.setSkyLight(new Vec3(1, -48, 1), 15);
  f.bot._client.emit('update_light', packet(-1, {
    skyLightMask: [[0, 4]], emptyBlockLightMask: [[0, 1 | (1 << 25)]]
  }));
  await pause();
  assert.equal(f.packets.length, 1);
  assert.equal(f.packets[0].x, -16);
  assert.deepEqual(new Set(f.packets[0].sections), new Set([-80, -64, -48, 320]));
  const receiver = new Chunk();
  loadLight(receiver, f.packets[0].light);
  assert.equal(receiver.getBlockLight(new Vec3(1, -64, 1)), 14);
  assert.equal(receiver.getSkyLight(new Vec3(1, -48, 1)), 15);
});

test('server discards queued stale/unloaded columns and disconnect removes only viewer subscriptions', async t => {
  const f = fixture(t);
  const update = () => f.bot._client.emit('update_light', packet(-1, { blockLightMask: [[0, 2]] }));
  f.bot._client.emit('map_chunk', { x: -1, z: 0 });
  update();
  f.bot._client.emit('unload_chunk', { chunkX: -1, chunkZ: 0 });
  await pause();
  assert.equal(f.packets.length, 0);
  f.bot._client.emit('map_chunk', { x: -1, z: 0 });
  update();
  f.bot.emit('chunkColumnUnload', { x: -16, z: 0 });
  assert.equal(f.worldView.loadedChunks['-16,0'], undefined);
  await pause();
  assert.equal(f.packets.length, 0);
  assert.equal(f.bot.roycraftLightColumns.has('-16,0'), false);
  f.socket.emit('disconnect');
  assert.equal(f.bot._client.listenerCount('update_light'), 0);
  assert.equal(f.bot.listenerCount('chunkColumnUnload'), 1, 'Global column readiness listener remains');
  assert.equal(f.bot._client.listenerCount('respawn'), 0);
  await pause();
  assert.equal(f.packets.length, 0);
});

test('same-dimension respawn preserves loaded columns, readiness and pending light updates', async t => {
  const f = fixture(t);
  f.bot._client.emit('map_chunk', { x: -1, z: 0 });
  const column = f.columns.get('-1,0');
  column.setBlockLight(new Vec3(1, -64, 1), 12);
  f.bot._client.emit('update_light', packet(-1, { blockLightMask: [[0, 2]] }));
  f.bot._client.emit('respawn', { dimension: 'overworld' });
  assert.equal(f.bot.roycraftLightColumns.has('-16,0'), true);
  assert.equal(f.worldView.loadedChunks['-16,0'], true);
  await pause();
  assert.equal(f.packets.length, 1);
  const receiver = new Chunk();
  loadLight(receiver, f.packets[0].light);
  assert.equal(receiver.getBlockLight(new Vec3(1, -64, 1)), 12);
  f.bot._client.emit('update_light', packet(-1, { blockLightMask: [[0, 2]] }));
  await pause();
  assert.equal(f.packets.length, 2, 'Light subscription survives same-dimension respawn');
});

test('real dimension switch unloads each old column before accepting replacement map chunks', async t => {
  const f = fixture(t);
  f.bot._client.emit('map_chunk', { x: -1, z: 0 });
  f.bot._client.emit('map_chunk', { x: 0, z: 0 });
  f.bot._client.emit('update_light', packet(-1, { blockLightMask: [[0, 2]] }));
  // Mineflayer emits one unload per retained column on an actual switch.
  for (const pos of [{ x: -16, z: 0 }, { x: 0, z: 0 }]) f.bot.emit('chunkColumnUnload', pos);
  f.bot._client.emit('respawn', { dimension: 'the_nether' });
  assert.equal(f.bot.roycraftLightColumns.size, 0);
  assert.deepEqual(f.worldView.loadedChunks, {});
  await pause();
  assert.equal(f.packets.length, 0, 'Old dimension pending light was discarded');
  await f.worldView.loadChunk({ x: -16, z: 0 });
  assert.equal(f.loaded.length, 0, 'Replacement must wait for a new map chunk');
  f.bot._client.emit('map_chunk', { x: -1, z: 0 });
  await f.worldView.loadChunk({ x: -16, z: 0 });
  assert.equal(f.loaded.length, 1);
  assert.equal(f.worldView.loadedChunks['-16,0'], true);
});

test('in-flight chunk loads are rejected after dimension unload, unload, movement and disconnect', async t => {
  const f = fixture(t);
  for (const reason of ['dimension-switch', 'unload', 'movement', 'disconnect']) {
    let resolve;
    f.bot.world.getColumnAt = () => new Promise(done => { resolve = done; });
    f.bot._client.emit('map_chunk', { x: -1, z: 0 });
    f.worldView.lastPos = new Vec3(0, 64, 0);
    const loading = f.worldView.loadChunk({ x: -16, z: 0 });
    if (reason === 'dimension-switch') {
      for (const pos of [{ x: -16, z: 0 }, { x: 0, z: 0 }]) f.bot.emit('chunkColumnUnload', pos);
      f.bot._client.emit('respawn', { dimension: 'the_nether' });
      // The replacement dimension can have the same coordinates ready again.
      f.bot._client.emit('map_chunk', { x: -1, z: 0 });
    } else if (reason === 'unload') {
      f.bot._client.emit('unload_chunk', { chunkX: -1, chunkZ: 0 });
      f.bot.emit('chunkColumnUnload', { x: -16, z: 0 });
    } else if (reason === 'movement') {
      f.worldView.lastPos = new Vec3(512, 64, 512);
    } else {
      f.socket.emit('disconnect');
    }
    resolve(f.columns.get('-1,0'));
    await loading;
    assert.equal(f.loaded.length, 0, `Stale load emitted after ${reason}`);
  }
});

test('same-coordinate reload publishes the replacement column and rejects an older in-flight load', async t => {
  const f = fixture(t);
  const resolvers = [];
  f.bot.world.getColumnAt = () => new Promise(resolve => resolvers.push(resolve));
  f.bot._client.emit('map_chunk', { x: -1, z: 0 });
  const original = f.worldView.loadChunk({ x: -16, z: 0 });
  f.bot._client.emit('unload_chunk', { chunkX: -1, chunkZ: 0 });
  f.bot.emit('chunkColumnUnload', { x: -16, z: 0 });
  f.bot._client.emit('map_chunk', { x: -1, z: 0 });
  const replacement = new Chunk();
  replacement.setBlockLight(new Vec3(1, -64, 1), 15);
  const reloading = f.worldView.loadChunk({ x: -16, z: 0 });
  resolvers[1](replacement);
  await reloading;
  assert.equal(f.loaded.length, 1);
  assert.equal(f.loaded[0].chunk, replacement.toJson());
  resolvers[0](f.columns.get('-1,0'));
  await original;
  assert.equal(f.loaded.length, 1, 'Old column must not overwrite the replacement');
  assert.equal(f.worldView.loadedChunks['-16,0'], true);
});

test('light packets ignore a missing column even when viewer readiness is stale', async t => {
  const f = fixture(t);
  f.bot._client.emit('map_chunk', { x: -1, z: 0 });
  f.columns.delete('-1,0');
  assert.doesNotThrow(() => f.bot._client.emit('update_light', packet(-1, { blockLightMask: [[0, 2]] })));
  await pause();
  assert.equal(f.packets.length, 0);
});

test('client darkens only sky uniformly and updates loaded adjacent sections after real column updates', async () => {
  const socket = new EventEmitter();
  const material = createViewerLightMaterial(THREE);
  const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <color_fragment>' };
  material.onBeforeCompile(shader);
  const workerMessages = [];
  const dirty = [];
  const world = {
    material, loadedChunks: { '0,0': true, '-16,0': true },
    workers: [{ postMessage: message => workerMessages.push(message) }],
    setSectionDirty: position => dirty.push(position)
  };
  installViewerLightClient({ world }, socket);
  socket.emit('adventureState', { dimension: 'overworld', time: { timeOfDay: 6000 } });
  assert.equal(shader.uniforms.roycraftSkyDarken.value, 0);
  socket.emit('adventureState', { dimension: 'overworld', time: { timeOfDay: 18000 } });
  assert.equal(shader.uniforms.roycraftSkyDarken.value, 11);
  assert.equal(dirty.length, 0, 'Day/night does not remesh terrain');
  socket.emit('adventureState', { dimension: 'the_nether', time: { timeOfDay: 18000 } });
  assert.equal(shader.uniforms.roycraftSkyDarken.value, 0);
  const light = new Chunk().dumpLight();
  socket.emit('lightColumn', { x: 0, z: 0, sections: [-64, -48], light });
  assert.equal(workerMessages.length, 1);
  assert.equal(workerMessages[0].light, light);
  assert.deepEqual(new Set(dirty.map(p => `${p.x},${p.y},${p.z}`)), new Set([
    '0,-80,0', '0,-64,0', '0,-48,0', '0,-32,0', '-16,-64,0', '-16,-48,0'
  ]));
  socket.emit('lightColumn', { x: 16, z: 0, sections: [-64], light });
  assert.equal(workerMessages.length, 1, 'Late unloaded-column packet is ignored');
  dirty.length = 0;
  socket.emit('unloadChunk', { x: 0, z: 0 });
  await Promise.resolve();
  assert.equal(dirty.length, 24);
  assert.ok(dirty.every(p => p.x === -16 && p.z === 0));
  material.dispose();
});

test('adjacent remesh messages follow upstream unload even when light listener is registered first', async () => {
  const socket = new EventEmitter();
  const messages = [];
  const worker = { postMessage: message => messages.push(message) };
  const world = {
    loadedChunks: { '0,0': true, '-16,0': true },
    workers: [worker],
    setSectionDirty(position) { worker.postMessage({ type: 'dirty', ...position }); }
  };
  installViewerLightClient({ world }, socket);
  // Upstream registers removeColumn after our light integration. Its unload
  // must reach the mesher before neighboring geometry is marked dirty.
  socket.on('unloadChunk', ({ x, z }) => {
    delete world.loadedChunks[`${x},${z}`];
    worker.postMessage({ type: 'unloadChunk', x, z });
  });
  socket.emit('unloadChunk', { x: 0, z: 0 });
  assert.deepEqual(messages, [{ type: 'unloadChunk', x: 0, z: 0 }]);
  await Promise.resolve();
  assert.equal(messages.length, 25);
  assert.deepEqual(messages.slice(1), Array.from({ length: 24 }, (_, i) => ({
    type: 'dirty', x: -16, y: -64 + i * 16, z: 0
  })));
});
