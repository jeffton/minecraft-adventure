import { createRequire } from 'node:module';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Movements, goals } = require('mineflayer-pathfinder');

function protectedSite(position, home, dimension) {
  return home && home.dimension === dimension && position.x >= home.x - 2 && position.x <= home.x + 8 &&
    position.z >= home.z - 3 && position.z <= home.z + 10 && position.y >= home.y - 2;
}

export async function gatherResource(agent, names, home, skills) {
  const bot = agent.bot;
  if (bot.game.gameMode !== 'survival') throw new Error('Gathering requires survival mode.');
  const ids = names.map(name => bot.registry.blocksByName[name]?.id).filter(id => id !== undefined);
  const positions = bot.findBlocks({ matching: ids, maxDistance: 64, count: 32 });
  const candidates = positions.map(position => bot.blockAt(position))
    .filter(block => block && !protectedSite(block.position, home, bot.game.dimension));
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allowParkour = false;
  movements.allow1by1towers = false;
  movements.maxDropDown = 2;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  bot.pathfinder.setMovements(movements);
  let selected;
  let selectedGoal;
  const columns = new Set();
  let searched = 0;
  for (const block of candidates) {
    if (bot.interrupt_code || bot.health <= 0) throw new Error('Gathering interrupted.');
    const column = `${block.position.x},${block.position.z}`;
    if (columns.has(column)) continue;
    columns.add(column);
    if (++searched > 8) break;
    const goal = new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4.2 });
    const search = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout: 600, tickTimeout: 30 });
    for (const { result } of search) {
      if (result.status === 'success') { selected = block; selectedGoal = goal; break; }
      if (result.status !== 'partial') break;
      // Yield between A* slices so client physics and server tick packets continue.
      await new Promise(resolve => setImmediate(resolve));
      if (bot.interrupt_code) throw new Error('Gathering path search interrupted.');
    }
    if (selected) break;
  }
  if (!selected) throw new Error(`No reachable unprotected ${names.join('/')} among ${searched} loaded resource columns. Scout a different route.`);
  agent.adventure?.emit('gather_target', `Approaching reachable ${selected.name} at ${selected.position}.`);
  await bot.pathfinder.goto(selectedGoal);
  if (bot.interrupt_code) throw new Error('Gathering approach interrupted.');
  const actual = bot.blockAt(selected.position);
  if (!actual || actual.name !== selected.name) throw new Error('Selected resource changed during approach; re-observe before gathering.');
  await bot.tool.equipForBlock(actual);
  if (!actual.canHarvest(bot.heldItem?.type ?? null)) throw new Error(`Earned tool required to harvest ${actual.name}.`);
  await bot.lookAt(actual.position.offset(0.5, 0.5, 0.5));
  await bot.dig(actual, true);
  // Vanilla block drops have a ten-tick pickup delay. Let the real item spawn
  // and become collectible before checking the inventory postcondition.
  await bot.waitForTicks(12);
  await skills.pickupNearbyItems(bot);
  await bot.waitForTicks(4);
  return true;
}
