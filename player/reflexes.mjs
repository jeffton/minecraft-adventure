const HOSTILES = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'pillager', 'vindicator', 'ravager', 'silverfish', 'endermite', 'blaze', 'wither_skeleton', 'hoglin', 'zoglin', 'phantom', 'breeze']);
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze']);

// Use actual collision shapes, not entity proximity: mobs above a sealed roof
// or behind a wall must not evict the player from shelter. Sample both upper
// and lower body so a partial wall does not incorrectly count as protection.
export function isExposedTo(bot, entity) {
  const origin = entity.position.offset(0, entity.height * 0.85, 0);
  return [0.4, bot.entity.height * 0.85].some(height => {
    const direction = bot.entity.position.offset(0, height, 0).minus(origin);
    const distance = direction.norm();
    return distance === 0 || bot.world.raycast(origin, direction.normalize(), distance) === null;
  });
}

export function nearbyThreats(bot, radius = 12) {
  return Object.values(bot.entities).filter(entity => entity.position &&
    (HOSTILES.has(entity.name) || (entity.name === 'enderman' && entity.metadata?.[17] === true)) &&
    entity.position.distanceTo(bot.entity.position) <= radius && isExposedTo(bot, entity))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

// acquire/release transfer exclusive movement/inventory ownership from generated
// programs to a bounded local safety action, including gaps between timer ticks.
export function createReflexController(bot, { acquire, release, goals, emit, onError, now = Date.now }) {
  let busy = false;
  let closed = false;
  let mode = null;
  let escapeUntil = 0;
  let lastMeal = 0;
  let lastAttack = 0;
  let restoreMovement = null;
  const take = async next => {
    if (mode === next) return;
    mode = next;
    await acquire(next);
  };
  const relinquish = () => {
    if (!mode) return;
    bot.setControlState('jump', false);
    bot.pathfinder.setGoal(null);
    restoreMovement?.();
    restoreMovement = null;
    mode = null;
    release();
  };
  const escapeMovement = () => {
    const movements = bot.pathfinder.movements;
    const safe = {
      canDig: false, allow1by1towers: false, scafoldingBlocks: [],
      allowSprinting: true, allowParkour: false, maxDropDown: 3,
      infiniteLiquidDropdownDistance: false,
    };
    const previous = Object.fromEntries(Object.keys(safe).map(key => [key, movements[key]]));
    Object.assign(movements, safe);
    restoreMovement = () => Object.assign(movements, previous);
  };
  const tick = async () => {
    if (closed || busy || !bot.entity || bot._client.ended) return;
    if (bot.health <= 0) { relinquish(); return; }
    busy = true;
    try {
      if (bot.entity.isInWater && bot.oxygenLevel < 8) {
        if (mode && mode !== 'surfacing for air') relinquish();
        await take('surfacing for air');
        if (closed) { relinquish(); return; }
        bot.setControlState('jump', true);
        return;
      }
      if (mode === 'surfacing for air') relinquish();
      const threats = nearbyThreats(bot);
      const nearest = threats[0];
      const distance = nearest?.position.distanceTo(bot.entity.position) ?? Infinity;
      if (mode === 'escaping immediate danger') {
        if (nearest && now() < escapeUntil) return;
        relinquish();
        return;
      }
      const danger = threats.find(entity => {
        const range = entity.position.distanceTo(bot.entity.position);
        return (range < 6 && (bot.health <= 8 || threats.length >= 3 || entity.name === 'creeper')) ||
          ((RANGED.has(entity.name) || (entity.name === 'drowned' && entity.heldItem?.name === 'trident')) && range >= 3);
      });
      if (danger) {
        if (mode) relinquish();
        await take('escaping immediate danger');
        if (closed) { relinquish(); return; }
        escapeMovement();
        escapeUntil = now() + 6000;
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(danger.position.x, danger.position.y, danger.position.z, 12)));
        emit('reflex', `Escaping ${danger.name} at ${Math.round(danger.position.distanceTo(bot.entity.position))} blocks.`);
        return;
      }
      if (nearest && distance < 3 && bot.health > 8) {
        await take('defending against nearby enemy');
        if (closed) { relinquish(); return; }
        if (now() - lastAttack > 700) {
          lastAttack = now();
          const sword = bot.inventory.items().find(item => item.name.endsWith('_sword'));
          if (sword && bot.heldItem?.type !== sword.type) await bot.equip(sword, 'hand');
          await bot.lookAt(nearest.position.offset(0, nearest.height / 2, 0));
          if (!closed) bot.attack(nearest);
        }
        return;
      }
      if (mode === 'defending against nearby enemy') relinquish();
      if (bot.food <= 16 && distance > 4 && now() - lastMeal > 5000) {
        const food = bot.inventory.items().filter(item => bot.registry.foodsByName[item.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit'].includes(item.name))
          .sort((a, b) => bot.registry.foodsByName[b.name].foodPoints - bot.registry.foodsByName[a.name].foodPoints)[0];
        if (food) {
          lastMeal = now();
          await take('eating');
          try {
            if (closed) return;
            const before = bot.food;
            await bot.equip(food, 'hand');
            if (closed) return;
            await bot.consume();
            emit('eat', `Ate ${food.name}.`, { verified: bot.food > before, item: food.name, before, after: bot.food });
          } finally { relinquish(); }
        }
      }
    } catch (error) { relinquish(); onError(error); }
    finally { busy = false; }
  };
  return { tick, close() { closed = true; relinquish(); } };
}

export function installReflexes(bot, options) {
  const controller = createReflexController(bot, options);
  const timer = setInterval(() => void controller.tick(), 500);
  return () => { clearInterval(timer); controller.close(); };
}
