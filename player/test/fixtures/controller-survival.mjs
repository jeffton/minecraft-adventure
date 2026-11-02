export async function decide(observation, state = {}, lastResult = null) {
  const generation = (state.generation ?? 0) + 1;
  const failures = lastResult?.state === 'failed' ? (state.failures ?? 0) + 1 : 0;
  return {
    state: { ...state, generation, failures },
    action: {
      name: 'Establish supplies and a crafting foothold',
      input: { generation, failures, revision: 'one' },
      code: `
const count = (s, name) => s.inventory.filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
const logs = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'];
let s = await mc.observe();
const results = [];
const gather = async (names, limit) => {
  const found = await mc.call('findBlocks', { names, radius: 32, count: 48 });
  const candidates = found.filter(b => b.position.y <= s.position.y + 3 && b.position.y >= s.position.y - 5)
    .sort((a, b) => a.position.y - b.position.y).slice(0, 6);
  let got = 0;
  for (const candidate of candidates) {
    const p = candidate.position;
    if (got >= limit) break;
    try {
      const r = await mc.call('harvest', p);
      results.push({ block: r.block, inventoryDelta: r.inventoryDelta });
      s = r.observation;
      got++;
    } catch (e) { results.push({ failed: String(e.message), position: p }); }
  }
  return got;
};
// Keep useful reserves rather than waiting for another model decision.
if (s.food < 17) {
  const food = s.inventory.find(i => ['apple','bread','cooked_beef','cooked_porkchop','cooked_chicken','carrot','baked_potato'].includes(i.name));
  if (food) { await mc.call('equip', food.name); await mc.call('consume'); s = await mc.observe(); }
}
let timber = logs.reduce((n, name) => n + count(s, name), 0);
if (timber < 4) {
  await gather(logs, 2);
  return { results, revision: input.revision, observed: await mc.observe() };
}
s = await mc.observe();
for (const name of logs) {
  const available = count(s, name);
  if (!available) continue;
  const planks = name.replace('_log', '_planks');
  if (count(s, planks) < 24) {
    await mc.call('craft', planks, Math.min(available, 6));
    s = await mc.observe();
  }
}
let tables = await mc.call('findBlocks', { names: ['crafting_table'], radius: 8, count: 1 });
if (!tables.length) {
  if (!count(s, 'crafting_table')) { await mc.call('craft', 'crafting_table', 1); s = await mc.observe(); }
  const feet = { x: Math.floor(s.position.x), y: Math.floor(s.position.y), z: Math.floor(s.position.z) };
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1]]) {
    const p = {x: feet.x + dx, y: feet.y, z: feet.z + dz};
    const below = { ...p, y: p.y - 1 };
    let air, support;
    try {
      air = await mc.call('blockAt', p);
      support = await mc.call('blockAt', below);
    } catch (e) { results.push({ placementRejected: String(e.message), position: p }); continue; }
    if (!air || !support || air.name !== 'air') continue;
    if (['air','water','lava','short_grass','tall_grass'].includes(support.name)) continue;
    await mc.call('equip', 'crafting_table');
    await mc.call('placeBlock', below, {x:0,y:1,z:0});
    tables = [{ position: p }];
    break;
  }
}
if (!tables.length) return { results, blocked: 'No checked crafting-table placement' };
const table = tables[0].position;
await mc.call('goto', table, 2);
s = await mc.observe();
if (count(s,'stick') < 4) { await mc.call('craft','stick',2); s = await mc.observe(); }
if (!count(s,'wooden_pickaxe') && !count(s,'stone_pickaxe')) {
  await mc.call('craft','wooden_pickaxe',1,table); s = await mc.observe();
}
if (!count(s, 'chest')) {
  const recipes = await mc.call('recipesFor', 'chest', 1, table);
  if (recipes.length) { await mc.call('craft','chest',1,table); s = await mc.observe(); }
}
await gather(['stone','cobblestone','coal_ore'], 3);
s = await mc.observe();
await mc.call('goto',table,2);
if (count(s,'cobblestone') >= 3 && !count(s,'stone_pickaxe')) { await mc.call('craft','stone_pickaxe',1,table); s = await mc.observe(); }
if (count(s,'cobblestone') >= 3 && !count(s,'stone_axe')) { await mc.call('craft','stone_axe',1,table); s = await mc.observe(); }
if (count(s,'cobblestone') >= 8 && !count(s,'furnace')) await mc.call('craft','furnace',1,table);
return { results, revision: input.revision, observed: await mc.observe() };
`
    }
  };
}
