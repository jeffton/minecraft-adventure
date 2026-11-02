import { setImmediate as yieldTurn } from 'node:timers/promises';
import { MAX_FRAME_BYTES } from './sandbox-protocol.mjs';

const replyEnvelopeBytes = Buffer.byteLength(JSON.stringify({ type: 'reply', id: Number.MAX_SAFE_INTEGER, value: [] })) + 1;

/** Search only loaded columns; retain nearest requested matches, never an unbounded search sphere. */
export async function findLoadedBlocks(bot, Vec3, names, { radius, count, pack = position => position } = {}, active = () => {}) {
  const ids = new Set(names.map(name => {
    if (typeof name !== 'string' || !Object.hasOwn(bot.registry.blocksByName, name)) throw new Error(`Unknown block: ${name}`);
    return bot.registry.blocksByName[name].id;
  }));
  const origin = { ...bot.entity.position };
  const maxDistance = radius ?? Infinity;
  if (radius !== undefined && (!Number.isFinite(radius) || radius < 0)) throw new Error('radius must be finite and nonnegative');
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) throw new Error('count must be a positive safe integer');
  const found = [];
  let resultBytes = 0;
  const swap = (a, b) => { [found[a], found[b]] = [found[b], found[a]]; };
  const retain = entry => {
    if (count !== undefined && found.length === count) {
      resultBytes -= found[0].bytes;
      found[0] = entry;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let largest = index;
        if (left < found.length && found[left].distance > found[largest].distance) largest = left;
        if (right < found.length && found[right].distance > found[largest].distance) largest = right;
        if (largest === index) break;
        swap(index, largest);
        index = largest;
      }
    } else {
      found.push(entry);
      if (count !== undefined) {
        let index = found.length - 1;
        while (index > 0) {
          const parent = Math.floor((index - 1) / 2);
          if (found[parent].distance >= found[index].distance) break;
          swap(index, parent);
          index = parent;
        }
      }
    }
    resultBytes += entry.bytes;
    if (replyEnvelopeBytes + resultBytes + Math.max(0, found.length - 1) > MAX_FRAME_BYTES) {
      throw new Error('Block query result exceeds the 1 MiB RPC frame; select names, radius or count explicitly');
    }
  };
  for (const { chunkX, chunkZ, column } of bot.world.getColumns()) {
    for (let sectionY = 0; sectionY < column.sections.length; sectionY++) {
      active();
      if (bot.world.getColumn(chunkX, chunkZ) !== column) break;
      const section = column.sections[sectionY];
      if (!section) continue;
      if (section.palette && !section.palette.some(stateId => ids.has(bot.registry.blocksByStateId[stateId].id))) continue;
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y < 16; y++) {
          for (let z = 0; z < 16; z++) {
            const blockY = column.minY + sectionY * 16 + y;
            if (!ids.has(column.getBlockType(new Vec3(x, blockY, z)))) continue;
            const position = new Vec3(Number(chunkX) * 16 + x, blockY, Number(chunkZ) * 16 + z);
            const distance = Math.hypot(position.x - origin.x, position.y - origin.y, position.z - origin.z);
            if (distance > maxDistance || (count !== undefined && found.length === count && distance >= found[0].distance)) continue;
            const value = pack(position);
            if (!value) continue;
            retain({ value, distance, bytes: Buffer.byteLength(JSON.stringify(value)) });
          }
        }
      }
      await yieldTurn();
    }
  }
  active();
  found.sort((a, b) => a.distance - b.distance);
  return found.map(({ value }) => value);
}
