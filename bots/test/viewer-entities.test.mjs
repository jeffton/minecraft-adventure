import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { viewerEntityModel, patchViewerEntities } from '../viewer-entities.mjs';

const root = process.env.MINDCRAFT_ROOT || '/opt/minecraft-mindcraft';
const require = createRequire(`${root}/package.json`);
const viewer = `${root}/node_modules/prismarine-viewer`;
const models = JSON.parse(fs.readFileSync(`${viewer}/viewer/lib/entity/entities.json`, 'utf8'));

function verifyTextures(model) {
  for (const name of Object.keys(model.geometry)) {
    const texture = model.textures[name];
    assert.ok(texture, `Missing texture for ${model.identifier}/${name}`);
    const file = `${viewer}/public/${texture.replace('textures', 'textures/1.16.4')}.png`;
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG', file);
  }
}

test('trader llama has real upstream llama geometry and distinct merchant decor; names survive', () => {
  const before = JSON.stringify(models.llama);
  for (const name of ['llama', 'trader_llama']) {
    const model = viewerEntityModel(models, name);
    verifyTextures(model);
    assert.equal(model.identifier, `minecraft:${name}`);
    assert.ok(model.geometry.default.bones.find(bone => bone.name === 'head').cubes.length);
  }
  const trader = viewerEntityModel(models, 'trader_llama');
  assert.match(trader.textures.decor, /trader_llama$/);
  assert.notDeepEqual(trader.geometry.decor, trader.geometry.default);
  assert.equal(JSON.stringify(models.llama), before, 'Shared upstream registry must stay unchanged');
});

test('base skins and modern wooden boats resolve to real installed textures', () => {
  for (const name of ['cat', 'donkey', 'fox', 'horse', 'mule', 'ocelot', 'parrot', 'rabbit', 'shulker',
    'skeleton_horse', 'zombie_horse', 'villager', 'zombie_villager',
    'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat', 'acacia_boat', 'dark_oak_boat']) {
    verifyTextures(viewerEntityModel(models, name));
  }
  const horse = viewerEntityModel(models, 'horse');
  assert.ok(horse.geometry.default.bones.some(bone => bone.name === 'Body' && bone.cubes.length));
  assert.ok(horse.geometry.default.bones.filter(bone => /^(MuleEar|Bag|Saddle|HeadSaddle)/.test(bone.name)).every(bone => bone.cubes.length === 0), 'Name-only horse must not invent donkey ears, chests or saddles');
  assert.equal(viewerEntityModel(models, 'cow'), models.cow);
  for (const name of ['oak_chest_boat', 'bamboo_raft', 'armadillo', 'camel']) {
    assert.equal(viewerEntityModel(models, name), undefined, 'Do not disguise unsupported species');
  }
});

test('patched real bundle compiles and its injected selector instantiates a textured llama mesh', () => {
  const bundle = fs.readFileSync(`${viewer}/public/index.js`, 'utf8');
  new vm.Script(patchViewerEntities(bundle, viewerEntityModel.toString()));
  assert.throws(() => patchViewerEntities('changed upstream'), /integration changed/);
  const start = bundle.indexOf('const r=n[e];if(!r)throw new Error(`Unknown entity ${e}`);');
  const patchedSelector = patchViewerEntities(bundle.slice(start, start + 'const r=n[e];if(!r)throw new Error(`Unknown entity ${e}`);'.length) + ';function texture(t,h){t.wrapT=THREE.RepeatWrapping,h.map=t}', viewerEntityModel.toString());
  const sandbox = { n: models, e: 'trader_llama' };
  vm.runInNewContext(`${patchedSelector};this.selected=r`, sandbox);
  const entitySource = fs.readFileSync(`${viewer}/viewer/lib/entity/Entity.js`, 'utf8');
  const textures = [];
  const context = {
    THREE: require('three'), module: { exports: {} },
    require(name) {
      if (name === './entities.json') return { trader_llama: sandbox.selected };
      if (name === '../utils') return { loadTexture(path, apply) { textures.push(path); apply({}); } };
      throw new Error(`Unexpected require ${name}`);
    }
  };
  vm.runInNewContext(entitySource, context);
  const entity = new context.module.exports('1.16.4', 'trader_llama', {});
  assert.equal(entity.mesh.children.length, 2);
  for (const mesh of entity.mesh.children) {
    assert.ok(mesh.geometry.attributes.position.count > 0);
    assert.ok(mesh.material.map);
  }
  assert.equal(textures.length, 2);
  assert.match(textures[1], /decor\/trader_llama.png$/);
});
