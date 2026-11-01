import { createRequire } from 'node:module';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const HORIZON = 24;
const ARRIVAL_DISTANCE = 4;
const MIN_PROGRESS = 0.5;

function distanceXYZ(position, target) {
  return Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z);
}

export async function navigateHome(bot, home, check) {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allowParkour = false;
  movements.allow1by1towers = false;
  movements.maxDropDown = 2;
  movements.dontCreateFlow = true;
  bot.pathfinder.setMovements(movements);

  while (true) {
    check();
    if (bot.interrupt_code) throw new Error('Home navigation interrupted.');

    const position = bot.entity.position;
    const distance = distanceXYZ(position, home);
    if (distance <= ARRIVAL_DISTANCE) return;

    const dx = home.x - position.x;
    const dz = home.z - position.z;
    const horizontalDistance = Math.hypot(dx, dz);
    const goal = horizontalDistance > HORIZON
      ? new goals.GoalNearXZ(
          Math.floor(position.x + (dx / horizontalDistance) * HORIZON),
          Math.floor(position.z + (dz / horizontalDistance) * HORIZON),
          3
        )
      : new goals.GoalNear(
          Math.floor(home.x),
          Math.floor(home.y),
          Math.floor(home.z),
          3
        );

    const before = new Vec3(position.x, position.y, position.z);
    await bot.pathfinder.goto(goal);

    check();
    if (bot.interrupt_code) throw new Error('Home navigation interrupted.');
    const after = bot.entity.position;
    const remaining = distanceXYZ(after, home);
    if (remaining <= ARRIVAL_DISTANCE) return;
    if (distanceXYZ(after, before) < MIN_PROGRESS) {
      throw new Error('Home navigation made no meaningful progress: pathfinder returned without moving.');
    }
  }
}
