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
