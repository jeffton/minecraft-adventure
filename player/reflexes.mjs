const HOSTILES = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'pillager', 'vindicator', 'ravager', 'silverfish', 'endermite', 'blaze', 'wither_skeleton', 'hoglin', 'zoglin', 'phantom', 'breeze']);

export function nearbyThreats(bot, radius = 12) {
  return Object.values(bot.entities).filter(entity => entity.position &&
    (HOSTILES.has(entity.name) || (entity.name === 'enderman' && entity.metadata?.[17] === true)) &&
    entity.position.distanceTo(bot.entity.position) <= radius)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

// acquire/release transfer exclusive movement/inventory ownership from generated
// programs to a bounded local safety action, including gaps between timer ticks.
export function installReflexes(bot, { acquire, release, goals, emit, onError }) {
  let busy = false;
  let mode = null;
  let escapeUntil = 0;
  let lastMeal = 0;
  let lastAttack = 0;
  const take = async next => {
    if (mode === next) return;
    mode = next;
    await acquire(next);
  };
  const relinquish = () => {
    if (!mode) return;
    bot.setControlState('jump', false);
    bot.pathfinder.setGoal(null);
    mode = null;
    release();
  };
  const timer = setInterval(async () => {
    if (busy || !bot.entity || bot._client.ended) return;
    if (bot.health <= 0) { relinquish(); return; }
    busy = true;
    try {
      if (bot.entity.isInWater && bot.oxygenLevel < 8) {
        await take('surfacing for air');
        bot.setControlState('jump', true);
        return;
      }
      if (mode === 'surfacing for air') relinquish();
      const threats = nearbyThreats(bot);
      const nearest = threats[0];
      const distance = nearest?.position.distanceTo(bot.entity.position) ?? Infinity;
      if (mode === 'escaping immediate danger' && Date.now() < escapeUntil) return;
      if (mode === 'escaping immediate danger') relinquish();
      if (nearest && distance < 6 && (bot.health <= 8 || threats.length >= 3 || nearest.name === 'creeper')) {
        await take('escaping immediate danger');
        escapeUntil = Date.now() + 6000;
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(nearest.position.x, nearest.position.y, nearest.position.z, 12)));
        emit('reflex', `Escaping ${nearest.name} at ${Math.round(distance)} blocks.`);
        return;
      }
      if (nearest && distance < 3 && bot.health > 8) {
        await take('defending against nearby enemy');
        if (Date.now() - lastAttack > 700) {
          lastAttack = Date.now();
          const sword = bot.inventory.items().find(item => item.name.endsWith('_sword'));
          if (sword && bot.heldItem?.type !== sword.type) await bot.equip(sword, 'hand');
          await bot.lookAt(nearest.position.offset(0, nearest.height / 2, 0));
          bot.attack(nearest);
        }
        return;
      }
      if (mode === 'defending against nearby enemy') relinquish();
      if (bot.food <= 16 && distance > 4 && Date.now() - lastMeal > 5000) {
        const food = bot.inventory.items().filter(item => bot.registry.foodsByName[item.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit'].includes(item.name))
          .sort((a, b) => bot.registry.foodsByName[b.name].foodPoints - bot.registry.foodsByName[a.name].foodPoints)[0];
        if (food) {
          lastMeal = Date.now();
          await take('eating');
          try {
            const before = bot.food;
            await bot.equip(food, 'hand');
            await bot.consume();
            emit('eat', `Ate ${food.name}.`, { verified: bot.food > before, item: food.name, before, after: bot.food });
          } finally { relinquish(); }
        }
      }
    } catch (error) { relinquish(); onError(error); }
    finally { busy = false; }
  }, 500);
  return () => { clearInterval(timer); relinquish(); };
}
