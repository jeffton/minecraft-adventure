import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readyScript, patchViewerClient, visibleSectionsReady, radialFogVertex } from '../viewer-readiness.mjs';
import { createCameraMotion } from '../viewer-stream.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const THREE = require('three');

function setup() {
  let socket;
  class WebSocket {
    constructor() { socket = this; this.listeners = {}; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }
  class HTMLCanvasElement {}
  const window = { WebSocket };
  vm.runInNewContext(readyScript.replace('<script>', '').replace('</script>', ''), { window, Date, HTMLCanvasElement, setInterval() {} });
  new window.WebSocket();
  socket.listeners.message();
  return { window, socket, HTMLCanvasElement };
}

test('a completed frame requires camera, visible meshes and successful textures; no draw-size heuristic', () => {
  const { window, socket, HTMLCanvasElement } = setup();
  const texture = { image: undefined };
  const scene = { world: { material: { map: texture } }, scene: { traverse: callback => callback({ material: { map: texture } }) } };
  assert.equal(window.roycraftTexturesReady(scene), false);
  texture.image = { complete: false, naturalWidth: 0 };
  assert.equal(window.roycraftTexturesReady(scene), false);
  texture.image.complete = true;
  assert.equal(window.roycraftTexturesReady(scene), false, 'A failed image also reports complete');
  texture.image.naturalWidth = 64;
  assert.equal(window.roycraftTexturesReady(scene), true);
  texture.image = new HTMLCanvasElement();
  assert.equal(window.roycraftTexturesReady(scene), true);
  window.roycraftFrameRendered({});
  assert.equal(window.roycraftReady, false);
  window.roycraftCameraApplied = true;
  window.roycraftFrameRendered({});
  assert.equal(window.roycraftReady, false);
  window.roycraftChunksReady = true;
  window.roycraftFrameRendered({});
  assert.equal(window.roycraftReady, true, 'A valid small-mesh or sky view needs no large draw calls');
  socket.listeners.close();
  assert.equal(window.roycraftReady, false);
  assert.equal(window.roycraftCameraApplied, false);
  assert.equal(window.roycraftChunksReady, false);
});

test('capture exports one qualifying completed frame atomically, while ordinary viewers do not export', () => {
  const { window } = setup();
  let exports = 0;
  let value = 'frame-one';
  const renderer = { domElement: { toDataURL(type, quality) {
    assert.equal(type, 'image/webp'); assert.equal(quality, 0.85); exports++; return value;
  } } };
  window.roycraftCameraApplied = true;
  window.roycraftChunksReady = true;
  window.roycraftFrameRendered(renderer);
  assert.equal(exports, 0);
  window.roycraftCaptureRequested = true;
  window.roycraftFrameRendered(renderer);
  assert.equal(window.roycraftCapture, 'frame-one');
  value = 'frame-two';
  window.roycraftChunksReady = false;
  window.roycraftFrameRendered(renderer);
  window.roycraftChunksReady = true;
  window.roycraftFrameRendered(renderer);
  assert.equal(exports, 1);
  assert.equal(window.roycraftCapture, 'frame-one', 'Later camera/mesh changes cannot replace the captured frame');
});

test('only pending sections intersecting the camera block readiness, including full-height and overhang bounds', () => {
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 48);
  camera.position.set(0, 135, 0);
  camera.lookAt(0, 135, -16);
  const loadedChunks = {};
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) loadedChunks[`${x * 16},${z * 16}`] = true;
  const world = { loadedChunks, sectionsOutstanding: new Set(['0,128,16', '0,-64,-16', '0,304,-16']) };
  const viewer = { camera, world };
  const ready = (padding = 0.425) => visibleSectionsReady(viewer, THREE, padding, 44);
  assert.equal(ready(), true);
  world.sectionsOutstanding.add('0,128,-16');
  assert.equal(ready(), false);
  world.sectionsOutstanding.delete('0,128,-16');
  camera.lookAt(0, 135, 32);
  assert.equal(ready(), false, 'Camera rotation changes the required meshes immediately');
  camera.position.set(0, -40, 0);
  camera.lookAt(0, -40, -16);
  world.sectionsOutstanding = new Set(['0,-48,-16']);
  assert.equal(ready(), false);
  camera.position.set(0, 312, 0);
  camera.lookAt(0, 312, -16);
  world.sectionsOutstanding = new Set(['0,304,-16']);
  assert.equal(ready(), false);
  camera.fov = 90; camera.updateProjectionMatrix();
  camera.position.set(-0.2, 8, 0); camera.lookAt(-0.2, 8, -16);
  world.sectionsOutstanding = new Set(['16,0,-16']);
  assert.equal(ready(0), true);
  assert.equal(ready(), false, 'Rotated model overhang just outside the frustum must be included');
});

test('wide diagonal views stay within radial coverage, and a teleport cannot capture old manifest columns', () => {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 48);
  camera.position.set(15.9, 135, 15.9);
  camera.lookAt(-0.1, 135, -0.1);
  const world = { loadedChunks: {}, sectionsOutstanding: new Set(['-64,128,-32']) };
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) world.loadedChunks[`${x * 16},${z * 16}`] = true;
  const viewer = { camera, world };
  assert.equal(visibleSectionsReady(viewer, THREE, 0.425, 44), true, 'Fully fogged distant sections need not finish');
  world.sectionsOutstanding = new Set(['-32,128,-16']);
  assert.equal(visibleSectionsReady(viewer, THREE, 0.425, 44), false);
  world.sectionsOutstanding.clear();
  camera.position.set(160, 135, 160);
  camera.lookAt(144, 135, 144);
  assert.equal(visibleSectionsReady(viewer, THREE, 0.425, 44), false, 'The old manifest can be complete while the new camera area is absent');
  for (let x = 7; x <= 13; x++) for (let z = 7; z <= 13; z++) world.loadedChunks[`${x * 16},${z * 16}`] = true;
  assert.equal(visibleSectionsReady(viewer, THREE, 0.425, 44), true);
  const shader = radialFogVertex(THREE.ShaderChunk.fog_vertex);
  assert.match(shader, /#ifdef USE_FOG/);
  assert.match(shader, /fogDepth = length\(mvPosition.xyz\)/);
  assert.throws(() => radialFogVertex('changed shader'), /integration changed/);
});

test('client integration updates camera before culling and exports only after rendering', () => {
  const source = 'this.world=new a(this.scene);const u=new r(l);u.setFirstPersonCamera(t,r,o);u.update(),l.render(u.scene,u.camera)';
  const result = patchViewerClient(source, createCameraMotion.toString());
  assert.match(result, /this.world=new a\(this.scene,1\)/);
  assert.ok(result.indexOf('u.update()') < result.indexOf('roycraftVisibleSectionsReady'));
  assert.ok(result.indexOf('l.render(u.scene,u.camera)') < result.indexOf('roycraftFrameRendered(l)'));
  assert.match(result, /roycraftMotion.receive/);
  assert.throws(() => patchViewerClient('changed upstream'), /integration changed/);
});
