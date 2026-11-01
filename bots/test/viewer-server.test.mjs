import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { patchViewerServer, viewerState } from '../viewer-stream.mjs';

test('real upstream viewer refreshes travelling chunks and equipment, then releases every viewer timer/listener', async () => {
  const source = readFileSync('/opt/minecraft-mindcraft/node_modules/prismarine-viewer/lib/mineflayer.js', 'utf8');
  const intervals = new Set();
  let connect;
  let world;
  class WorldView {
    constructor() { world = this; this.loadedChunks = { '0,0': true }; }
    async init() {}
    async updatePosition() { if (this.travelled) this.loadedChunks = { '160,160': true }; }
    on() {}
    listenToBot() {}
    removeListenersFromBot() {}
  }
  const io = { on(name, callback) { assert.equal(name, 'connection'); connect = callback; } };
  const sandbox = {
    module: { exports: {} }, console: { log() {} },
    setInterval(callback) { intervals.add(callback); return callback; },
    clearInterval(timer) { intervals.delete(timer); },
    require(name) {
      if (name === 'events') return EventEmitter;
      if (name === '../viewer') return { WorldView };
      if (name === 'express') return () => ({});
      if (name === 'http') return { createServer: () => ({ listen(port, host) { assert.equal(host, '127.0.0.1'); } }) };
      if (name === 'socket.io') return () => io;
      if (name === './common') return { setupRoutes() {} };
      throw new Error(`Unexpected import: ${name}`);
    }
  };
  vm.runInNewContext(patchViewerServer(source, viewerState.toString()), sandbox);
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: '1.21.4', username: 'Flint', health: 20, food: 19,
    entity: { position: { x: 1, y: 70, z: 3 }, velocity: { x: 0, y: -0.0784, z: 0 }, yaw: 0, pitch: 0, onGround: true },
    adventureAction: () => 'idle', inventory: Object.assign(new EventEmitter(), { slots: {}, items: () => [] })
  });
  sandbox.module.exports(bot, { firstPerson: true });
  const socket = new EventEmitter();
  const sent = [];
  const emit = socket.emit.bind(socket);
  socket.emit = (name, payload) => { sent.push([name, payload]); return emit(name, payload); };
  connect(socket);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(sent.some(([event]) => event === 'position'), 'Stationary bots must receive an initial camera');
  assert.deepEqual([...sent.find(([event]) => event === 'adventureChunks')[1]], ['0,0']);
  bot.heldItem = { name: 'iron_pickaxe', count: 1 };
  bot.emit('heldItemChanged');
  assert.equal(sent.at(-1)[1].held.name, 'iron_pickaxe');
  world.travelled = true;
  bot.emit('move');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...sent.filter(([event]) => event === 'adventureChunks').at(-1)[1]], ['160,160']);
  assert.equal(intervals.size, 1);
  socket.emit('disconnect');
  assert.equal(intervals.size, 0);
  assert.equal(bot.listenerCount('move'), 0);
  assert.equal(bot.listenerCount('heldItemChanged'), 0);
  assert.equal(bot.inventory.listenerCount('updateSlot'), 0);
});
