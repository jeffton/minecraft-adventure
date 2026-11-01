import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o640 });
  await rename(temp, file);
}

export async function optionalJson(file, initial) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return initial; throw error; }
}

export function playerState(bot, { worldId, session, events, action, thinking, error, life, notes }) {
  const inventory = bot.inventory.items().map(({ name, count }) => ({ name, count }));
  const position = bot.entity.position;
  const at = new Date().toISOString();
  const actor = {
    name: 'Roy', role: 'Autonomous survival player', session, worldId, life,
    updatedAt: at, status: bot._client.ended ? 'offline' : 'online',
    health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
    position: { x: position.x, y: position.y, z: position.z },
    dimension: bot.game.dimension, inventory, held: bot.heldItem?.name ?? null,
    task: action || (thinking ? 'thinking about the next move' : 'observing'),
    action: action || (thinking ? 'planning' : 'observing'), error,
    events: events.slice(-40), home: notes.home ?? null,
  };
  return {
    worldId, updatedAt: at, phase: 'survival', serverVersion: bot.version,
    objective: notes.goal ?? 'Survive, establish a beautiful home with a bed and storage, and prepare to defeat the Ender Dragon.',
    longTerm: 'Defeat the Ender Dragon through ordinary survival play.',
    home: notes.home ?? null, bots: [actor], milestones: [], events: events.slice(-80),
  };
}

export function skillEvidence(before, after) {
  const counts = inventory => inventory.reduce((result, item) => { result[item.name] = (result[item.name] ?? 0) + item.count; return result; }, {});
  const start = counts(before.inventory ?? []);
  const end = counts(after.inventory ?? []);
  const inventoryDelta = Object.fromEntries([...new Set([...Object.keys(start), ...Object.keys(end)])]
    .map(name => [name, (end[name] ?? 0) - (start[name] ?? 0)]).filter(([, count]) => count));
  return { inventoryDelta, healthDelta: after.health - before.health, foodDelta: after.food - before.food };
}
