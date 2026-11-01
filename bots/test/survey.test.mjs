import test from 'node:test';
import assert from 'node:assert/strict';
import { surveySurroundings } from '../runtime.mjs';

class Position {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
  offset(x, y, z) { return new Position(this.x + x, this.y + y, this.z + z); }
  distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); }
}

test('surveys report actual loaded resource coordinates and omit unobserved terrain', () => {
  const tree = new Position(50, 62, 0);
  const bot = {
    game: { dimension: 'overworld' },
    entity: { position: new Position(0, 64, 0) },
    registry: { blocksByName: { oak_log: { id: 1 }, coal_ore: { id: 2 }, iron_ore: { id: 3 } }, biomes: { 1: { name: 'meadow' } } },
    findBlocks: options => options.matching.includes(1) ? [tree] : [],
    blockAt: pos => pos === tree ? { name: 'oak_log', boundingBox: 'block' } : null,
    world: { getBiome: () => 1 },
    entities: { cow: { name: 'cow', position: new Position(25, 60, 1) }, zombie: { name: 'zombie', position: new Position(1, 64, 0) } }
  };
  const observed = surveySurroundings(bot);
  assert.equal(observed.biome, 'meadow');
  assert.deepEqual(observed.nearbyResources.wood, [{ name: 'oak_log', x: 50, y: 62, z: 0, distance: 50 }]);
  assert.deepEqual(observed.nearbyResources.iron, []);
  assert.equal(observed.nearbyResources.food[0].name, 'cow');
  assert.equal(observed.nearbyResources.food.length, 1);
  assert.deepEqual(observed.terrain, [], 'unloaded space is not presented as a safe walking surface');
});

test('base survey reports actual loaded chest and bed coordinates, never inferred contents or spawn', () => {
  const home = { x: 0, y: 64, z: 0, dimension: 'overworld' };
  const chest = new Position(1, 64, 7);
  const foot = new Position(2, 64, 5);
  const outside = new Position(30, 64, 5);
  const blocks = new Map([
    [chest, { name: 'chest', position: chest, getProperties: () => ({ type: 'single' }) }],
    [foot, { name: 'white_bed', position: foot, getProperties: () => ({ part: 'foot', facing: 'north', occupied: false }) }],
    [outside, { name: 'white_bed', position: outside, getProperties: () => ({ part: 'foot', facing: 'north' }) }]
  ]);
  const bot = {
    entity: { position: new Position(0, 64, 0) }, game: { dimension: 'overworld' },
    registry: { blocksByName: { chest: { id: 1 }, white_bed: { id: 2 } }, biomes: { 1: { name: 'plains' } } },
    findBlocks: options => options.matching.includes(1) ? [chest, foot, outside] : [],
    blockAt: pos => blocks.get(pos) ?? null,
    world: { getBiome: () => 1 }, entities: {}
  };
  const observed = surveySurroundings(bot, home);
  assert.deepEqual(observed.baseBlocks, [
    { name: 'chest', x: 1, y: 64, z: 7, properties: { type: 'single' } },
    { name: 'white_bed', x: 2, y: 64, z: 5, properties: { part: 'foot', facing: 'north', occupied: false } }
  ]);
  assert.ok(observed.baseBlocks.every(block => !Object.hasOwn(block, 'contents') && !Object.hasOwn(block, 'spawnConfirmed')));
  bot.game.dimension = 'the_nether';
  assert.deepEqual(surveySurroundings(bot, home).baseBlocks, []);
});

test('wool survey distinguishes actual adult unsheared sheep colors from unknown metadata', () => {
  const bot = {
    entity: { position: new Position(0, 64, 0) },
    registry: { blocksByName: {}, biomes: { 1: { name: 'plains' } }, entitiesByName: { sheep: { metadataKeys: ['baby', 'wool'] } } },
    findBlocks: () => [], blockAt: () => null, world: { getBiome: () => 1 },
    entities: {
      gray: { name: 'sheep', metadata: [false, 7], position: new Position(3, 64, 0) },
      sheared: { name: 'sheep', metadata: [false, 16], position: new Position(1, 64, 0) },
      baby: { name: 'sheep', metadata: [true, 0], position: new Position(2, 64, 0) },
      unknown: { name: 'sheep', position: new Position(2, 64, 0) }
    }
  };
  assert.deepEqual(surveySurroundings(bot, null).nearbyResources.wool, [{ item: 'gray_wool', x: 3, y: 64, z: 0 }]);
});
