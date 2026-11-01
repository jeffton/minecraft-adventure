import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readyScript, patchViewerClient } from '../viewer-readiness.mjs';

test('world draws cannot announce readiness before the first camera position is applied', () => {
  let socket;
  class WebSocket {
    constructor() { socket = this; this.listeners = {}; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }
  class WebGLRenderingContext { drawElements() {} }
  const window = { WebSocket, WebGLRenderingContext };
  vm.runInNewContext(readyScript.replace('<script>', '').replace('</script>', ''), { window, Date, setInterval() {} });
  new window.WebSocket();
  socket.listeners.message();
  const gl = new WebGLRenderingContext();
  for (let i = 0; i < 10; i++) gl.drawElements(4, 4096);
  assert.equal(window.roycraftReady, false);
  window.roycraftCameraApplied = true;
  for (let i = 0; i < 3; i++) gl.drawElements(4, 4096);
  assert.equal(window.roycraftReady, true);
  socket.listeners.close();
  assert.equal(window.roycraftReady, false);
  assert.equal(window.roycraftCameraApplied, false);
});

test('initial camera is positioned synchronously; subsequent motion uses the original tween', () => {
  const source = patchViewerClient('u.setFirstPersonCamera(t,r,o)');
  const calls = [];
  const window = {};
  const u = { playerHeight: 1.6, camera: { position: { set: (...args) => calls.push(['position', ...args]) } }, setFirstPersonCamera: (...args) => calls.push(['camera', ...args]) };
  const context = { window, u, t: { x: 5, y: 100, z: 9 }, r: 0.4, o: 0.2 };
  vm.runInNewContext(source, context);
  assert.deepEqual(calls, [['position', 5, 101.6, 9], ['camera', null, 0.4, 0.2]]);
  assert.equal(window.roycraftCameraApplied, true);
  vm.runInNewContext(source, context);
  assert.deepEqual(calls[2], ['camera', context.t, 0.4, 0.2]);
  assert.throws(() => patchViewerClient('changed upstream'), /integration changed/);
});
