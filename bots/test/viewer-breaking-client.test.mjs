import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createViewerBreakingClient, patchViewerBreakingClient } from '../viewer-breaking-client.mjs';

function fixture() {
  const resources = { geometries: [], materials: [], textures: [] };
  class Position {
    set(x, y, z) { Object.assign(this, { x, y, z }); }
  }
  class Group {
    constructor() { this.position = new Position(); this.children = []; }
    add(child) { this.children.push(child); }
    remove(child) { this.children.splice(this.children.indexOf(child), 1); }
  }
  class BoxGeometry {
    constructor(...dimensions) { this.dimensions = dimensions; this.disposals = 0; resources.geometries.push(this); }
    dispose() { this.disposals++; }
  }
  class MeshBasicMaterial {
    constructor(options) { Object.assign(this, options); this.disposals = 0; resources.materials.push(this); }
    dispose() { this.disposals++; }
  }
  class TextureLoader {
    load(url) {
      const map = { url, disposals: 0, dispose() { this.disposals++; } };
      resources.textures.push(map);
      return map;
    }
  }
  class Mesh {
    constructor(geometry, material) { Object.assign(this, { geometry, material, position: new Position() }); }
  }
  const THREE = { Group, BoxGeometry, MeshBasicMaterial, TextureLoader, Mesh, MultiplyBlending: 4, NearestFilter: 1003 };
  const socket = new EventEmitter();
  const lifecycle = new EventTarget();
  const viewer = { scene: new Group() };
  const client = createViewerBreakingClient(viewer, socket, THREE, lifecycle);
  const emit = event => socket.emit('adventureBreaking', event);
  return { resources, viewer, socket, lifecycle, client, emit, THREE };
}

const cube = [[0, 0, 0, 1, 1, 1]];
const event = (id, x = 0) => ({ id, position: { x, y: 64, z: 0 }, stage: 0, shapes: cube });

test('actual shapes receive stage textures and stage updates reuse geometry/material', () => {
  const { emit, viewer, resources, THREE } = fixture();
  const message = { ...event(1, 10), shapes: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0.5, 1, 1, 1]] };
  emit(message);
  const group = viewer.scene.children[0];
  assert.deepEqual({ ...group.position }, { x: 10, y: 64, z: 0 });
  assert.equal(group.children.length, 2);
  assert.deepEqual(group.children[0].geometry.dimensions, [1.002, 0.502, 1.002]);
  assert.deepEqual({ ...group.children[1].position }, { x: 0.5, y: 0.75, z: 0.75 });
  const material = resources.materials[0];
  assert.equal(material.depthWrite, false);
  assert.equal(material.blending, THREE.MultiplyBlending);
  assert.equal(material.polygonOffsetFactor, -1);
  assert.equal(material.map.magFilter, THREE.NearestFilter);
  assert.equal(new URL(material.map.url, 'https://minecraft.roybot.se/live/').pathname, '/live/textures/1.21.4/blocks/destroy_stage_0.png');
  emit({ ...message, stage: 9 });
  assert.equal(viewer.scene.children[0], group);
  assert.equal(resources.geometries.length, 2);
  assert.equal(resources.materials.length, 1);
  assert.match(material.map.url, /destroy_stage_9\.png$/);
  emit({ ...message, stage: 0 });
  assert.equal(resources.textures.length, 2, 'Loaded stages are cached');
  emit({ id: 1, stage: -1 });
  assert.equal(viewer.scene.children.length, 0);
  assert.ok(resources.geometries.every(g => g.disposals === 1));
  assert.equal(material.disposals, 1, 'Shared shape material is disposed once');
  assert.ok(resources.textures.every(t => t.disposals === 0), 'Textures survive overlay removal');
});

test('same miner changing target or shape replaces and disposes the previous overlay', () => {
  const { emit, viewer, resources } = fixture();
  emit(event('miner'));
  emit(event('miner', 1));
  assert.equal(resources.geometries[0].disposals, 1);
  assert.equal(resources.materials[0].disposals, 1);
  assert.equal(viewer.scene.children.length, 1);
  emit({ ...event('miner', 1), shapes: [[0, 0, 0, 1, 0.5, 1]] });
  assert.equal(resources.geometries[1].disposals, 1);
  assert.equal(resources.materials[1].disposals, 1);
});

test('block updates remove all matching miners and chunk unload handles negative block origins', () => {
  const { emit, viewer, socket, resources } = fixture();
  emit(event(1, -1));
  emit(event(2, -1));
  emit(event(3, 16));
  socket.emit('blockUpdate', { pos: { x: 0, y: 64, z: 0 } });
  assert.equal(viewer.scene.children.length, 3);
  socket.emit('blockUpdate', { pos: { x: -1, y: 64, z: 0 } });
  assert.equal(viewer.scene.children.length, 1);
  emit(event(4, -17));
  socket.emit('unloadChunk', { x: -32, z: 0 });
  assert.equal(viewer.scene.children.length, 1);
  socket.emit('unloadChunk', { x: 16, z: 0 });
  assert.equal(viewer.scene.children.length, 0);
  assert.ok(resources.geometries.every(g => g.disposals === 1));
});

test('reset and disconnect clear overlays; pagehide disposes textures and removes hooks', () => {
  const { emit, viewer, socket, lifecycle, client, resources } = fixture();
  emit(event(1));
  emit({ reset: true });
  assert.equal(viewer.scene.children.length, 0);
  emit(event(2));
  socket.emit('disconnect');
  assert.equal(viewer.scene.children.length, 0);
  emit(event(3));
  lifecycle.dispatchEvent(new Event('pagehide'));
  assert.equal(viewer.scene.children.length, 0);
  assert.ok(resources.geometries.every(g => g.disposals === 1));
  assert.ok(resources.materials.every(m => m.disposals === 1));
  assert.ok(resources.textures.every(t => t.disposals === 1));
  for (const name of ['adventureBreaking', 'blockUpdate', 'unloadChunk', 'disconnect']) {
    assert.equal(socket.listenerCount(name), 0);
  }
  client.dispose();
  assert.ok(resources.textures.every(t => t.disposals === 1), 'Cleanup is idempotent');
});

test('back/forward cache restoration reattaches hooks and reloads disposed textures', () => {
  const { emit, socket, lifecycle, viewer, resources, client } = fixture();
  emit(event(1));
  lifecycle.dispatchEvent(new Event('pagehide'));
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  lifecycle.dispatchEvent(restored);
  emit(event(2));
  assert.equal(viewer.scene.children.length, 1);
  assert.equal(resources.textures.length, 2);
  assert.equal(resources.textures[0].disposals, 1);
  assert.equal(resources.textures[1].disposals, 0);
  assert.equal(socket.listenerCount('adventureBreaking'), 1);
  client.dispose();
  lifecycle.dispatchEvent(restored);
  assert.equal(socket.listenerCount('adventureBreaking'), 0);
});

test('installed bundle marker is unique, patch compiles and registers the tested scene hook', () => {
  const source = readFileSync('/opt/minecraft-mindcraft/node_modules/prismarine-viewer/public/index.js', 'utf8');
  // The route serializes the patch function; it must not capture module helpers.
  const serializedPatch = new Function(`return (${patchViewerBreakingClient.toString()})`)();
  const patched = serializedPatch(source, createViewerBreakingClient.toString());
  new Function(patched);
  assert.match(patched, /const u=new r\(l\);\(function createViewerBreakingClient/);
  assert.match(patched, /\)\(u,o,THREE\);/);
  assert.throws(() => patchViewerBreakingClient(''), /integration changed/);
  assert.throws(() => patchViewerBreakingClient('const u=new r(l);const u=new r(l);'), /integration changed/);
});
