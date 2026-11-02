import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KINDS = ['biome', 'block', 'entity', 'visited'];
const TABLES = { items: 'itemsByName', blocks: 'blocksByName', biomes: 'biomesByName', entities: 'entitiesByName' };

function limitValue(value) {
  if (value === undefined) return Infinity;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('limit must be a positive safe integer');
  return value;
}

function namesValue(names) {
  if (names !== undefined && (!Array.isArray(names) || names.length < 1 || names.some(name => typeof name !== 'string' || !name))) {
    throw new Error('names must contain nonempty registry names');
  }
  return names;
}

/** Registry facts only: neither spawn guarantees nor undiscovered resource coordinates. */
export function registryInfo(registry, type, { names, search, limit } = {}) {
  if (!Object.hasOwn(TABLES, type)) throw new Error('Registry type must be items, blocks, biomes or entities');
  namesValue(names);
  limit = limitValue(limit);
  if (search !== undefined && (typeof search !== 'string' || search.length < 1)) throw new Error('search must be nonempty');
  if (!names && !search) throw new Error('Provide names or search');
  const table = registry[TABLES[type]];
  const matches = names ? names.map(name => {
    if (!Object.hasOwn(table, name)) throw new Error(`Unknown ${type}: ${name}`);
    return table[name];
  }) : Object.values(table);
  const filtered = matches.filter(value => !search || `${value.name} ${value.displayName ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const items = filtered.slice(0, limit).map(value => {
    const result = {};
    const fields = type === 'biomes'
      ? ['id', 'name', 'displayName', 'category', 'temperature', 'has_precipitation', 'dimension']
      : type === 'entities'
        ? ['id', 'name', 'displayName', 'type', 'category', 'width', 'height']
        : type === 'blocks'
          ? ['id', 'name', 'displayName', 'hardness', 'diggable', 'material', 'boundingBox', 'emitLight']
          : ['id', 'name', 'displayName', 'stackSize'];
    for (const key of fields) if (value[key] !== undefined) result[key] = value[key];
    if (type === 'blocks') {
      result.drops = (value.drops ?? []).map(id => ({ id, name: registry.items[id]?.name }));
      result.harvestTools = Object.keys(value.harvestTools ?? {}).map(id => ({ id: Number(id), name: registry.items[id]?.name }));
    }
    return result;
  });
  return { type, items, truncated: filtered.length > limit };
}

/** Resolve biome only through a block the client has actually loaded. */
export function loadedBiome(bot, position, Vec3, requireLoaded = true) {
  const block = bot.blockAt(new Vec3(position.x, position.y, position.z));
  if (!block) {
    if (requireLoaded) throw new Error('Biome position is not loaded');
    return null;
  }
  const id = typeof block.biome === 'number' ? block.biome : block.biome?.id;
  if (id === undefined) return null;
  const biome = bot.registry.biomes[id];
  if (!biome) throw new Error(`Unknown biome id: ${id}`);
  return { id: biome.id, name: biome.name, category: biome.category, dimension: biome.dimension, position: { ...position } };
}

/** Historical client observations, isolated by world ID and dimension. No world scans. */
export function createWorldKnowledge({ directory, worldId = 'unpersisted' } = {}) {
  if (typeof worldId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(worldId)) throw new Error('Invalid knowledge worldId');
  const file = directory && path.join(directory, 'world-knowledge.json');
  let facts = new Map();
  if (file && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.worldId !== worldId || saved.version !== 1) throw new Error('Spatial knowledge world/version mismatch');
    facts = new Map(saved.facts);
  }
  let dirty = false;
  let writing = Promise.resolve();

  function record(kind, name, position, dimension, at) {
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return;
    const cell = [position.x, position.y, position.z].map(value => Math.floor(value / 16));
    const key = JSON.stringify([dimension, kind, name, ...cell]);
    const old = facts.get(key);
    facts.delete(key);
    facts.set(key, { kind, name, dimension, position: { x: position.x, y: position.y, z: position.z }, firstSeen: old?.firstSeen ?? at, lastSeen: at });
    dirty = true;
  }

  return {
    worldId,
    observe({ position, dimension, at = new Date().toISOString(), biome, entities = [], blocks = [] }) {
      if (typeof dimension !== 'string') return;
      if (position) record('visited', 'visited', position, dimension, at);
      if (biome) record('biome', biome.name, biome.position ?? position, dimension, at);
      for (const entity of entities) if (entity.name) record('entity', entity.name, entity.position, dimension, at);
      for (const block of blocks) if (block && !['air', 'cave_air', 'void_air'].includes(block.name)) record('block', block.name, block.position, dimension, at);
    },
    locations({ kind, names, dimension, limit } = {}) {
      if (kind !== undefined && !KINDS.includes(kind)) throw new Error(`kind must be ${KINDS.join(', ')}`);
      namesValue(names);
      limit = limitValue(limit);
      const matches = [...facts.values()].reverse().filter(fact => (!kind || fact.kind === kind) && (!names || names.includes(fact.name)) && (!dimension || fact.dimension === dimension));
      return { worldId, historical: true, locations: matches.slice(0, limit).map(value => structuredClone(value)), truncated: matches.length > limit };
    },
    flush() {
      if (!file || !dirty) return writing;
      const data = JSON.stringify({ version: 1, worldId, facts: [...facts] });
      dirty = false;
      const save = async () => {
        try {
          await mkdir(directory, { recursive: true });
          await writeFile(`${file}.tmp`, data, { mode: 0o640 });
          await rename(`${file}.tmp`, file);
        } catch (error) {
          dirty = true;
          throw error;
        }
      };
      // A failed flush stays visible to its caller; a later explicit flush retries.
      writing = writing.then(save, save);
      return writing;
    }
  };
}
