import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorldKnowledge, registryInfo } from '../world-knowledge.mjs';
import { createMinecraftRpc } from '../rpc.mjs';

// Same installed Mineflayer dependency tree as the runtime. No surrogate registry.
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('minecraft-data')('1.21.4');
const { Recipe } = require('prismarine-recipe')('1.21.4');
const { Vec3 } = require('vec3');

function fixture(knowledge = createWorldKnowledge({ worldId: 'test-world' })) {
  const loaded = new Set(['0,64,0', '200,64,0']);
  const bot = {
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities: { 2: { id: 2, name: 'sheep', type: 'mob', position: new Vec3(2, 64, 0) } },
    inventory: { items: () => [] }, registry, game: { dimension: 'overworld' },
    blockAt(p) {
      if (!loaded.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)) return null;
      return { name: 'grass_block', type: registry.blocksByName.grass_block.id, position: p, biome: registry.biomesByName.plains };
    },
    findBlocks: () => [new Vec3(200, 64, 0)],
    recipesAll: id => Recipe.find(id, null)
  };
  return { bot, loaded, rpc: createMinecraftRpc(bot, { Vec3, goals: {}, knowledge }) };
}

test('real registry exposes reusable dependencies and semantics for beds and iron tools', async () => {
  const { rpc } = fixture();
  const beds = await rpc.call('recipesAll', ['white_bed']);
  assert.ok(beds.some(recipe => recipe.delta.some(item => item.name === 'white_wool' && item.count === -3)));
  assert.ok(beds.some(recipe => recipe.delta.some(item => item.name?.endsWith('_planks') && item.count === -3)));
  const plains = await rpc.call('registryInfo', ['biomes', { names: ['plains'] }]);
  assert.equal(plains.items[0].category, 'plains');
  const sheep = await rpc.call('registryInfo', ['entities', { names: ['sheep'] }]);
  assert.equal(sheep.items[0].type, 'animal');
  assert.equal(sheep.items[0].position, undefined);
  const iron = await rpc.call('registryInfo', ['blocks', { names: ['iron_ore'] }]);
  assert.ok(iron.items[0].drops.some(item => item.name === 'raw_iron'));
  assert.ok(iron.items[0].harvestTools.some(item => item.name === 'stone_pickaxe'));
  assert.ok(!iron.items[0].harvestTools.some(item => item.name === 'wooden_pickaxe'));
  const pickaxes = await rpc.call('recipesAll', ['iron_pickaxe']);
  assert.ok(pickaxes.some(recipe => recipe.delta.some(item => item.name === 'iron_ingot' && item.count === -3)));
  const furnace = await rpc.call('recipesAll', ['furnace']);
  assert.ok(furnace.some(recipe => recipe.delta.some(item => item.name === 'cobblestone' && item.count === -8)));
});

test('registry searches are bounded, explicit and cannot traverse prototype properties', () => {
  assert.equal(registryInfo(registry, 'items', { search: 'wool', limit: 2 }).items.length, 2);
  assert.equal(registryInfo(registry, 'items', { search: 'wool', limit: 2 }).truncated, true);
  assert.throws(() => registryInfo(registry, '__proto__', { names: ['plains'] }), /Registry type/);
  assert.throws(() => registryInfo(registry, 'items', { names: ['__proto__'] }), /Unknown/);
  assert.throws(() => registryInfo(registry, 'items', {}), /Provide/);
  assert.throws(() => registryInfo(registry, 'items', { search: 'ore', limit: 1000 }), /limit/);
});

test('loaded-only biome lookup records historical facts without revealing unknown terrain', async () => {
  const { rpc, bot, loaded } = fixture();
  rpc.observe();
  const here = await rpc.call('biomeAt', [{ x: 200, y: 64, z: 0 }]);
  assert.equal(here.name, 'plains');
  await assert.rejects(rpc.call('biomeAt', [{ x: 4000, y: 64, z: 0 }]), /not loaded/);
  loaded.clear();
  bot.entity.position = new Vec3(500, 64, 0);
  bot.entities = {};
  assert.equal(rpc.observe().biome, null);
  const known = await rpc.call('knownLocations', [{ kind: 'biome', names: ['plains'] }]);
  assert.equal(known.historical, true);
  assert.equal(known.locations.length, 2);
  assert.ok(known.locations.some(value => value.position.x === 200));
  assert.ok(!known.locations.some(value => value.position.x === 4000 || value.position.x === 500));
  assert.equal((await rpc.call('knownLocations', [{ kind: 'entity', names: ['sheep'] }])).locations.length, 1);
  bot.game.dimension = 'the_nether';
  assert.equal((await rpc.call('knownLocations', [{ dimension: 'the_nether' }])).locations.length, 0);
});

test('only actual block query results enter spatial memory beyond local observation radius', async () => {
  const { rpc } = fixture();
  await rpc.call('findBlocks', [{ names: ['grass_block'] }]);
  const found = await rpc.call('knownLocations', [{ kind: 'block', names: ['grass_block'] }]);
  assert.equal(found.locations.length, 1);
  assert.equal(found.locations[0].position.x, 200);
  assert.equal((await rpc.call('knownLocations', [{ kind: 'block', names: ['iron_ore'] }])).locations.length, 0);
});

test('failed persistence is surfaced and a later explicit flush retries the observation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roy-knowledge-retry-'));
  const directory = path.join(root, 'state');
  await writeFile(directory, 'blocks directory creation');
  const memory = createWorldKnowledge({ directory, worldId: 'retry' });
  memory.observe({ dimension: 'overworld', position: { x: 1, y: 64, z: 1 } });
  await assert.rejects(memory.flush(), /EEXIST/);
  await rename(directory, path.join(root, 'former-blocker'));
  await memory.flush();
  const reopened = createWorldKnowledge({ directory, worldId: 'retry' });
  assert.equal(reopened.locations().locations.length, 1);
});

test('spatial memory persists by world and dimension, coalesces cells, and bounds output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roy-knowledge-'));
  const memory = createWorldKnowledge({ directory, worldId: 'one' });
  memory.observe({ dimension: 'overworld', position: { x: 1, y: 64, z: 1 } });
  memory.observe({ dimension: 'overworld', position: { x: 2, y: 64, z: 2 } });
  memory.observe({ dimension: 'the_nether', position: { x: 2, y: 64, z: 2 } });
  await memory.flush();
  assert.equal(JSON.parse(await readFile(path.join(directory, 'world-knowledge.json'), 'utf8')).worldId, 'one');
  const reopened = createWorldKnowledge({ directory, worldId: 'one' });
  assert.equal(reopened.locations({ kind: 'visited' }).locations.length, 2);
  assert.equal(reopened.locations({ dimension: 'overworld' }).locations[0].position.x, 2);
  assert.equal(reopened.locations({ limit: 1 }).truncated, true);
  assert.throws(() => createWorldKnowledge({ directory, worldId: 'two' }), /mismatch/);
  const isolated = createWorldKnowledge({ worldId: 'two' });
  assert.deepEqual(isolated.locations().locations, []);
});
