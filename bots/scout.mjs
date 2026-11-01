import { createRequire } from 'node:module';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const FOOD = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit']);
const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function resource(bot, type) {
  if (type === 'food') {
    const entity = Object.values(bot.entities).filter(e => FOOD.has(e.name) && e.position?.distanceTo(bot.entity.position) <= 64)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    return entity && { name: entity.name, position: entity.position };
  }
  const ids = Object.values(bot.registry.blocksByName).filter(block => {
    if (type === 'wood') return block.name.endsWith('_log') || block.name.endsWith('_stem');
    if (type === 'coal') return ['coal_ore', 'deepslate_coal_ore'].includes(block.name);
    if (type === 'iron') return ['iron_ore', 'deepslate_iron_ore'].includes(block.name);
    return block.name === type;
  }).map(block => block.id);
  if (!ids.length) throw new Error(`Unknown scouting resource: ${type}`);
  return bot.findBlock({ matching: ids, maxDistance: 64 });
}

function surface(bot, x, z) {
  for (let y = Math.floor(bot.entity.position.y + 6); y >= bot.entity.position.y - 8; y--) {
    const pos = new Vec3(x, y, z);
    const block = bot.blockAt(pos);
    if (block?.boundingBox === 'block' && !block.name.includes('leaves') &&
        bot.blockAt(pos.offset(0, 1, 0))?.boundingBox === 'empty' && bot.blockAt(pos.offset(0, 2, 0))?.boundingBox === 'empty') return y + 1;
  }
  return null;
}

export async function scoutForResource(agent, type, distance = 96, selectedBlock = null) {
  const bot = agent.bot;
  if (bot.game.gameMode !== 'survival') throw new Error('Scouting requires survival mode.');
  if (!Number.isInteger(distance) || distance < 12 || distance > 160) throw new Error('Scouting distance must be 12..160 blocks.');
  const start = bot.entity.position.clone();
  const deadline = Date.now() + 90000;
  const movement = new Movements(bot);
  movement.canDig = false;
  movement.allow1by1towers = false;
  movement.allowParkour = false;
  movement.allowSprinting = false;
  movement.maxDropDown = 1;
  bot.pathfinder.setMovements(movement);
  let heading = agent.adventureScoutHeading ?? (['Roy', 'Spruce', 'Flint', 'Moss'].indexOf(agent.name) * 2);
  let lastFailure = '';
  let failures = 0;
  let steps = 0;
  try {
    while (Date.now() < deadline && start.distanceTo(bot.entity.position) < distance && steps < 12) {
      if (bot.interrupt_code) throw new Error('Scouting interrupted.');
      if (bot.health <= 0) throw new Error('Scouting stopped: bot is dead.');
      const found = selectedBlock ? bot.blockAt(selectedBlock.position) : resource(bot, type);
      if (selectedBlock && found?.name !== selectedBlock.name) throw new Error('Selected resource changed before approach completed. Re-observe it.');
      let target;
      if (found) {
        if (bot.entity.position.distanceTo(found.position) <= 4.5) {
          const message = `Observed ${found.name} at ${found.position}. Use the appropriate gather/hunt command; no items were spawned.`;
          agent.adventure?.emit('scout', message);
          return message;
        }
        target = found.position;
      } else {
        for (let offset = 0; offset < DIRECTIONS.length; offset++) {
          const direction = (heading + offset) % DIRECTIONS.length;
          const [dx, dz] = DIRECTIONS[direction];
          const x = Math.floor(bot.entity.position.x + dx * 12);
          const z = Math.floor(bot.entity.position.z + dz * 12);
          const y = surface(bot, x, z);
          if (y === null || y - bot.entity.position.y > 5 || y - bot.entity.position.y < -8) continue;
          const danger = Object.values(bot.entities).some(entity => ['creeper', 'skeleton', 'zombie'].includes(entity.name) &&
            entity.position?.distanceTo(new Vec3(x, y, z)) < 8);
          if (danger) continue;
          target = new Vec3(x, y, z);
          heading = direction;
          break;
        }
      }
      if (!target) throw new Error('No safe observed walking waypoint: steep cliffs, unknown chunks or hostile mobs block exploration.');
      // Horizontal goals let normal pathfinding choose the actual traversable Y.
      try {
        const goal = found
          ? new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), 3)
          : new goals.GoalNearXZ(Math.floor(target.x), Math.floor(target.z), 3);
        await bot.pathfinder.goto(goal);
        failures = 0;
      } catch (error) {
        if (bot.interrupt_code) throw error;
        lastFailure = String(error.message ?? error);
        agent.adventure?.emit('scout_blocked', lastFailure);
        if (found) throw new Error(`Observed ${found.name} is not reachable by a safe walking route: ${lastFailure}`);
        if (++failures >= 3) throw new Error(`Scouting paths blocked: ${lastFailure}`);
        heading = (heading + 2) % DIRECTIONS.length;
      }
      steps++;
      await bot.waitForTicks(8);
    }
    return `Scouted ${Math.round(start.distanceTo(bot.entity.position))} blocks toward ${type}; no accessible resource observed yet. Reassess the observed terrain and scout a different heading. ${lastFailure}`;
  } finally {
    agent.adventureScoutHeading = (heading + 1) % DIRECTIONS.length;
    bot.pathfinder.setGoal(null);
  }
}

export function registerScouting(actions, skills) {
  actions.push({
    name: '!scoutForResource',
    description: 'Explore actual loaded walking routes toward wood, food, coal, iron or a block name. Scouts beyond the initial view without digging, teleporting, cliff jumps or spawning resources. Stops at observed nearby resources or a concrete hazard.',
    params: { type: { type: 'string', description: 'wood, food, coal, iron or a registry block name' },
      distance: { type: 'int', description: 'Maximum exploration displacement in blocks', domain: [12, 160] } },
    perform: async (agent, type, distance) => {
      let result;
      const action = await agent.actions.runAction('adventure:scout', async () => {
        result = await scoutForResource(agent, type, distance);
        skills.log(agent.bot, result);
      }, { timeout: 2 });
      return !action.success || action.interrupted ? action.message : result;
    }
  });
}
