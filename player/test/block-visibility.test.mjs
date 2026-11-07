import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createBlockVisibility, PERCEPTION_VERSION } from '../block-visibility.mjs';
import { createMinecraftRpc } from '../rpc.mjs';
import { createWorldKnowledge } from '../world-knowledge.mjs';
import { planningObservation } from '../mission.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Vec3 } = require('vec3');
const data = require('minecraft-data')('1.21.4');
const Block = require('prismarine-block')('1.21.4');

function fixture() {
  const cells = new Map();
  const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const set = (p, name) => {
    const definition = data.blocksByName[name];
    let state = definition.defaultState;
    if (name === 'oak_door') {
      state = Array.from({ length: definition.maxStateId - definition.minStateId + 1 }, (_, i) => definition.minStateId + i)
        .find(id => { const p = Block.fromStateId(id, 0).getProperties(); return p.facing === 'east' && !p.open; });
    }
    const b = Block.fromStateId(state, 0);
    b.position = p.floored();
    cells.set(key(p), b);
    return b;
  };
  const bot = {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, entities: {},
    registry: data, game: { dimension: 'overworld' }, inventory: { items: () => [] },
    health: 20, food: 20, oxygenLevel: 20,
    blockAt: p => cells.get(key(p)) ?? Object.assign(Block.fromStateId(0, 0), { position: p.floored() }),
    pathfinder: { setGoal() {} }, stopDigging() {}, clearControlStates() {}, deactivateItem() {},
    dig: async b => { set(b.position, 'air'); },
  };
  const column = { minY: 64, sections: [{}], getBlockType: p => bot.blockAt(p).type };
  bot.world = { getColumns: () => [{ chunkX: 0, chunkZ: 0, column }], getColumn: () => column };
  const knowledge = createWorldKnowledge();
  const rpc = createMinecraftRpc(bot, { Vec3, goals: {}, knowledge });
  const visibility = createBlockVisibility(bot, Vec3);
  const wall = name => {
    for (let y = 63; y <= 68; y++) for (let z = -3; z <= 3; z++) set(new Vec3(1, y, z), name);
  };
  const ore = set(new Vec3(2, 64, 0), 'iron_ore');
  return { bot, rpc, cells, set, wall, ore, knowledge, ...visibility };
}

test('opaque cover hides ore from RPC reads, planner observations, searches and action oracles', async () => {
  const { rpc, wall, ore } = fixture();
  wall('stone');
  assert.equal(await rpc.call('blockAt', [ore.position]), null);
  assert.ok(!planningObservation(rpc.observe()).blocks.some(b => b.name === 'iron_ore'));
  assert.deepEqual(await rpc.call('findBlocks', [{ names: ['iron_ore'], count: 1 }]), []);
  for (const method of ['dig', 'harvest', 'activateBlock', 'openContainer', 'openFurnace', 'sleep', 'biomeAt']) {
    await assert.rejects(rpc.call(method, [ore.position]), /not visible/);
  }
  await assert.rejects(rpc.call('placeBlock', [ore.position, { x: 0, y: 1, z: 0 }]), /not visible/);
  assert.deepEqual((await rpc.call('knownLocations', [{ kind: 'block', names: ['iron_ore'] }])).locations, []);
});

test('digging exposed cover reveals ore, and only genuine sightings become historical knowledge', async () => {
  const { rpc, wall, ore, set, knowledge } = fixture();
  wall('stone');
  knowledge.observe({ dimension: 'overworld', blocks: [ore] });
  assert.equal((await rpc.call('knownLocations', [{ kind: 'block' }])).locations.length, 0, 'old X-ray records stay private');
  // Make a two-high opening with ordinary block digs, not a material scan.
  for (const y of [65, 64]) await rpc.call('dig', [new Vec3(1, y, 0)]);
  assert.equal((await rpc.call('blockAt', [ore.position])).name, 'iron_ore');
  assert.equal((await rpc.call('findBlocks', [{ names: ['iron_ore'], count: 1 }]))[0].name, 'iron_ore');
  set(new Vec3(1, 65, 0), 'stone');
  set(new Vec3(1, 64, 0), 'stone');
  const facts = (await rpc.call('knownLocations', [{ kind: 'block', names: ['iron_ore'] }])).locations;
  assert.equal(facts.length, 1, 'legitimate prior sightings remain useful behind a closed wall');
  assert.equal(facts[0].perception, PERCEPTION_VERSION);
});

test('glass and water allow sight; leaves, dirt, lava and doors do not become transparent X-ray', () => {
  const { visibleBlock, wall, ore } = fixture();
  for (const material of ['glass', 'blue_stained_glass', 'glass_pane', 'water', 'ice']) {
    wall(material);
    assert.equal(visibleBlock(ore), true, material);
  }
  for (const material of ['oak_leaves', 'dirt', 'lava', 'oak_door']) {
    wall(material);
    assert.equal(visibleBlock(ore), false, material);
  }
});

test('partial shapes permit sight above a slab, but not through its occupied half', () => {
  const { visibleBlock, set, bot } = fixture();
  set(new Vec3(1, 65, 0), 'oak_slab');
  const target = set(new Vec3(2, 65, 0), 'iron_ore');
  assert.equal(visibleBlock(target), true);
  bot.entity.position.y = 63.5;
  // Same-height low eye and narrow low target are behind the occupied half.
  const hidden = set(new Vec3(2, 64, 0), 'iron_ore');
  for (let y = 63; y <= 65; y++) set(new Vec3(1, y, 0), 'stone');
  assert.equal(visibleBlock(hidden), false);
});

test('entities and item identities are hidden through walls, including guessed IDs', async () => {
  const { bot, rpc, wall } = fixture();
  wall('stone');
  bot.entities[7] = { id: 7, name: 'creeper', position: new Vec3(2.5, 64, 0.5), height: 1.7 };
  assert.deepEqual(rpc.observe().entities, []);
  for (const method of ['follow', 'attack', 'activateEntity']) await assert.rejects(rpc.call(method, [7]), /no longer visible/);
  wall('glass');
  assert.equal(rpc.observe().entities[0].name, 'creeper');
});

test('unknown chunks stop rays and hidden air is unknown, not fabricated air', async () => {
  const { bot, rpc, ore } = fixture();
  const loaded = bot.blockAt;
  bot.blockAt = p => p.x === 1 ? null : loaded(p);
  assert.equal(await rpc.call('blockAt', [ore.position]), null);
  assert.equal(await rpc.call('blockAt', [new Vec3(3, 64, 0)]), null);
});

test('rotating or moving around an obstruction discovers real surfaces without an FOV restriction', () => {
  const { bot, wall, ore, visibleBlock } = fixture();
  wall('stone');
  assert.equal(visibleBlock(ore), false);
  bot.entity.position = new Vec3(3.5, 64, 0.5);
  assert.equal(visibleBlock(ore), true);
});
