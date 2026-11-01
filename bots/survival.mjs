import { createRequire } from 'node:module';
const require = createRequire('/opt/minecraft-mindcraft/package.json');

export function isThreat(entity) {
  return ['mob', 'hostile'].includes(entity.type) && !['iron_golem', 'snow_golem'].includes(entity.name) &&
    (entity.name !== 'enderman' || entity.metadata?.[17] === true);
}

function hasWeapon(bot) {
  return bot.inventory.items().some(item => /_(sword|axe)$/.test(item.name));
}

export function shouldFlee(bot, enemy) {
  const nearby = Object.values(bot.entities).filter(entity => isThreat(entity) && entity.position &&
    entity.position.distanceTo(bot.entity.position) < 12);
  const threats = [...new Set([enemy, ...nearby])];
  if (bot.health < 12 || bot.food < 8 || !hasWeapon(bot) || nearby.length > 1) return true;
  const dangerous = ['creeper', 'witch', 'ravager', 'warden', 'evoker'];
  const ranged = ['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast'];
  return threats.some(entity => dangerous.includes(entity.name) || (ranged.includes(entity.name) &&
    (bot.inventory.slots[45]?.name !== 'shield' || bot.health < 16 ||
      entity.position.distanceTo(bot.entity.position) > 4)));
}

export function safeToResume(bot) {
  // The actual modes already check reachable danger. A distance-only gate would
  // strand a sheltered bot beside an unreachable enemy behind a wall.
  return bot.health > 0 && !bot.adventureSafetyActions;
}

export async function withSafetyAction(bot, action) {
  bot.adventureSafetyActions = (bot.adventureSafetyActions ?? 0) + 1;
  try { return await action(); }
  finally { bot.adventureSafetyActions--; }
}

// A retreat is one bounded action. The mode loop then rechecks danger; it never
// waits for an entire 24-block area to empty or disables emergency preservation.
export async function retreat(bot, { now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const { Movements, goals } = require('mineflayer-pathfinder');
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allowParkour = false;
  movements.allow1by1towers = false;
  movements.maxDropDown = 1;
  bot.pathfinder.setMovements(movements);
  const deadline = now() + 6000;
  try {
    while (!bot.interrupt_code && bot.health > 0 && now() < deadline) {
      const enemy = Object.values(bot.entities).filter(entity => isThreat(entity) && entity.position &&
        entity.position.distanceTo(bot.entity.position) < 12)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (!enemy) break;
      bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(enemy, 12)), true);
      await wait(250);
    }
  } finally { bot.pathfinder.setGoal(null); }
}

export function patchSurvivalSource(source, file, survivalUrl) {
  const replace = (oldText, newText) => {
    if (source.split(oldText).length !== 2) throw new Error(`Survival integration point changed: ${file}`);
    source = source.replace(oldText, newText);
  };
  if (file.endsWith('/agent.js')) {
    replace('this.bot.autoEat.options = {', 'this.bot.autoEat.options = {\n            ...this.bot.autoEat.options,');
    replace('bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]',
      'bannedFood: [...this.bot.autoEat.options.bannedFood, "rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]');
  } else if (file.endsWith('/skills.js')) {
    replace("bot.modes.pause('self_defense');\n    bot.modes.pause('cowardice');\n    let attacked = false;",
      "bot.modes.pause('self_defense');\n    // Keep cowardice available to reassess injury, reinforcements and creepers.\n    let attacked = false;");
  } else {
    source += `\nimport { shouldFlee, retreat } from ${JSON.stringify(survivalUrl)};\n`;
    replace("const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);",
      "const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 10);");
    replace("if (enemy && await world.isClearPath(agent.bot, enemy)) {\n                say(agent, `Aaa!",
      "if (enemy && shouldFlee(agent.bot, enemy) && await world.isClearPath(agent.bot, enemy)) {\n                say(agent, `Aaa!");
    replace('await skills.avoidEnemies(agent.bot, 24);', 'await retreat(agent.bot);');
  }
  return source;
}

export function configureFood(bot) {
  const banned = [...bot.autoEat.options.bannedFood];
  bot.autoEat.options.startAt = 19;
  Object.defineProperty(bot.autoEat.options, 'bannedFood', {
    get() {
      const items = [...bot.inventory.items(), bot.inventory.slots[45]].filter(Boolean);
      const safeFood = items.some(item => bot.registry.foodsByName[item.name] && !banned.includes(item.name));
      const emergency = bot.food <= 6 || (bot.health < 10 && bot.food < 18);
      return emergency && !safeFood ? banned.filter(name => name !== 'chicken') : banned;
    }
  });
}

export function observeMeals(bot, confirmed) {
  let pending;
  let expiry;
  const clear = () => { clearTimeout(expiry); pending = null; };
  const verify = () => {
    if (!pending) return;
    const item = pending.item;
    clear();
    confirmed({ verified: true, item, count: 1, food: bot.food, health: bot.health });
  };
  bot.on('autoeat_started', (item, offhand) => {
    clear();
    pending = { item: item.name, food: bot.food, slot: bot.getEquipmentDestSlot(offhand ? 'off-hand' : 'hand') };
    expiry = setTimeout(clear, bot.autoEat.options.eatingTimeout + 1000);
    expiry.unref?.();
  });
  // This is the server's own consumption-complete notification, not the
  // plugin's timeout-based finished event. Health updates can arrive first.
  bot._client.on('entity_status', packet => {
    if (pending && packet.entityId === bot.entity.id && packet.entityStatus === 9 &&
      bot.inventory.slots[pending.slot]?.name === pending.item) verify();
  });
  bot.on('health', () => { if (pending && bot.food > pending.food) verify(); });
  bot.on('death', clear);
  bot.on('end', clear);
}

export function interruptedProgramRetry(kind, bot) {
  return kind === 'interrupted' && safeToResume(bot);
}
