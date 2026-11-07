import { createRequire } from 'node:module';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { RaycastIterator } = require('prismarine-world').iterators;

export const PERCEPTION_VERSION = 'line-of-sight-v1';
const AIR = new Set(['air', 'cave_air', 'void_air']);
const FULL = [[0, 0, 0, 1, 1, 1]];
const SAMPLES = [[0.5, 0.5, 0.5], [0.001, 0.5, 0.5], [0.999, 0.5, 0.5],
  [0.5, 0.001, 0.5], [0.5, 0.999, 0.5], [0.5, 0.5, 0.001], [0.5, 0.5, 0.999]];

function opaqueShapes(block) {
  if (AIR.has(block.name) || block.name === 'water' || block.name === 'bubble_column' ||
      block.name === 'glass' || block.name.endsWith('_stained_glass') ||
      block.name === 'glass_pane' || block.name.endsWith('_stained_glass_pane') ||
      block.name === 'ice' || block.name === 'frosted_ice') return [];
  // Leaves and lava have visible surfaces even though their collision/lighting
  // metadata is transparent. Doors, slabs and stairs occlude only their shapes.
  if (block.name.endsWith('_leaves') || block.name === 'lava') return FULL;
  return block.shapes;
}

/** Omnidirectional eyesight: no heading restriction, no reads through walls.
 * Collision geometry stays private to Mineflayer/pathfinding. Unknown chunks
 * stop a sight ray; they are not represented as air.
 */
export function createBlockVisibility(bot, Vec3) {
  const cell = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)].join(',');
  const eye = () => new Vec3(bot.entity.position.x,
    bot.entity.position.y + (bot.entity.eyeHeight ?? 1.62), bot.entity.position.z);

  function ray(end, targetCell) {
    const origin = eye();
    const delta = new Vec3(end.x - origin.x, end.y - origin.y, end.z - origin.z);
    const distance = Math.hypot(delta.x, delta.y, delta.z);
    if (!distance) return true;
    const direction = new Vec3(delta.x / distance, delta.y / distance, delta.z / distance);
    const iterator = new RaycastIterator(origin, direction, distance);
    let p = origin;
    while (p) {
      const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      const block = bot.blockAt(position);
      if (!block) return false;
      if (targetCell && cell(position) === targetCell) return true;
      const shapes = opaqueShapes(block);
      if (shapes?.length && iterator.intersect(shapes, position)) return false;
      p = iterator.next();
    }
    return !targetCell;
  }

  function visibleBlock(block) {
    if (!block || !bot.entity?.position) return false;
    const p = block.position;
    return SAMPLES.some(([x, y, z]) => ray(new Vec3(p.x + x, p.y + y, p.z + z), cell(p)));
  }

  function visibleEntity(entity) {
    if (!entity?.position || !bot.entity?.position) return false;
    const p = entity.position;
    return [0.5, 0.85].some(fraction => ray(new Vec3(p.x,
      p.y + (entity.height ?? 0.5) * fraction, p.z)));
  }

  return { visibleBlock, visibleEntity };
}
