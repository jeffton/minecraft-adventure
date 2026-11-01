import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readyScript, patchViewerClient } from '../viewer-readiness.mjs';
import { createCameraMotion } from '../viewer-stream.mjs';

test('camera and completed terrain meshes are both required before a snapshot', () => {
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
  for (let i = 0; i < 10; i++) gl.drawElements(4, 4096);
  assert.equal(window.roycraftReady, false);
  window.roycraftChunksReady = true;
  gl.drawElements(4, 4096);
  assert.equal(window.roycraftReady, true);
  socket.listeners.close();
  assert.equal(window.roycraftReady, false);
  assert.equal(window.roycraftCameraApplied, false);
  assert.equal(window.roycraftChunksReady, false);
});

test('client integration installs one motion controller and waits for initial chunk meshing', () => {
  const source = 'const u=new r(l);u.setFirstPersonCamera(t,r,o);u.update(),l.render';
  const result = patchViewerClient(source, createCameraMotion.toString());
  assert.match(result, /sectionsOutstanding.size===0/);
  assert.match(result, /roycraftMotion.receive/);
  assert.match(result, /adventureState/);
  assert.throws(() => patchViewerClient('changed upstream'), /integration changed/);
});
