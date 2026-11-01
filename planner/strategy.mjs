import { createHash } from 'node:crypto';
import { BOT_NAMES, validatePlan } from './contracts.mjs';
import { ACQUISITION_ITEMS, BASE_ACTION_KEYS } from '../bots/program.mjs';
import { MEAL_EVIDENCE_VERSION } from './evidence.mjs';
import itemRegistry from './item-ids.json' with { type: 'json' };

const items = new Set(itemRegistry.items);
const earlyMilestones = new Set(['settled', 'stone', 'iron', 'lodge']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const words = (value, name, max = 600) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid strategy ${name}`);
  return value;
};
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid strategy goal ID');
  return value;
};

export const STRATEGY_INSTRUCTIONS = `You coordinate a persistent survival expedition. Return ONLY JSON:
{"strategy":{"goal":{"id":"stable-kebab-id","title":"specific achievable objective","owner":"Roy|Moss|Flint|Spruce|team","dependsOn":["completed-goal-id"],"success":[{"metric":"food|health|inventory|near_home|lodge_placements|milestone","bot":"Roy|Moss|Flint|Spruce","item":"only for inventory","min":1,"id":"only for milestone","maxDistance":4}]},"decision":"continue|switch","basis":"initial|progress|blocked|completed|recovery","reason":"why this intervention follows the supplied evidence","nextGoals":["short dependency-ordered next objective"],"adaptation":"specific changed behavior or reason to reuse a verified program"},"mission":THE_EXISTING_MISSION_SCHEMA}.
Criteria use ONLY applicable fields: food/health={metric,bot,min}; inventory={metric,bot,item,min}; near_home={metric,bot,maxDistance}; lodge_placements={metric,min}; milestone={metric,id} with id settled/stone/iron/lodge. Use 1-12 measurable criteria, no subjective or imagined completion. Inventory goals use supported acquisition items and minima 1-64; unsupported items may only describe an already observed owned inventory. The controller evaluates them, not you. A historical item achievement is NOT current equipment; the first lodge placement is NOT a completed building. Offline inventories are unknown. Home is a coordinate, not shelter. Ground truth state and earned resources override all earlier plans.
Keep the same goal ID AND unchanged success criteria while continuing an objective. Changing criteria requires an explained switch with a new goal ID. Only evidence.totals.meals counts verified server consumption. unverifiedMealEvents and older narrative meal claims are not confirmed meals. dependsOn contains ONLY IDs in completedGoals. nextGoals is a bounded roadmap, not executable claims. The current action API cannot enter portals or defeat the dragon: do not promise these actions. Shared chest operations are the supported supply-sharing mechanism, not remote access to another player's inventory. A future API extension is a blocker, not an imaginary implemented skill. Address each bot's hunger/health before long journeys or building; they cannot borrow another bot's inventory. Use short urgent food batches, not a large hunting quota that prevents later preparation. After immediate food, acquire and explicitly equip a personal weapon: stone_sword when stone/pickaxe is available, otherwise wooden_sword from earned wood. Existing suitable swords/axes may be equipped rather than crafting a weaker duplicate. Put ensure_item then equip in the actual program before distant regrouping/exploration; never rely on prose promising weapons. Local threat assessment handles fight versus bounded retreat without model calls per hit. Prefer held or nearby supported wood species, achievable batches and exposed blocks. A failed resource search is a precondition problem, not evidence to retry the identical request forever.
Prioritize a reachable operational base immediately after urgent food and defence: real shelter placements, an early shared chest with confirmed deposit/withdraw, then personal beds and verified spawn acknowledgement. Do not postpone these behind decorative work, distant mining or large material/equipment quotas. Distinct bot jobs must unblock this dependency chain using available local wood and already owned supplies. Keep food, tools and a weapon personally; secure surplus in the chest. A historical placement is not a completed shelter, and a crafted/placed bed is not confirmed personal spawn. Use current inventory criteria for acquiring a chest or bed, lodge_placements for incremental building, and observed utility results for subsequent decisions; never invent an unsupported success metric. Reuse tactic and action knowledge in a new world, but derive home, resources, ownership and completed goals solely from that world's observations.
Use sinceReview, current-vs-baseline goal scores, repeated blocker context and intervention history to continue or change strategy. When program_completed triggers a review, give that bot its next feasible program while teammates continue valid work; a finished short program is not a reason to leave the bot idle until the five-minute cadence. Three unchanged-context failures with no goal progress require a changed intervention or an explicit concrete reason. Verified programs are examples checked by the existing controller; reuse only when their controller revision and relevant preconditions still apply, and recheck the same postconditions. Never generate JavaScript. Four bots' fast navigation/combat/eating remain local code; you plan missions, not individual ticks.`;

function validateCriterion(value, evidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid strategy success criterion');
  const fields = {
    food: ['metric', 'bot', 'min'], health: ['metric', 'bot', 'min'],
    inventory: ['metric', 'bot', 'item', 'min'], near_home: ['metric', 'bot', 'maxDistance'],
    lodge_placements: ['metric', 'min'], milestone: ['metric', 'id'],
  }[value.metric];
  if (!fields || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error('Unsupported strategy success criterion');
  if (fields.includes('bot') && !BOT_NAMES.includes(value.bot)) throw new Error('Invalid criterion bot');
  if (fields.includes('min') && (!Number.isInteger(value.min) || value.min < 1 || value.min > (['food', 'health'].includes(value.metric) ? 20 : 4096))) throw new Error('Invalid criterion minimum');
  if (value.metric === 'inventory') {
    if (!items.has(value.item)) throw new Error('Invalid criterion item');
    if (value.min > 64) throw new Error('Inventory objective exceeds the controller acquisition minimum limit');
    const current = evidence.current[value.bot];
    const owned = current?.status === 'online' ? current.inventory.filter(item => item.name === value.item).reduce((sum, item) => sum + item.count, 0) : 0;
    if (!ACQUISITION_ITEMS.includes(value.item) && owned < value.min) throw new Error('Inventory objective requires an unimplemented acquisition capability');
  }
  if (value.metric === 'near_home' && (!Number.isFinite(value.maxDistance) || value.maxDistance < 1 || value.maxDistance > 16)) throw new Error('Invalid home distance criterion');
  if (value.metric === 'milestone' && !earlyMilestones.has(value.id)) throw new Error('Current controller cannot execute this milestone');
  return structuredClone(value);
}

export function evaluateGoal(goal, evidence, observed) {
  const criteria = goal.success.map(criterion => {
    const bot = evidence.current[criterion.bot];
    let value = null;
    let met = false;
    let score = null;
    if (criterion.metric === 'milestone') {
      const milestone = observed.milestones.find(entry => entry.id === criterion.id);
      value = milestone?.completed === true ? 1 : 0;
      score = value;
      met = value === 1;
    } else if (criterion.metric === 'lodge_placements') {
      value = evidence.totals.lodgeVerifiedPlacements;
      score = value;
      met = value >= criterion.min;
    } else if (bot?.status === 'online') {
      if (criterion.metric === 'inventory') value = bot.inventory.filter(item => item.name === criterion.item).reduce((sum, item) => sum + item.count, 0);
      else if (criterion.metric === 'near_home') {
        if (observed.home && bot.position && observed.home.dimension === bot.dimension) {
          value = Math.hypot(...['x', 'y', 'z'].map(axis => bot.position[axis] - observed.home[axis]));
        }
      } else value = bot[criterion.metric];
      if (value !== null) {
        score = criterion.metric === 'near_home' ? -value : value;
        met = criterion.metric === 'near_home' ? value <= criterion.maxDistance : value >= criterion.min;
      }
    }
    return { criterion, value, score, met, known: value !== null };
  });
  return { complete: criteria.every(criterion => criterion.known && criterion.met), criteria };
}

export function goalAdvanced(strategy, evidence, observed) {
  const current = evaluateGoal(strategy.goal, evidence, observed);
  return current.criteria.some((criterion, index) => criterion.score !== null && strategy.baseline.criteria[index].score !== null && criterion.score > strategy.baseline.criteria[index].score);
}

export function validateReview(answer, previous, evidence, observed) {
  const card = answer?.strategy;
  const goal = card?.goal;
  if (!card || !goal || !['continue', 'switch'].includes(card.decision) || !['initial', 'progress', 'blocked', 'completed', 'recovery'].includes(card.basis)) throw new Error('Invalid strategy decision');
  identifier(goal.id);
  words(goal.title, 'goal title', 160);
  if (!BOT_NAMES.includes(goal.owner) && goal.owner !== 'team') throw new Error('Invalid goal owner');
  if (!Array.isArray(goal.dependsOn) || goal.dependsOn.length > 8 || !Array.isArray(goal.success) || !goal.success.length || goal.success.length > 12) throw new Error('Invalid goal dependencies or criteria');
  const completedGoals = [...(previous?.completedGoals ?? [])];
  if (previous && evaluateGoal(previous.goal, evidence, observed).complete && !completedGoals.some(entry => entry.id === previous.goal.id)) {
    completedGoals.push({ id: previous.goal.id, title: previous.goal.title, at: observed.updatedAt });
  }
  if (goal.dependsOn.some(id => !completedGoals.some(entry => entry.id === id))) throw new Error('Goal dependencies have not been observed complete');
  if (previous && (card.decision === 'continue') !== (goal.id === previous.goal.id)) throw new Error('Strategy decision must match goal identity');
  if (previous && card.basis === 'initial') throw new Error('Existing strategy requires an evidence-based decision');
  if (card.basis === 'completed' && (!previous || !evaluateGoal(previous.goal, evidence, observed).complete)) throw new Error('Previous goal completion is not observed');
  const success = goal.success.map(criterion => validateCriterion(criterion, evidence));
  if (previous?.goal.id === goal.id && JSON.stringify(previous.goal.success) !== JSON.stringify(success)) throw new Error('Changing goal criteria requires a new goal ID');
  if (!Array.isArray(card.nextGoals) || card.nextGoals.length > 4) throw new Error('Invalid strategy roadmap');
  const mission = validatePlan(answer.mission);
  const strategy = {
    goal: { id: goal.id, title: goal.title, owner: goal.owner, dependsOn: [...goal.dependsOn], success },
    decision: card.decision, basis: card.basis,
    reason: words(card.reason, 'reason'), adaptation: words(card.adaptation, 'adaptation'),
    nextGoals: card.nextGoals.map(value => words(value, 'next objective', 180)),
    reviewedAt: observed.updatedAt, completedGoals: completedGoals.slice(-16),
    blockerBaseline: Object.fromEntries(evidence.blockers.map(blocker => [blocker.key, blocker.count])),
    history: [...(previous?.history ?? []).map(entry => entry.mealEvidence === MEAL_EVIDENCE_VERSION ? entry : {
      ...entry, mealEvidence: MEAL_EVIDENCE_VERSION, unverifiedMealEvents: entry.counters.meals,
      counters: { ...entry.counters, meals: 0 },
    }), ...(previous ? [{
      goalId: previous.goal.id, intervention: previous.adaptation, reviewedAt: previous.reviewedAt,
      outcome: evaluateGoal(previous.goal, evidence, observed), counters: evidence.sinceReview.counters,
      mealEvidence: evidence.mealEvidence,
      changes: evidence.sinceReview.foodEquipmentChanges,
    }] : [])].slice(-4),
  };
  strategy.baseline = evaluateGoal(strategy.goal, evidence, observed);
  return { strategy, mission };
}

export function reviewTrigger(state, evidence, observed, now, lastAttempt, intervalMs) {
  if (!state.strategy) {
    return now - lastAttempt >= intervalMs ? { kind: 'initial', fingerprint: 'initial' } : null;
  }
  const strategy = state.strategy;
  const complete = evaluateGoal(strategy.goal, evidence, observed).complete;
  const completedFingerprint = `completed:${strategy.goal.id}`;
  if (complete && !strategy.baseline.complete && state.lastTriggerFingerprint !== completedFingerprint) return { kind: 'completed', fingerprint: completedFingerprint };
  const bots = Array.isArray(observed.bots) ? observed.bots : Object.values(observed.bots);
  const finished = bots.flatMap(bot => bot.events).filter(event => event.type === 'attempt_completed' &&
    event.data.missionId === state.mission?.id && Number.isInteger(event.data.operations) && event.data.operations > 0);
  if (finished.length) {
    const fingerprint = `program-completed:${state.mission.id}:${finished.map(event => event.data.attemptId).sort().join(',')}`;
    if (state.lastTriggerFingerprint !== fingerprint) return { kind: 'program_completed', fingerprint };
  }
  if (!complete && !goalAdvanced(strategy, evidence, observed)) {
    const blocker = evidence.blockers.find(entry => entry.kind !== 'interrupted' && entry.attemptIds.length >= 3 && entry.count - (strategy.blockerBaseline[entry.key] ?? 0) >= 3);
    if (blocker) {
      const fingerprint = `stagnation:${strategy.goal.id}:${blocker.key}:${Math.floor(blocker.count / 3)}`;
      if (state.lastTriggerFingerprint !== fingerprint) return { kind: 'stagnation', fingerprint };
    }
  }
  return now - lastAttempt >= intervalMs ? { kind: 'cadence', fingerprint: `cadence:${Math.floor(now / intervalMs)}` } : null;
}

export function strategyContext(state, evidence, observed, trigger) {
  const { cursors, verifiedLodgePositions, ...card } = evidence;
  return {
    trigger: trigger.kind, strategy: state.strategy, evidence: card,
    currentGoal: state.strategy ? evaluateGoal(state.strategy.goal, evidence, observed) : null,
    capabilities: { actions: ['ensure_item', 'equip', 'build_lodge', 'regroup', ...Object.keys(BASE_ACTION_KEYS)], acquirableItems: ACQUISITION_ITEMS },
    contextFingerprint: digest([state.strategy?.goal.id, evidence.progressFingerprint]),
  };
}
