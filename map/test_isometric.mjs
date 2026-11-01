import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const script = readFileSync(new URL('./isometric.js', import.meta.url), 'utf8');

test('tilted orthographic camera retains actual terrain/player height after upstream reset', () => {
  const manager = { position: { x: -20, y: 135, z: 40 }, ortho: 1, angle: 0.6 };
  let heightUpdates = 0;
  const controls = {
    manager,
    update() { manager.position.y = this.following ? 142 : -10000; },
    mapHeight: { update() { heightUpdates++; manager.position.y = Math.max(manager.position.y, 130); } }
  };
  const app = { mapControls: controls, resetCamera() {} };
  vm.runInNewContext(script, { window: { bluemap: app } });
  controls.update(16, {});
  assert.equal(manager.position.y, 130);
  assert.equal(manager.position.x, -20);
  controls.following = true;
  controls.update(16, {});
  assert.equal(manager.position.y, 142, 'player height must not be replaced by lower terrain');
  manager.ortho = 0;
  controls.update(16, {});
  assert.equal(heightUpdates, 2, 'normal perspective height computation must not be duplicated');
});

test('dimension reset produces isometric projection without changing world coordinates', () => {
  const camera = { position: { x: 6, y: 50, z: -18 } };
  const app = {
    mapControls: { update() {} },
    mapViewer: { controlsManager: camera },
    appState: { controls: {} },
    resetCamera() { camera.position = { x: 2, y: 90, z: 3 }; },
    updatePageAddress() {}
  };
  vm.runInNewContext(script, { window: { bluemap: app } });
  assert.deepEqual(camera.position, { x: 6, y: 50, z: -18 }, 'initial deep link is untouched');
  app.resetCamera();
  assert.deepEqual(camera.position, { x: 2, y: 90, z: 3 });
  assert.equal(camera.ortho, 1);
  assert.equal(camera.rotation, Math.PI / 4);
  assert.equal(camera.angle, Math.atan(1 / Math.sqrt(2)));
});
