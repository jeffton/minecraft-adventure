import { skillEvidence } from './observations.mjs';

const AIR = new Set(['air', 'cave_air', 'void_air']);

/** Model projection only; authoritative full observations remain in sandbox evidence. */
export function observationFeedback(observed) {
  return {
    ...observed,
    blocks: observed.blocks.filter(block => !AIR.has(block.name)),
    localBlocks: 'Non-air received blocks near the player. Air is omitted; use blockAt for an exact coordinate.',
  };
}

function playerFacts(observed) {
  if (!observed) return undefined;
  const { at, health, food, oxygen, position, dimension, inventory, heldItem, time } = observed;
  return { at, health, food, oxygen, position, dimension, inventory, heldItem, time };
}

function valueFeedback(value) {
  if (Array.isArray(value)) return value.map(valueFeedback);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value.inventory) && Array.isArray(value.blocks) && value.position) return observationFeedback(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valueFeedback(item)]));
}

export function actionFeedback(action) {
  if (!action) return null;
  return {
    id: action.id, name: action.name, state: action.state, settled: action.settled,
    startedAt: action.startedAt, completedAt: action.completedAt,
    error: action.error, stopError: action.stopError,
    before: playerFacts(action.before), after: playerFacts(action.after),
    effects: action.before && action.after ? skillEvidence(action.before, action.after) : undefined,
    totalCalls: action.callCount, history: action.history, waitingOnly: action.waitingOnly, failureStreak: action.failureStreak,
    calls: action.calls.map(({ method, args, error, completedAt }) => ({ method, args, error, completedAt })),
    untrustedValue: valueFeedback(action.value),
  };
}
