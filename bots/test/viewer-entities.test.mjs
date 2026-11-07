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

test('Java atlases match legacy mob UV pixel dimensions and witch inherits her actual body', () => {
  for (const name of ['zombie', 'husk', 'sheep', 'llama_spit']) {
    const model = viewerEntityModel(models, name);
    for (const [variant, geometry] of Object.entries(model.geometry)) {
      const file = `${viewer}/public/${model.textures[variant].replace('textures', 'textures/1.16.4')}.png`;
      const png = fs.readFileSync(file);
      assert.equal(geometry.texturewidth ?? 64, png.readUInt32BE(16), `${name} width`);
      assert.equal(geometry.textureheight, png.readUInt32BE(20), `${name} height`);
    }
  }
  const before = JSON.stringify(models.witch);
  const witch = viewerEntityModel(models, 'witch').geometry.default;
  for (const name of ['body', 'head', 'arms', 'leg0', 'leg1', 'hat4']) {
    assert.ok(witch.bones.find(bone => bone.name === name)?.cubes.length, `Witch needs ${name}`);
  }
  assert.equal(witch.bones.find(bone => bone.name === 'nose').cubes.length, 2, 'Keep inherited nose plus witch wart');
  assert.equal(JSON.stringify(models.witch), before);
});

test('patched real bundle compiles and its injected selector instantiates a textured llama mesh', () => {
  const bundle = fs.readFileSync(`${viewer}/public/index.js`, 'utf8');
  const patched = patchViewerEntities(bundle, viewerEntityModel.toString());
  new vm.Script(patched);
  assert.throws(() => patchViewerEntities('changed upstream'), /integration changed/);
  const marker = '823:(t,e,i)=>{';
  const start = patched.indexOf(marker);
  const end = patched.indexOf(',1644:', start);
  assert.ok(start > 0 && end > start);
  const entitySource = `(${patched.slice(start + 4, end)})`;
  const textures = [];
  const context = {
    THREE: require('three'),
  };
  const module = { exports: {} };
  vm.runInNewContext(entitySource, context)(module, {}, id => {
    if (id === 628) return models;
    if (id === 2281) return { loadTexture(path, apply) { textures.push(path); apply({}); } };
    throw new Error(`Unexpected module ${id}`);
  });
  const entity = new module.exports('1.16.4', 'trader_llama', {});
  assert.equal(entity.mesh.children.length, 2);
  for (const mesh of entity.mesh.children) {
    assert.ok(mesh.geometry.attributes.position.count > 0);
    assert.ok(mesh.material.map);
  }
  assert.equal(textures.length, 2);
  assert.match(textures[1], /decor\/trader_llama.png$/);
  const witch = new module.exports('1.16.4', 'witch', {});
  assert.ok(witch.mesh.children.length > 0, 'The actual witch model must not throw and become a purple box');
});
