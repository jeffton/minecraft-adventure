import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lodgeBlueprint, validHome, matchesLodgeMaterial as matching, lodgeMaterialItem } from './blueprint.mjs';
import { CONTROL, CONTROLLER_REVISION, atomicJson, getHome, getMission } from './runtime.mjs';
import * as skills from '/opt/minecraft-mindcraft/src/agent/library/skills.js';
import { registerProgression } from './progression.mjs';
import { registerPrograms } from './program.mjs';
import { registerScouting } from './scout.mjs';
import { gatherResource, approachAnimal } from './gather.mjs';
import { navigateHome } from './navigation.mjs';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Vec3 } = require('vec3');

function ground(bot, x, z, nearY) {
  for (let y = nearY + 8; y >= nearY - 12; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return null;
    if (['grass_block', 'dirt', 'stone', 'sand'].includes(block.name) &&
        bot.blockAt(new Vec3(x, y + 1, z))?.boundingBox === 'empty') return y;
  }
  return null;
}

async function chooseHome(agent) {
  const existing = getHome();
  if (existing) return `Shared home is ${JSON.stringify(existing)}. Do not relocate it.`;
  if (agent.name !== 'Roy') return 'Roy chooses the shared home; ask him for the location.';
  const bot = agent.bot;
  const center = bot.entity.position.floored();
  let best = null;
  for (let dx = -16; dx <= 16; dx += 4) {
    for (let dz = -16; dz <= 16; dz += 4) {
      const heights = [];
      for (const x of [0, 3, 6]) for (const z of [0, 4, 8]) {
        const y = ground(bot, center.x + dx + x, center.z + dz + z, center.y);
        if (y !== null) heights.push(y);
      }
      if (heights.length !== 9 || Math.max(...heights) - Math.min(...heights) > 1) continue;
      const score = Math.abs(dx) + Math.abs(dz) + (Math.max(...heights) - Math.min(...heights)) * 20;
      if (!best || score < best.score) best = { x: center.x + dx, y: Math.max(...heights) + 1, z: center.z + dz, score };
    }
  }
  if (!best) return 'No sufficiently flat loaded 7x9 site within 24 blocks. Explore a safe clearing, then try !chooseHome again.';
  const home = { x: best.x, y: best.y, z: best.z, dimension: bot.game.dimension };
  writeFileSync(join(CONTROL, 'home.json'), JSON.stringify(home), { flag: 'wx', mode: 0o640 });
  agent.adventure?.emit('milestone', `Chose shared home at ${home.x},${home.y},${home.z}.`);
  return `Shared home chosen: ${JSON.stringify(home)}. Footprint x0..6,z0..8 relative to this corner. Ask teammates for materials; !buildLodge builds a small earned batch.`;
}

async function buildLodge(agent) {
  const bot = agent.bot;
  const home = getHome();
  const blocked = message => ({ message, placed: 0, complete: false });
  if (!validHome(home)) return blocked('First choose the shared site with !chooseHome.');
  if (agent.name !== 'Roy') return blocked('Roy owns the shared blueprint to prevent conflicting builders. Supply materials to Roy.');
  if (home.dimension !== bot.game.dimension) return blocked('The lodge is in another dimension.');
  if (bot.entity.position.distanceTo(new Vec3(home.x, home.y, home.z)) > 96) return blocked('Return within 96 blocks of the shared home before building.');
  const missing = {};
  let placed = 0;
  let remaining = 0;
  agent.adventureBuilding = true;
  try {
    for (const step of lodgeBlueprint()) {
      if (bot.interrupt_code || bot.health <= 8) break;
      const p = new Vec3(home.x + step.x, home.y + step.y, home.z + step.z);
      const current = bot.blockAt(p);
      if (!current) { remaining++; continue; }
      if (matching(current.name, step.material)) continue;
      remaining++;
      const item = lodgeMaterialItem(bot.inventory.items(), step.material);
      if (!item) { missing[step.material] = (missing[step.material] ?? 0) + 1; continue; }
      // Do not remove foreign utility blocks or another player's construction.
      if (current.boundingBox !== 'empty' && !['dirt', 'grass_block', 'stone', 'sand'].includes(current.name)) {
        if (step.y >= 0) return { message: `Blueprint blocked by ${current.name} at ${p}; inspect it rather than destroying it.`, placed, complete: false };
      }
      const ok = await skills.placeBlock(bot, item.name, p.x, p.y, p.z, 'bottom', true);
      if (ok && matching(bot.blockAt(p)?.name, step.material)) {
        placed++;
        agent.adventure?.emit('build', `Placed ${item.name} at ${p}.`, { scope: 'lodge', verified: true, material: item.name, position: { x: p.x, y: p.y, z: p.z } });
      }
      if (placed >= 8) break;
    }
    const complete = lodgeBlueprint().every(step => matching(bot.blockAt(new Vec3(home.x + step.x, home.y + step.y, home.z + step.z))?.name, step.material));
    if (complete && !existsSync(join(CONTROL, 'lodge-complete.json'))) {
      atomicJson(join(CONTROL, 'lodge-complete.json'), { at: new Date().toISOString(), home });
      agent.adventure?.emit('milestone', 'Finished the observed timber lodge blueprint.');
    }
    return {
      placed, complete,
      message: `Lodge batch: ${placed} blocks placed. ${complete ? 'All blueprint blocks verified.' : `Still incomplete. Missing materials encountered: ${JSON.stringify(missing)}.`} Gather/craft missing materials, share supplies, then continue !buildLodge.`
    };
  } finally { agent.adventureBuilding = false; }
}

export function registerAdventure(actions) {
  actions.push({ name: '!chooseHome', description: 'Roy surveys a nearby flat site and persistently reserves the team home. No teleport or world edits.', perform: chooseHome });
  actions.push({ name: '!buildLodge', description: 'Roy builds up to eight blocks of the shared aesthetic lodge, using real inventory and survival placement. Reports missing supplies. Establish home first.',
    perform: async agent => {
      let result;
      const action = await agent.actions.runAction('adventure:buildLodge', async () => { result = await buildLodge(agent); }, { timeout: 2 });
      return action.interrupted || !action.success ? action.message : result.message;
    }
  });
  registerProgression(actions, skills);
  registerScouting(actions, skills);
  registerPrograms(actions, skills, {
    getMission, getHome, approachAnimal, navigateHome, controllerRevision: CONTROLLER_REVISION,
    gatherResource: (agent, names, home) => gatherResource(agent, names, home, skills),
    emit: (agent, type, message, data) => agent.adventure?.emit(type, message, data),
    buildLodge: async (bot, home, agent) => {
      if (!getHome()) await chooseHome(agent);
      return buildLodge(agent);
    }
  });
}
