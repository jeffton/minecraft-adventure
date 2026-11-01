import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function validName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Skill name must be a lowercase slug (1–64 characters)');
  return name;
}
function count(snapshot, name) {
  return snapshot.inventory.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
}
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function blockAt(snapshot, p) {
  return snapshot.blocks?.find(block => block.position.x === p.x && block.position.y === p.y && block.position.z === p.z)?.name;
}
function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`Invalid expected ${label}`);
  return value;
}

export class SkillLibrary {
  constructor({ directory }) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o750 });
  }

  path(name) { return join(this.directory, `${validName(name)}.json`); }

  get(name) { return JSON.parse(readFileSync(this.path(name), 'utf8')); }

  save({ name, description, code }) {
    validName(name);
    if (typeof code !== 'string' || !code || Buffer.byteLength(code) > 32_768) throw new Error('Skill source must contain 1–32768 bytes');
    if (typeof description !== 'string' || !description || description.length > 2048) throw new Error('Skill description must contain 1–2048 characters');
    const hash = createHash('sha256').update(code).digest('hex');
    let previous;
    try { previous = this.get(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const skill = { name, description, code, hash, savedAt: new Date().toISOString(), verification: previous?.hash === hash ? previous.verification : [] };
    this.write(skill);
    return skill;
  }

  list() {
    return readdirSync(this.directory).filter(file => /^[a-z][a-z0-9_-]{0,63}\.json$/.test(file)).sort().map(file => {
      const { name, description, hash, verification } = this.get(file.slice(0, -5));
      return { name, description, hash, verifiedWorlds: [...new Set(verification.map(entry => entry.worldId))] };
    });
  }

  write(skill) {
    const path = this.path(skill.name);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(skill), { mode: 0o640 });
    renameSync(temp, path);
  }

  /** Called by trusted host tools with a status obtained directly from SkillSandbox, never model-supplied evidence. */
  verify(name, { worldId, action, expected }) {
    const skill = this.get(name);
    if (!worldId || action.worldId !== worldId) throw new Error('Skill evidence belongs to a different world');
    if (action.sourceHash !== skill.hash) throw new Error('Skill source does not match action evidence');
    if (action.state !== 'completed' || action.stopError || action.observationError || !action.before || !action.after) {
      throw new Error('Only completed actions with host observations can verify a skill');
    }
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('Explicit expected postconditions are required');
    if (Object.keys(expected).some(key => !['inventory', 'inventoryDelta', 'position', 'health', 'blocks'].includes(key))) {
      throw new Error('Unknown skill postcondition');
    }
    let conditions = 0;
    let changed = false;
    const checks = [];
    for (const [item, minimum] of Object.entries(expected.inventory ?? {})) {
      finite(minimum, 'inventory minimum');
      if (minimum < 1) throw new Error('Inventory minimum must be positive');
      const before = count(action.before, item);
      const after = count(action.after, item);
      if (after < minimum) throw new Error(`Expected at least ${minimum} ${item}; observed ${after}`);
      changed ||= after > before;
      checks.push({ kind: 'inventory', item, before, after, minimum });
      conditions++;
    }
    for (const [item, minimum] of Object.entries(expected.inventoryDelta ?? {})) {
      finite(minimum, 'inventory increase');
      if (minimum <= 0) throw new Error('Inventory increase must be positive');
      const before = count(action.before, item);
      const after = count(action.after, item);
      if (after - before < minimum) throw new Error(`Expected ${item} increase of ${minimum}; observed ${after - before}`);
      changed = true;
      checks.push({ kind: 'inventoryDelta', item, before, after, minimum });
      conditions++;
    }
    if (expected.position) {
      const target = expected.position;
      for (const axis of ['x', 'y', 'z']) finite(target[axis], `position.${axis}`);
      finite(target.within, 'position.within');
      if (target.within < 0 || target.within > 16) throw new Error('Position tolerance must be 0–16 blocks');
      if (action.before.dimension !== action.after.dimension) throw new Error('Position evidence crossed dimensions');
      const before = distance(action.before.position, target);
      const after = distance(action.after.position, target);
      if (after > target.within) throw new Error('Expected destination was not reached');
      changed ||= before > target.within;
      checks.push({ kind: 'position', before, after, target });
      conditions++;
    }
    if (expected.health) {
      const minimum = finite(expected.health.min, 'health minimum');
      if (minimum <= 0 || minimum > 20) throw new Error('Health minimum must be 1–20');
      if (action.after.health < minimum) throw new Error('Expected health was not reached');
      changed ||= action.after.health > action.before.health;
      checks.push({ kind: 'health', before: action.before.health, after: action.after.health, minimum });
      conditions++;
    }
    for (const target of expected.blocks ?? []) {
      for (const axis of ['x', 'y', 'z']) finite(target[axis], `block.${axis}`);
      if (typeof target.name !== 'string') throw new Error('Expected block name is required');
      if (action.before.dimension !== action.after.dimension) throw new Error('Block evidence crossed dimensions');
      const before = blockAt(action.before, target);
      const after = blockAt(action.after, target);
      if (after !== target.name) throw new Error(`Expected ${target.name} at ${target.x},${target.y},${target.z}; observed ${after}`);
      // Unknown is not evidence of a change. A pre-action snapshot must have observed the old block.
      changed ||= before !== undefined && before !== after;
      checks.push({ kind: 'block', target, before: before ?? null, after });
      conditions++;
    }
    if (!conditions || !changed) throw new Error('Verification requires explicit postconditions and relevant observed progress');
    const evidence = { worldId, actionId: action.id, sourceHash: skill.hash, verifiedAt: new Date().toISOString(), checks };
    skill.verification = [...skill.verification.filter(entry => entry.actionId !== action.id), evidence].slice(-32);
    this.write(skill);
    return evidence;
  }
}

export { SkillLibrary as SkillStore };
