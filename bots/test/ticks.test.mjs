import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { patchPhysics, patchBotSource } from '../compat-loader.mjs';
import { EventEmitter } from 'node:events';

const source = patchPhysics(readFileSync('/opt/minecraft-mindcraft/node_modules/mineflayer/lib/plugins/physics.js', 'utf8'));
const tick = source.slice(source.indexOf('  function tickPhysics ('), source.indexOf("  // remove this when 'physicTick'"));

function simulatedTick({ loaded = true, playing = true, feature = true, ready = true } = {}) {
  const packets = [];
  const context = {
    bot: { _client: { state: playing ? 'play' : 'configuration', write: name => packets.push(name) },
      entity: { position: { x: 1 } }, blockAt: () => loaded ? {} : null,
      physicsEnabled: false, supportFeature: () => feature },
    shouldUsePhysics: ready, updatePosition: () => packets.push('position')
  };
  runInNewContext(`${tick}; tickPhysics(10); tickPhysics(60);`, context);
  return packets;
}

test('real physics function closes each movement tick, never sends movement during unloaded/configuration state', () => {
  assert.deepEqual(simulatedTick(), ['position', 'tick_end', 'position', 'tick_end']);
  assert.deepEqual(simulatedTick({ loaded: false }), []);
  assert.deepEqual(simulatedTick({ playing: false }), []);
  assert.deepEqual(simulatedTick({ ready: false }), []);
  assert.deepEqual(simulatedTick({ feature: false }), ['position', 'position']);
});

test('Mindcraft client write path cannot defer movement across a real tick boundary', () => {
  const botSource = patchBotSource(readFileSync('/opt/minecraft-mindcraft/src/utils/mcdata.js', 'utf8'));
  const init = botSource.slice(botSource.indexOf('export function initBot('), botSource.indexOf('export function isHuntable')).replace('export function', 'function');
  const packets = [];
  const timers = [];
  let now = 0;
  const client = Object.assign(new EventEmitter(), { state: 'play', write: name => packets.push(name) });
  const fake = Object.assign(new EventEmitter(), { _client: client, loadPlugin() {},
    entity: { position: { x: 1 }, onGround: true }, blockAt: () => ({}), physicsEnabled: false, supportFeature: () => true });
  const context = {
    mc_version: null, settings: { minecraft_version: '1.21.4', host: '127.0.0.1', port: 25567, auth: 'offline' },
    createBot: options => { assert.equal(options.version, '1.21.4'); return fake; },
    pathfinder: null, pvp: null, collectblock: null, autoEat: null, armorManager: null,
    Date: { now: () => now }, setTimeout: (fn, delay) => { timers.push({ fn, at: now + delay }); }, clearTimeout() {},
    shouldUsePhysics: true, updatePosition: () => fake._client.write('position'),
    sendPacketPositionAndLook: () => fake._client.write('position_look'), pos: {}, newYaw: 0, newPitch: 0
  };
  runInNewContext(`${init}\nvar bot=initBot('Roy');\n${tick}\ntickPhysics(0)`, context);
  now = 20;
  const marker = '    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)';
  const start = source.indexOf(marker);
  const end = source.indexOf('\n', source.indexOf('\n', start) + 1);
  runInNewContext(source.slice(start, end), context);
  now = 100;
  for (const timer of timers) if (timer.at <= now) timer.fn();
  assert.deepEqual(packets, ['position', 'tick_end', 'position_look', 'tick_end']);
  assert.equal(timers.length, 0, 'movement writes must not be put on a second timer');
});

test('teleport echo closes before the next real physics tick; delayed respawn has its own boundary', () => {
  for (const marker of ['    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)',
    '        sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)']) {
    const start = source.indexOf(marker);
    const end = source.indexOf('\n', source.indexOf('\n', start) + 1);
    const echo = source.slice(start, end);
    const packets = [];
    runInNewContext(`${echo}\n${tick}\ntickPhysics(100)`, {
      bot: { entity: { onGround: true, position: { x: 1 } }, _client: { state: 'play', write: name => packets.push(name) },
        physicsEnabled: false, blockAt: () => ({}), supportFeature: () => true },
      pos: {}, newYaw: 0, newPitch: 0, delayedPos: {}, delayedYaw: 0, delayedPitch: 0, delayedOnGround: true,
      shouldUsePhysics: true, sendPacketPositionAndLook: () => packets.push('position_look'), updatePosition: () => packets.push('position')
    });
    assert.deepEqual(packets, ['position_look', 'tick_end', 'position', 'tick_end']);
  }
});
