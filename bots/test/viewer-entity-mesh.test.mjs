import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { buildViewerEntity, disposeViewerEntity } from '../viewer-entity-mesh.mjs';
import { patchViewerEntities, viewerEntityModel } from '../viewer-entities.mjs';
import { viewerDroppedItem } from '../viewer-stream.mjs';

const root = process.env.MINDCRAFT_ROOT || '/opt/minecraft-mindcraft';
const require = createRequire(`${root}/package.json`);
const THREE = require('three');
const viewer = `${root}/node_modules/prismarine-viewer`;

function context() {
  // Synthetic triangle fixture, not Minecraft model data.
  const model = { texture: 'animal.png', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
  const requested = [];
  const window = { roycraftEntityAssets: { armadillo: model, goat: model, glow_squid: model }, roycraftItemAssets: { items: { coal: 'item-assets/coal.png' } } };
  const three = { ...THREE, TextureLoader: class {
    load(path) { requested.push(path); return new THREE.Texture(); }
  } };
  window.roycraftBuildEntity = vm.runInNewContext(`(${buildViewerEntity.toString()})`, { window });
  window.roycraftDisposeEntity = disposeViewerEntity;
  return { window, three, requested };
}

function moduleFrom(bundle, id, next, globals, dependency) {
  const marker = `${id}:(t,e,i)=>{`;
  const start = bundle.indexOf(marker);
  const end = bundle.indexOf(`,${next}:`, start);
  assert.ok(start > 0 && end > start);
  const module = { exports: {} };
  vm.runInNewContext(`(${bundle.slice(start + String(id).length + 1, end)})`, globals)(module, {}, dependency);
  return module.exports;
}

test('modern buffers, double-sided ears and atlas orientation are retained without aliasing species', () => {
  const { window, three } = context();
  for (const name of ['armadillo', 'goat', 'glow_squid']) {
    const model = window.roycraftBuildEntity({ name, pos: { x: 7, y: 90, z: -3 } }, three);
    assert.equal(model.userData.roycraftKind, name);
    assert.equal(model.position.y, 90);
    assert.equal(model.children[0].geometry.attributes.position.count, 3);
    assert.equal(model.children[0].material.side, THREE.DoubleSide);
    assert.equal(model.children[0].material.map.flipY, false);
    assert.equal(Boolean(model.children[0].material.isMeshBasicMaterial), name === 'glow_squid');
  }
});

test('actual upstream entity updates replace pending item metadata, refresh stack art and release custom meshes', () => {
  const { window, three, requested } = context();
  const bundle = patchViewerEntities(readFileSync(`${viewer}/public/index.js`, 'utf8'), viewerEntityModel.toString());
  const models = JSON.parse(readFileSync(`${viewer}/viewer/lib/entity/entities.json`, 'utf8'));
  const Entity = moduleFrom(bundle, 823, 1644, { THREE: three }, id => {
    if (id === 628) return models;
    if (id === 2281) return { loadTexture(path, apply) { apply(new THREE.Texture()); } };
    throw new Error(`Unexpected entity dependency ${id}`);
  });
  const { Entities } = moduleFrom(bundle, 8773, 823, { window }, id => {
    if (id === 8964) return three;
    if (id === 484) return { Tween: class {
      constructor(target) { this.target = target; }
      to(values) { Object.assign(this.target, values); return this; }
      start() { return this; }
    } };
    if (id === 823) return Entity;
    if (id === 9505) return { dispose3() {} };
    if (id === 7793) return { createCanvas() { throw new Error('Unexpected name tag'); } };
    throw new Error(`Unexpected mesh dependency ${id}`);
  });
  const scene = new THREE.Scene();
  const entities = new Entities(scene);
  const packet = { id: 7, name: 'item', pos: { x: 5, y: 70, z: 9 }, item: null };
  entities.update(packet);
  assert.equal(entities.entities[7].children.length, 0, 'Wait for actual stack metadata rather than inventing an item');
  entities.update({ ...packet, item: { name: 'coal', count: 3 } });
  const first = entities.entities[7];
  assert.equal(first.children.length, 2);
  assert.equal(first.children[0].isSprite, true);
  assert.equal(first.children[0].material.map.flipY, true, 'Ordinary PNG sprites must not be upside down');
  const texture = first.children[0].material.map;
  let materialDisposals = 0;
  let textureDisposals = 0;
  first.children[0].material.addEventListener('dispose', () => materialDisposals++);
  texture.addEventListener('dispose', () => textureDisposals++);
  entities.update({ ...packet, item: { name: 'coal', count: 19 } });
  assert.equal(entities.entities[7].children.length, 3);
  assert.equal(entities.entities[7].userData.itemKey, 'coal:19');
  assert.equal(entities.entities[7].position.x, 5, 'Metadata replacement must not tween the new item from world origin');
  assert.equal(materialDisposals, 1, 'A stack shares one disposable sprite material');
  assert.equal(textureDisposals, 0, 'Other stacks still use this texture');
  assert.deepEqual(requested, ['item-assets/coal.png']);
  entities.update({ id: 8, name: 'armadillo', pos: packet.pos });
  let geometryDisposals = 0;
  entities.entities[8].children[0].geometry.addEventListener('dispose', () => geometryDisposals++);
  entities.update({ id: 7, delete: true });
  assert.equal(entities.entities[7], undefined);
  entities.clear();
  assert.equal(scene.children.length, 0);
  assert.equal(geometryDisposals, 1);
});

test('real protocol item decoder is not called before metadata and never exposes item NBT', () => {
  const Entity = require('prismarine-entity')('1.21.4');
  const Item = require('prismarine-item')('1.21.4');
  const registry = require('minecraft-data')('1.21.4');
  const entity = new Entity(17);
  entity.name = 'item';
  const index = registry.supportFeature('metadataIxOfItem');
  assert.equal(viewerDroppedItem(entity, index).item, null);
  entity.metadata[index] = Item.toNotch(new Item(registry.itemsByName.coal.id, 7));
  assert.deepEqual(viewerDroppedItem(entity, index).item, { name: 'coal', count: 7 });
  assert.deepEqual(Object.keys(viewerDroppedItem(entity, index).item), ['name', 'count']);
});
