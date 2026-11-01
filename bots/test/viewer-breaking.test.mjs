import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { installViewerBreaking, patchViewerBreakingServer } from '../viewer-breaking.mjs';
import { patchViewerServer, viewerState } from '../viewer-stream.mjs';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Vec3 } = require('vec3');

function fixture() {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  const writes = [];
  bot._client.write = (...args) => writes.push(args);
  bot.entity = { id: 7, position: new Vec3(0, 64, 0) };
  bot.blockAt = position => ({ position: position.floored(), shapes: [[0, 0, 0, 1, 1, 1]] });
  bot.digTime = () => 1000;
  const packets = [];
  let time = 0;
  const tracker = installViewerBreaking(bot, packet => packets.push(packet), () => time);
  return { bot, packets, writes, tracker, advance: ms => { time += ms; } };
}

test('actual own digging packets drive timed stages, cancel and finish without modifying gameplay packets', async () => {
  const f = fixture();
  try {
    const start = { status: 0, location: new Vec3(1, 64, 2) };
    f.bot._client.write('block_dig', start);
    assert.equal(f.writes[0][1], start);
    assert.equal(f.packets.at(-1).stage, 0);
    f.advance(450);
    await new Promise(resolve => setTimeout(resolve, 55));
    assert.equal(f.packets.at(-1).stage, 4);
    f.bot._client.write('block_dig', { ...start, status: 1 });
    assert.deepEqual(f.packets.at(-1), { id: 'own:7', stage: -1 });
    assert.deepEqual(f.tracker.snapshot(), []);
    f.bot._client.write('block_dig', start);
    f.bot._client.write('block_dig', { ...start, status: 2 });
    assert.equal(f.packets.at(-1).stage, -1);
  } finally { f.tracker.close(); }
});

test('server stages retain breaker IDs, clear on block replacement, expiry, death and restore listener ownership', async () => {
  const f = fixture();
  const originalObservedWrite = f.bot._client.write;
  const packet = { entityId: 21, location: { x: -1, y: 64, z: 2 }, destroyStage: 6 };
  try {
    f.bot._client.emit('block_break_animation', packet);
    assert.equal(f.packets.at(-1).stage, 6);
    assert.equal(f.tracker.snapshot()[0].id, 'entity:21');
    f.bot._client.emit('block_break_animation', { ...packet, destroyStage: 255 });
    assert.equal(f.packets.at(-1).stage, -1);
    f.bot._client.emit('block_break_animation', packet);
    f.bot.emit('blockUpdate', null, { position: packet.location });
    assert.equal(f.packets.at(-1).stage, -1);
    f.bot._client.emit('block_break_animation', packet);
    f.advance(20001);
    await new Promise(resolve => setTimeout(resolve, 55));
    assert.deepEqual(f.tracker.snapshot(), []);
    f.bot._client.emit('block_break_animation', packet);
    f.bot.emit('death');
    assert.deepEqual(f.packets.at(-1), { reset: true });
  } finally { f.tracker.close(); }
  assert.notEqual(f.bot._client.write, originalObservedWrite);
  assert.equal(f.bot._client.listenerCount('block_break_animation'), 0);
});

test('real player HTTP route composes and serializes the complete browser bundle', () => {
  const script = `
    import './player/viewer.mjs';
    import { createRequire } from 'node:module';
    const require = createRequire('/opt/minecraft-mindcraft/package.json');
    const routes = new Map();
    require('prismarine-viewer/lib/common.js').setupRoutes({ use() {}, get(path, fn) { routes.set(path, fn); } });
    let bundle;
    routes.get('/index.js')({}, { type() { return this; }, send(source) { bundle = source; } });
    new Function(bundle);
    if (!bundle.includes('function createViewerBreakingClient')) throw new Error('Breaking overlay missing');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('../../', import.meta.url), timeout: 15000 });
});

test('upstream server patches compose and compile', () => {
  const source = readFileSync('/opt/minecraft-mindcraft/node_modules/prismarine-viewer/lib/mineflayer.js', 'utf8');
  const patched = patchViewerServer(patchViewerBreakingServer(source, installViewerBreaking.toString()), viewerState.toString());
  new Function('require', 'module', patched);
  assert.match(patched, /breaking.snapshot/);
  assert.match(patched, /breaking.close/);
});
