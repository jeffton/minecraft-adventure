import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lodgeBlueprint, matchesLodgeMaterial, lodgeMaterialItem, validHome } from '../blueprint.mjs';

// Isolate the actual build loop from the installed Mindcraft runtime and live state.
const source = readFileSync(new URL('../extensions.mjs', import.meta.url), 'utf8');
const buildSource = source.slice(source.indexOf('async function buildLodge('), source.indexOf('\nexport function registerAdventure'));
class Vec3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
}
function builder(plan, skills, writes = []) {
  return Function('lodgeBlueprint', 'matching', 'lodgeMaterialItem', 'validHome', 'getHome', 'Vec3', 'skills', 'existsSync', 'join', 'CONTROL', 'atomicJson', `${buildSource}; return buildLodge;`)(
    () => plan, matchesLodgeMaterial, lodgeMaterialItem, validHome,
    () => ({ x: 0, y: 64, z: 0, dimension: 'overworld' }), Vec3, skills,
    () => false, (...parts) => parts.join('/'), '/isolated', (...args) => writes.push(args)
  );
}

test('wood roles accept real tree families, not unrelated blocks or items', () => {
  for (const [material, blocks] of [
    ['oak_planks', ['oak_planks', 'acacia_planks', 'pale_oak_planks', 'bamboo_planks', 'warped_planks']],
    ['oak_log', ['oak_wood', 'acacia_log', 'stripped_spruce_wood', 'crimson_stem', 'warped_hyphae', 'bamboo_block']],
    ['oak_door', ['oak_door', 'acacia_door', 'bamboo_door', 'crimson_door']]
  ]) for (const block of blocks) assert.ok(matchesLodgeMaterial(block, material), block);
  for (const block of ['oak_slab', 'acacia_stairs', 'stone', 'fake_planks', undefined]) {
    assert.equal(matchesLodgeMaterial(block, 'oak_planks'), false);
  }
  assert.equal(matchesLodgeMaterial('iron_door', 'oak_door'), false);
  assert.equal(matchesLodgeMaterial('acacia_planks', 'cobblestone'), false);
  assert.equal(lodgeMaterialItem([{ name: 'acacia_planks', count: 25 }], 'oak_planks').name, 'acacia_planks');
});

test('an earned acacia batch places actual inventory while preserving existing oak parts', async () => {
  const plan = lodgeBlueprint().filter(step => step.material === 'oak_planks').slice(0, 10);
  const key = p => `${p.x},${p.y},${p.z}`;
  const first = plan[0];
  const world = new Map([[`${first.x},${64 + first.y},${first.z}`, 'oak_planks']]);
  const inventory = [{ name: 'acacia_planks', count: 25 }];
  const events = [];
  const placements = [];
  const bot = {
    game: { dimension: 'overworld' }, health: 20,
    entity: { position: { distanceTo: () => 0 } },
    inventory: { items: () => inventory },
    blockAt: p => ({ name: world.get(key(p)) ?? 'air', boundingBox: world.has(key(p)) ? 'block' : 'empty' })
  };
  const build = builder(plan, { placeBlock: async (bot, name, x, y, z) => {
    assert.equal(name, 'acacia_planks');
    placements.push(`${x},${y},${z}`);
    inventory[0].count--;
    world.set(`${x},${y},${z}`, name);
    return true;
  } });
  const result = await build({ name: 'Roy', bot, adventure: { emit: (...args) => events.push(args) } });
  assert.equal(result.placed, 8);
  assert.equal(result.complete, false);
  assert.equal(inventory[0].count, 17);
  assert.ok(!placements.includes(`${first.x},${64 + first.y},${first.z}`));
  assert.equal(events.length, 8);
  assert.ok(events.every(event => event[2].verified && event[2].material === 'acacia_planks'));
  const finished = await build({ name: 'Roy', bot });
  assert.equal(finished.placed, 1);
  assert.equal(finished.complete, true);
});

test('mixed-family existing lodge is complete without replacing any block', async () => {
  const plan = lodgeBlueprint();
  const world = new Map(plan.map(step => [
    `${step.x},${64 + step.y},${step.z}`,
    ({ oak_planks: 'acacia_planks', oak_log: 'spruce_log', oak_door: 'birch_door' })[step.material] ?? step.material
  ]));
  const build = builder(plan, { placeBlock: () => assert.fail('must preserve existing compatible blocks') });
  const result = await build({ name: 'Roy', bot: {
    game: { dimension: 'overworld' }, health: 20,
    entity: { position: { distanceTo: () => 0 } },
    inventory: { items: () => [] },
    blockAt: p => ({ name: world.get(`${p.x},${p.y},${p.z}`), boundingBox: 'block' })
  } });
  assert.equal(result.complete, true);
  assert.equal(result.placed, 0);
});
