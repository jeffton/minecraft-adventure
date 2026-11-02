import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { applyViewerDaylight, patchViewerClient, readyScript } from '../viewer-readiness.mjs';
import { viewerState, createCameraMotion } from '../viewer-stream.mjs';
import { readFileSync } from 'node:fs';
import { minecraftLighting } from '../viewer-lightmap.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const THREE = require('three');

function viewer() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('lightblue');
  scene.fog = new THREE.Fog(scene.background, 24, 44);
  return { scene, ambientLight: new THREE.AmbientLight(0xcccccc), directionalLight: new THREE.DirectionalLight(0xffffff, 0.5) };
}

test('server time drives sky, fog and terrain/entity lighting through sunset, night and sunrise', () => {
  const v = viewer();
  const samples = [6000, 12500, 18000, 23500, 6000].map(timeOfDay => {
    applyViewerDaylight(v, { time: { timeOfDay }, dimension: 'overworld' }, minecraftLighting);
    assert.ok(v.scene.fog.color.toArray().every(channel => channel >= 0 && channel <= 1));
    return { sky: v.scene.background.clone(), ambient: v.ambientLight.intensity, sun: v.directionalLight.intensity };
  });
  assert.ok(samples[0].ambient > samples[1].ambient);
  assert.ok(samples[1].ambient > samples[2].ambient);
  assert.ok(samples[2].ambient < samples[3].ambient);
  assert.ok(samples[3].ambient < samples[4].ambient);
  assert.ok(samples[0].sun > samples[2].sun);
  assert.ok(samples[0].sky.b > samples[2].sky.b * 10);
  applyViewerDaylight(v, { time: { timeOfDay: 18000 }, dimension: 'the_nether' }, minecraftLighting);
  assert.equal(v.ambientLight.intensity, samples[0].ambient, 'A dimension change must not retain overworld night');
});

test('production bundle consumes live time and injected daylight helper without rebuilding upstream', () => {
  const source = readFileSync('/opt/minecraft-mindcraft/node_modules/prismarine-viewer/public/index.js', 'utf8');
  const patched = patchViewerClient(source, createCameraMotion.toString());
  assert.match(patched, /roycraftState=s;window.roycraftApplyDaylight\(u,s\)/);
  assert.match(readyScript, /roycraftLighting = \(function minecraftLighting/);
  assert.match(readyScript, /roycraftApplyDaylight = \(viewer, state\)/);
  new Function(patched);
});

test('read-only socket state includes the observed time and dimension, not a local wall clock', () => {
  const bot = {
    username: 'Roy', _client: { state: 'play' }, health: 20, food: 20,
    time: { timeOfDay: 18000, isDay: false }, game: { dimension: 'overworld' },
    inventory: { slots: [], items: () => [] },
    entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  };
  assert.deepEqual(viewerState(bot, 'mining').time, { timeOfDay: 18000, isDay: false });
  assert.equal(viewerState(bot, 'mining').dimension, 'overworld');
});
