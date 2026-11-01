import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraMotion, viewerState, patchViewerServer } from '../viewer-stream.mjs';

function viewer() {
  return { playerHeight: 1.6, camera: {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
    rotation: { x: 0, y: 0, set(x, y) { Object.assign(this, { x, y }); } }
  } };
}

test('continuous packets move camera monotonically; wrapped look takes short arc and teleport snaps', () => {
  const motion = createCameraMotion();
  const v = viewer();
  motion.receive(v, { x: 0, y: 100, z: 0 }, Math.PI - 0.01, 0);
  assert.equal(v.camera.position.y, 101.6);
  let previous = 0;
  for (let time = 16; time <= 1000; time += 16) {
    if (time % 48 === 0) motion.receive(v, { x: time / 100, y: 100, z: 0 }, -Math.PI + 0.01, 0.4);
    motion.frame(v, time);
    assert.ok(v.camera.position.x >= previous);
    assert.ok(Math.abs(v.camera.rotation.y - Math.PI) < 0.02);
    previous = v.camera.position.x;
  }
  assert.ok(previous > 8);
  motion.receive(v, { x: 100, y: 70, z: 20 }, 0, 0);
  assert.equal(v.camera.position.x, 100);
  assert.equal(v.camera.position.y, 71.6);
});

test('telemetry reflects actual held slot changes and inventory without private bot fields', () => {
  const bot = {
    username: 'Roy', _client: { state: 'play' }, health: 19, food: 18, heldItem: { name: 'stone_sword', count: 1, nbt: 'private' },
    inventory: { slots: { 45: { name: 'shield', count: 1 } }, items: () => [{ name: 'oak_log', count: 8 }] },
    entity: { position: { x: 1, y: 70, z: 3 }, velocity: { x: 0, y: -0.0784, z: 0 }, onGround: true },
    targetDigBlock: null, secret: 'must not leave server'
  };
  assert.deepEqual(viewerState(bot, 'idle').held, { name: 'stone_sword', count: 1 });
  bot.heldItem = null;
  assert.equal(viewerState(bot, 'idle').held, null);
  assert.equal(viewerState(bot, 'idle').inventory[0].count, 8);
  assert.ok(!JSON.stringify(viewerState(bot, 'idle')).includes('private'));
  assert.ok(!JSON.stringify(viewerState(bot, 'idle')).includes('secret'));
  assert.equal(viewerState(bot, 'idle').moving, false);
  bot._client.ended = true; // minecraft-protocol retains state='play' when its transport ends.
  assert.equal(viewerState(bot, 'idle').status, 'offline');
});

test('upstream server patch rejects changed integration anchors', () => {
  const fixture = "socket.emit('version', bot.version)\nhttp.listen(port, () => {\nworldView.init(bot.entity.position)\nworldView.updatePosition(bot.entity.position)\nbot.on('move', botPosition)\nbot.removeListener('move', botPosition)";
  const result = patchViewerServer(fixture, viewerState.toString());
  assert.match(result, /clearInterval\(stateTimer\)/);
  assert.match(result, /removeListener\('heldItemChanged', sendState\)/);
  assert.match(result, /inventory.removeListener\('updateSlot', sendState\)/);
  assert.match(result, /127.0.0.1/);
  assert.throws(() => patchViewerServer('changed', viewerState.toString()), /integration changed/);
});
