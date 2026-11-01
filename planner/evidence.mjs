import { createHash } from 'node:crypto';

// Pure, JSON-roundtrippable evidence card. Input: {updatedAt, bots: {name: bot}}
// (or a bots array with name). Events start at sequence 1 in each UUID session.
// Producer contract: one attempt UUID per executeProgram run; exactly ONE terminal
// completed OR failed event, never re-emitted at a new sequence. The last-three
// ID windows support triggers, not arbitrary historical duplicate-ID detection.
// Counters describe observed events, never inferred losses or model claims. 'lodge'
// means first verified lodge placement, NOT a completed building. Placement keys
// are capped at 4096 (one small lodge); overflow is explicitly incomplete evidence.
const MAX_BLOCKERS = 12;
const MAX_PLACEMENTS = 4096;
const counterNames = ['deaths', 'meals', 'crafted', 'mined', 'lodgeVerifiedPlacements'];
const counters = () => Object.fromEntries(counterNames.map(name => [name, 0]));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equipment = inventory => inventory.filter(item => /_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|elytra)$/.test(item.name));
const equipmentView = bot => ({ food: bot.food, equipment: equipment(bot.inventory) });

export function initialEvidence() {
  return {
    cursors: {}, totals: counters(), achievements: {}, current: {}, lastKnown: {},
    inventoryMax: {}, blockers: [], verifiedLodgePositions: [], verifiedPrograms: [],
    evidenceGapCount: 0, coverageGaps: { events: 0, blockers: 0, placements: 0 },
    sinceReview: { counters: counters(), baseline: {}, foodEquipmentChanges: {} },
    progressSummary: {}, progressFingerprint: null,
  };
}

function recordGap(evidence, category, count) {
  evidence.coverageGaps[category] += count;
  evidence.evidenceGapCount += count;
}

function increment(evidence, name, count) {
  evidence.totals[name] += count;
  evidence.sinceReview.counters[name] += count;
}

function achievement(evidence, key, at) {
  if (!Object.hasOwn(evidence.achievements, key)) evidence.achievements[key] = { firstSeen: at };
}

function count(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${label} count`);
  return value;
}

// Programs are declarative evidence examples, never executable JavaScript. A
// completion asserts the controller checked ALL postconditions. Only completions
// introduce catalog entries; starts/failures can update an already verified entry.
// attempts counts observed runs since first verification (not all historical runs).
// completed.data supplies actual inventory, food and health directly.
function observeProgram(evidence, event) {
  const data = event.data;
  if (!Array.isArray(data?.program)) return;
  const actionKeys = { ensure_item: ['action', 'item', 'count'], equip: ['action', 'item'], build_lodge: ['action'], regroup: ['action'] };
  if (!data.program.length || data.program.length > 6 || data.program.some(step => {
    const keys = actionKeys[step?.action];
    return !keys || Object.keys(step).length !== keys.length || keys.some(key => !Object.hasOwn(step, key));
  })) {
    throw new Error('Program evidence requires 1–6 declarative action steps');
  }
  if (!['attemptId', 'controllerRevision', 'preconditions'].every(key => typeof data[key] === 'string' && data[key])) {
    throw new Error('Program evidence requires attempt identity and execution context');
  }
  const key = hash([data.controllerRevision, data.preconditions, data.program]);
  let entry = evidence.verifiedPrograms.find(program => program.key === key);
  if (!entry && event.type !== 'attempt_completed') return;
  if (event.type === 'attempt_completed' && (!Array.isArray(data.inventory) || !Number.isFinite(data.food) || !Number.isFinite(data.health))) {
    throw new Error('Completed program requires actual end inventory, food and health');
  }
  if (!entry) {
    entry = {
      key, controllerRevision: data.controllerRevision, preconditions: data.preconditions,
      program: structuredClone(data.program), attempts: 0, successes: 0,
      attemptIds: [], successfulAttemptIds: [], lastVerifiedAt: null, actualEndState: null,
    };
    evidence.verifiedPrograms.push(entry);
  }
  if (!entry.attemptIds.includes(data.attemptId)) {
    entry.attempts++;
    entry.attemptIds = [...entry.attemptIds, data.attemptId].slice(-3);
  }
  if (event.type === 'attempt_completed' && !entry.successfulAttemptIds.includes(data.attemptId)) {
    entry.successes++;
    entry.successfulAttemptIds = [...entry.successfulAttemptIds, data.attemptId].slice(-3);
    entry.lastVerifiedAt = event.at;
    entry.actualEndState = { inventory: structuredClone(data.inventory), food: data.food, health: data.health };
  }
  evidence.verifiedPrograms.sort((a, b) => b.lastVerifiedAt.localeCompare(a.lastVerifiedAt) || a.key.localeCompare(b.key));
  evidence.verifiedPrograms.length = Math.min(evidence.verifiedPrograms.length, 8);
}

function applyEvent(evidence, bot, event) {
  if (['attempt_started', 'attempt_completed', 'attempt_failed'].includes(event.type)) observeProgram(evidence, event);
  const data = event.data;
  switch (event.type) {
    case 'death': increment(evidence, 'deaths', 1); break;
    case 'eat': increment(evidence, 'meals', count(data.count, 'eat')); break;
    case 'craft': increment(evidence, 'crafted', count(data.count, 'craft')); break;
    case 'gather': increment(evidence, 'mined', 1); break;
    case 'build': {
      if (data?.scope !== 'lodge' || data.verified !== true || typeof data.material !== 'string' ||
          ['air', 'cave_air', 'void_air', 'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(data.material)) break;
      const position = data.position;
      if (!position || !['x', 'y', 'z'].every(axis => Number.isInteger(position[axis]))) break;
      const dimension = data.dimension ?? bot.dimension;
      if (typeof dimension !== 'string' || !dimension) throw new Error('Verified build requires dimension');
      const key = `${dimension}:${position.x},${position.y},${position.z}`;
      if (evidence.verifiedLodgePositions.includes(key)) break;
      if (evidence.verifiedLodgePositions.length >= MAX_PLACEMENTS) {
        recordGap(evidence, 'placements', 1);
        break;
      }
      evidence.verifiedLodgePositions.push(key);
      increment(evidence, 'lodgeVerifiedPlacements', 1);
      achievement(evidence, 'lodge', event.at);
      break;
    }
    case 'attempt_failed': {
      if (!data || typeof data.attemptId !== 'string' || !data.attemptId ||
          !['precondition', 'navigation', 'execution', 'interrupted'].includes(data.kind) ||
          !['action', 'target', 'controllerRevision', 'preconditions', 'reason'].every(key => typeof data[key] === 'string')) {
        throw new Error('Invalid structured attempt_failed evidence');
      }
      const key = hash([data.action, data.target, data.kind, data.controllerRevision, data.preconditions]);
      let blocker = evidence.blockers.find(entry => entry.key === key);
      if (!blocker) {
        blocker = {
          key, action: data.action, target: data.target, kind: data.kind,
          reason: data.reason, controllerRevision: data.controllerRevision,
          preconditions: data.preconditions, count: 0, attemptIds: [], latestAt: event.at,
        };
        evidence.blockers.push(blocker);
      }
      // A bounded last-three-attempt window supports stagnation triggers. Event
      // cursors independently deduplicate snapshot replay across the full session.
      if (!blocker.attemptIds.includes(data.attemptId)) {
        blocker.count++;
        blocker.attemptIds = [...blocker.attemptIds, data.attemptId].slice(-3);
      }
      blocker.latestAt = [blocker.latestAt, event.at].sort().at(-1);
      blocker.reason = data.reason;
      evidence.blockers.sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt) || a.key.localeCompare(b.key));
      if (evidence.blockers.length > MAX_BLOCKERS) {
        evidence.blockers.length = MAX_BLOCKERS;
        recordGap(evidence, 'blockers', 1);
      }
      break;
    }
  }
}

function summarize(evidence) {
  // Monotonic evidence of capability/progress, independent of food consumption,
  // deaths, observation timestamps and repeated failed attempts.
  evidence.progressSummary = {
    crafted: evidence.totals.crafted, mined: evidence.totals.mined,
    lodgeVerifiedPlacements: evidence.totals.lodgeVerifiedPlacements,
    achievements: Object.keys(evidence.achievements).sort(),
    inventoryMax: Object.fromEntries(Object.entries(evidence.inventoryMax).sort(([a], [b]) => a.localeCompare(b))),
  };
  evidence.progressFingerprint = hash(evidence.progressSummary);
}

export function observeEvidence(previous, observed) {
  const evidence = structuredClone(previous);
  const bots = Array.isArray(observed.bots) ? observed.bots.map(bot => [bot.name, bot]) : Object.entries(observed.bots);
  for (const [name, bot] of bots) {
    if (bot.status === 'online' && (typeof bot.session !== 'string' || !bot.session)) {
      throw new Error(`Online bot ${name} requires a producer session`);
    }
    const events = [...(bot.events ?? [])].sort((a, b) => a.sequence - b.sequence);
    if (events.length && !bot.session) throw new Error(`Events for ${name} require a producer session`);
    if (bot.session && evidence.cursors[name]?.session !== bot.session) {
      evidence.cursors[name] = { session: bot.session, sequence: 0 };
    }
    for (const event of events) {
      if (event.session !== bot.session || !Number.isInteger(event.sequence) || event.sequence < 1 || typeof event.at !== 'string') {
        throw new Error(`Invalid sequenced event for ${name}`);
      }
      const cursor = evidence.cursors[name];
      if (event.sequence <= cursor.sequence) continue;
      const missing = event.sequence - cursor.sequence - 1;
      if (missing) recordGap(evidence, 'events', missing);
      applyEvent(evidence, bot, event);
      cursor.sequence = event.sequence;
    }
    if (bot.status !== 'online') {
      evidence.current[name] = { status: bot.status, health: null, food: null, inventory: null, dimension: null, position: null };
      continue;
    }
    const inventory = bot.inventory.map(item => ({ name: item.name, count: item.count })).sort((a, b) => a.name.localeCompare(b.name));
    const current = {
      status: bot.status, health: bot.health, food: bot.food, inventory,
      dimension: bot.dimension, position: structuredClone(bot.position),
    };
    evidence.current[name] = current;
    evidence.lastKnown[name] = { ...structuredClone(current), at: bot.updatedAt ?? observed.updatedAt };
    for (const item of inventory) {
      evidence.inventoryMax[item.name] = Math.max(evidence.inventoryMax[item.name] ?? 0, item.count);
      for (const tier of ['stone', 'iron', 'diamond', 'netherite']) {
        if (item.name.startsWith(`${tier}_`)) achievement(evidence, tier, bot.updatedAt ?? observed.updatedAt);
      }
    }
    if (['the_nether', 'the_end', 'minecraft:the_nether', 'minecraft:the_end'].includes(bot.dimension)) {
      achievement(evidence, bot.dimension.replace('minecraft:', ''), bot.updatedAt ?? observed.updatedAt);
    }
    const after = equipmentView(current);
    evidence.sinceReview.baseline[name] ??= structuredClone(after);
    evidence.sinceReview.foodEquipmentChanges[name] = { before: evidence.sinceReview.baseline[name], after };
  }
  // Missing producers are unknown too: do not keep an online inventory current.
  const present = new Set(bots.map(([name]) => name));
  for (const name of Object.keys(evidence.current)) {
    if (!present.has(name)) evidence.current[name] = { status: 'unknown', health: null, food: null, inventory: null, dimension: null, position: null };
    if (evidence.current[name].status !== 'online' && evidence.sinceReview.foodEquipmentChanges[name]) {
      evidence.sinceReview.foodEquipmentChanges[name].after = null;
    }
  }
  summarize(evidence);
  return evidence;
}

export function resetSinceReview(previous) {
  const evidence = structuredClone(previous);
  const baseline = Object.fromEntries(Object.entries(evidence.current)
    .filter(([, bot]) => bot.status === 'online')
    .map(([name, bot]) => [name, equipmentView(bot)]));
  evidence.sinceReview = { counters: counters(), baseline, foodEquipmentChanges: {} };
  return evidence;
}
