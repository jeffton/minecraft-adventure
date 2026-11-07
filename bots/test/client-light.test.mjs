import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createClientRelighter } from '../client-light.mjs';

const require = createRequire(`${process.env.MINDCRAFT_ROOT || '/opt/minecraft-mindcraft'}/package.json`);
const registry = require('prismarine-registry')('1.21.4');
const Chunk = require('prismarine-chunk')(registry);
const Block = require('prismarine-block')(registry);
const { Vec3 } = require('vec3');
const air = registry.blocksByName.air.defaultState;
const stone = registry.blocksByName.stone.defaultState;
const torch = registry.blocksByName.torch.defaultState;

function stateId(name, properties = {}) {
  const definition = registry.blocksByName[name];
  for (let id = definition.minStateId; id <= definition.maxStateId; id++) {
    const props = Block.fromStateId(id, 0).getProperties();
    if (Object.entries(properties).every(([key, value]) => props[key] === value)) return id;
  }
  throw new Error(`No state for ${name} ${JSON.stringify(properties)}`);
}

function fixture(keys = ['0,0'], sky = true, solid = false) {
  const columns = new Map(keys.map(key => [key, new Chunk({ minY: -64, worldHeight: 384 })]));
  if (solid) {
    for (const column of columns.values()) column.initialize(() => ({ stateId: stone }));
  }
  const bot = {
    registry,
    game: { minY: -64, height: 384, dimension: sky ? 'overworld' : 'the_nether' },
    world: { getColumn: (x, z) => columns.get(`${x},${z}`) }
  };
  const { relight } = createClientRelighter(bot, { hasSkylight: () => bot.game.dimension === 'overworld' });
  const columnAt = p => columns.get(`${p.x >> 4},${p.z >> 4}`);
  const local = p => new Vec3(p.x & 15, p.y, p.z & 15);
  function put(p, id) { columnAt(p).setBlockStateId(local(p), id); }
  function edit(p, id) {
    const column = columnAt(p);
    const before = column.getBlock(local(p));
    before.position = p;
    put(p, id);
    const after = column.getBlock(local(p));
    after.position = p;
    return relight(before, after);
  }
  return {
    columns, bot, put, edit,
    block: p => columnAt(p).getBlockLight(local(p)),
    sky: p => columnAt(p).getSkyLight(local(p)),
    setSky: (p, value) => columnAt(p).setSkyLight(local(p), value),
    setBlock: (p, value) => columnAt(p).setBlockLight(local(p), value)
  };
}

test('torch insertion/removal relights real chunks across negative boundaries and sections', () => {
  const f = fixture(['-1,0', '0,0']);
  const p = new Vec3(-1, -1, 8);
  const changes = f.edit(p, torch);
  assert.equal(f.block(p), 14);
  assert.equal(f.block(new Vec3(0, 0, 8)), 12);
  assert(changes.get('-16,0').has(-16));
  assert(changes.get('0,0').has(0));
  f.edit(p, air);
  for (const column of f.columns.values()) {
    for (const section of column.blockLightSections) {
      if (section) for (let index = 0; index < 4096; index++) assert.equal(section.get(index), 0);
    }
  }
});

test('removing one source preserves the other source and clears its old contribution', () => {
  const f = fixture();
  const left = new Vec3(3, 64, 8); const right = new Vec3(11, 64, 8);
  f.edit(left, torch);
  f.edit(right, torch);
  f.edit(left, air);
  assert.equal(f.block(right), 14);
  assert.equal(f.block(left), 6);
  assert.equal(f.block(new Vec3(0, 64, 8)), 3);
});

test('mining and closing a roof updates direct skylight and sideways attenuated light', () => {
  const f = fixture(['0,0'], true, true);
  for (let y = 71; y < 320; y++) {
    const p = new Vec3(8, y, 8);
    f.put(p, air);
    f.setSky(p, 15);
  }
  for (let y = 64; y < 70; y++) f.put(new Vec3(8, y, 8), air);
  f.put(new Vec3(9, 68, 8), air);
  const roof = new Vec3(8, 70, 8);
  f.edit(roof, air);
  assert.equal(f.sky(new Vec3(8, 68, 8)), 15);
  assert.equal(f.sky(new Vec3(9, 68, 8)), 14);
  f.edit(roof, stone);
  assert.equal(f.sky(roof), 0);
  assert.equal(f.sky(new Vec3(8, 68, 8)), 0);
  assert.equal(f.sky(new Vec3(9, 68, 8)), 0);
  assert.equal(f.sky(new Vec3(8, 71, 8)), 15);
});

test('stair excavation matches server-NBT reference levels without relighting untouched columns', () => {
  // Synthetic geometry for the independently captured Paper/Mineflayer mismatch;
  // no saved world data is required. Twenty-two newly dug cells were stale at 0.
  const f = fixture(['7,-8'], true, true);
  for (const [x, light] of [[122, 14], [123, 13], [124, 12]]) {
    const p = new Vec3(x, 71, -126);
    f.put(p, air);
    f.setSky(p, light);
  }
  const rows = [
    [70, [122, 123]], [69, [121, 122, 123]], [68, [120, 121, 122]],
    [67, [119, 120, 121]], [66, [118, 119, 120]],
    [65, [115, 116, 117, 118, 119]], [64, [116, 117, 118]]
  ];
  for (const [y, xs] of rows) for (const x of xs) f.edit(new Vec3(x, y, -126), air);
  for (const [y, xs] of rows) {
    for (const x of xs) assert.equal(f.sky(new Vec3(x, y, -126)), 14 - Math.abs(x - 122) - (71 - y), `${x},${y},-126`);
  }
  assert.equal(f.sky(new Vec3(122, 68, -126)), 11);
  assert.equal(f.sky(new Vec3(118, 66, -126)), 5);
  assert.equal(f.sky(new Vec3(116, 64, -126)), 1);
});

test('emission-only torch edits leave authoritative skylight untouched', () => {
  const f = fixture();
  const p = new Vec3(8, 64, 8);
  f.setSky(p, 7);
  f.edit(p, torch);
  assert.equal(f.sky(p), 7);
  assert.equal(f.sky(p.offset(1, 0, 0)), 0);
  f.edit(p, air);
  assert.equal(f.sky(p), 7);
});

test('state-specific furnace/lamp emission works despite registry default emission zero', () => {
  const f = fixture();
  const p = new Vec3(8, 70, 8);
  f.edit(p, stateId('furnace', { lit: true, facing: 'north' }));
  assert.equal(f.block(p), 13);
  assert.equal(f.block(p.offset(1, 0, 0)), 12);
  f.edit(p, stateId('furnace', { lit: false, facing: 'north' }));
  assert.equal(f.block(p.offset(1, 0, 0)), 0);
  f.edit(p, stateId('redstone_lamp', { lit: true }));
  assert.equal(f.block(p.offset(1, 0, 0)), 14);
  f.edit(p, stateId('redstone_lamp', { lit: false }));
  assert.equal(f.block(p.offset(1, 0, 0)), 0);
});

test('both redstone ores emit only while lit and remove propagated light when extinguished', () => {
  for (const name of ['redstone_ore', 'deepslate_redstone_ore']) {
    const f = fixture();
    const p = new Vec3(8, 64, 8);
    f.edit(p, stateId(name, { lit: false }));
    assert.equal(f.block(p.offset(1, 0, 0)), 0, name);
    f.edit(p, stateId(name, { lit: true }));
    assert.equal(f.block(p), 9, name);
    assert.equal(f.block(p.offset(1, 0, 0)), 8, name);
    assert.equal(f.block(p.offset(3, 0, 0)), 6, name);
    f.edit(p, stateId(name, { lit: false }));
    assert.equal(f.block(p), 0, name);
    assert.equal(f.block(p.offset(3, 0, 0)), 0, name);
    f.edit(p, stateId(name, { lit: true }));
    f.edit(p, air);
    assert.equal(f.block(p.offset(1, 0, 0)), 0, name);
  }
});

test('glow lichen emits seven across attachment states and removes its light when mined', () => {
  const f = fixture();
  const p = new Vec3(8, 64, 8);
  f.edit(p, stateId('glow_lichen', { north: true, south: false, waterlogged: false }));
  assert.equal(f.block(p), 7);
  assert.equal(f.block(p.offset(1, 0, 0)), 6);
  f.edit(p, stateId('glow_lichen', { north: false, south: true, waterlogged: false }));
  assert.equal(f.block(p), 7);
  assert.equal(f.block(p.offset(1, 0, 0)), 6);
  f.edit(p, air);
  assert.equal(f.block(p), 0);
  assert.equal(f.block(p.offset(1, 0, 0)), 0);
});

test('missing columns/sections invent no sky and untouched authoritative light is retained', () => {
  const f = fixture();
  const p = new Vec3(0, 80, 0);
  f.put(p, stone);
  f.setSky(new Vec3(14, 200, 14), 7);
  f.setBlock(new Vec3(14, 200, 14), 4);
  f.edit(p, air);
  assert.equal(f.sky(p), 0);
  assert.equal(f.sky(p.offset(0, -1, 0)), 0);
  assert.equal(f.sky(new Vec3(14, 200, 14)), 7);
  assert.equal(f.block(new Vec3(14, 200, 14)), 4);
  assert.equal(f.columns.size, 1);
});

test('dimension skylight is explicit, dynamic, and no sky is introduced in Nether or End', () => {
  const f = fixture(['0,0'], false);
  const top = new Vec3(8, 319, 8);
  f.put(top, stone);
  f.edit(top, air);
  assert.equal(f.sky(top), 0);
  f.bot.game.dimension = 'the_end';
  f.edit(top, stone);
  f.edit(top, air);
  assert.equal(f.sky(top), 0);
  f.bot.game.dimension = 'overworld';
  f.edit(top, stone);
  f.edit(top, air);
  assert.equal(f.sky(top), 15);
  assert.equal(f.sky(top.offset(0, -1, 0)), 15);
});

test('removal preserves independent skylight entering neighbouring top-layer water', () => {
  const f = fixture(['0,0'], true, true);
  const roof = new Vec3(8, 319, 8); const water = roof.offset(1, 0, 0);
  f.put(roof, air);
  f.setSky(roof, 15);
  f.put(water, registry.blocksByName.water.defaultState);
  f.setSky(water, 14);
  f.edit(roof, stone);
  assert.equal(f.sky(roof), 0);
  assert.equal(f.sky(water), 14);
});

test('server light replacing a locally computed value is read on the next edit', () => {
  const f = fixture();
  const p = new Vec3(8, 64, 8);
  f.put(p, stone);
  f.setSky(p.offset(0, 1, 0), 11);
  f.edit(p, air);
  assert.equal(f.sky(p), 10);
  // Authoritative packet changes the seed without any engine cache to invalidate.
  for (const section of f.columns.get('0,0').skyLightSections) {
    if (section) for (let i = 0; i < 4096; i++) section.set(i, 0);
  }
  f.setSky(p.offset(0, 1, 0), 6);
  f.edit(p, stone);
  f.edit(p, air);
  assert.equal(f.sky(p), 5);
});

test('opposing half slabs jointly occlude a face without blocking matching halves', () => {
  const f = fixture(['0,0'], false, true);
  for (let x = 6; x <= 10; x++) f.put(new Vec3(x, 64, 8), air);
  const a = new Vec3(7, 64, 8); const b = new Vec3(8, 64, 8);
  const bottom = stateId('oak_slab', { type: 'bottom', waterlogged: false });
  const top = stateId('oak_slab', { type: 'top', waterlogged: false });
  f.edit(a, bottom);
  f.edit(b, bottom);
  f.edit(new Vec3(6, 64, 8), torch);
  assert.equal(f.block(new Vec3(9, 64, 8)), 11);
  f.edit(a, top);
  assert.equal(f.block(b), 0);
  assert.equal(f.block(new Vec3(9, 64, 8)), 0);
  f.edit(a, bottom);
  assert.equal(f.block(new Vec3(9, 64, 8)), 11);
});

test('slabs seal their full face, glass transmits, and water attenuates', () => {
  const f = fixture(['0,0'], false, true);
  const p = new Vec3(8, 64, 8);
  for (let y = 62; y <= 66; y++) f.put(new Vec3(8, y, 8), air);
  f.edit(p.offset(0, 1, 0), torch);
  f.edit(p, stateId('oak_slab', { type: 'bottom', waterlogged: false }));
  assert.equal(f.block(p), 13);
  assert.equal(f.block(p.offset(0, -1, 0)), 0);
  f.edit(p, registry.blocksByName.glass.defaultState);
  assert.equal(f.block(p.offset(0, -1, 0)), 12);
  f.edit(p, registry.blocksByName.water.defaultState);
  assert.equal(f.block(p.offset(0, -1, 0)), 12);
  f.edit(p, stateId('oak_slab', { type: 'double', waterlogged: false }));
  assert.equal(f.block(p), 0);
  assert.equal(f.block(p.offset(0, -1, 0)), 0);
});
