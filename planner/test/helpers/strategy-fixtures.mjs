import assert from 'node:assert/strict';
import { initialEvidence, observeEvidence } from '../../evidence.mjs';
import { strategyContext } from '../../strategy.mjs';

export function fakeEngine(overrides = {}, initial = {}) {
  let state = {
    revision: 0, strategy: null, evidence: null, mission: null,
    lastReviewAt: 0, lastTriggerFingerprint: null, ...structuredClone(initial),
  };
  function persist(expectedRevision, next) {
    assert.equal(expectedRevision, state.revision, 'test engine rejects stale state writes');
    state = structuredClone({ ...next, revision: state.revision + 1 });
    return structuredClone(state);
  }
  return {
    getAdventureState: async () => structuredClone(state),
    recordEvidence: async ({ expectedRevision, evidence, lastTriggerFingerprint = state.lastTriggerFingerprint }) => persist(expectedRevision, { ...state, evidence, lastTriggerFingerprint }),
    commitAdventureState: async ({ expectedRevision, next }) => persist(expectedRevision, next),
    close: async () => {},
    ...overrides,
  };
}

export function observation(overrides = {}) {
  const updatedAt = new Date(Date.now()).toISOString();
  return {
    updatedAt, milestones: [], home: null,
    bots: [{ name: 'Roy', status: 'online', updatedAt, session: 'roy-session',
      health: 16, food: 8, inventory: [], dimension: 'overworld',
      position: { x: 0, y: 64, z: 0 }, events: [] }],
    ...overrides,
  };
}

export function review(mission, overrides = {}) {
  return {
    strategy: {
      goal: { id: 'roy-food', title: 'Restore Roy food reserves', owner: 'Roy', dependsOn: [],
        success: [{ metric: 'food', bot: 'Roy', min: 18 }] },
      decision: 'continue', basis: 'initial', reason: 'Roy needs food before building.',
      adaptation: 'Gather accessible food before regrouping.', nextGoals: ['Prepare building supplies'],
      ...overrides,
    },
    mission,
  };
}

export function pendingReview(observed, overrides = {}) {
  const evidence = observeEvidence(initialEvidence(), observed);
  const trigger = { kind: 'initial', fingerprint: 'initial' };
  return {
    version: 2, id: 'recovered-review', stateRevision: 1, dispatchedAt: Date.parse(observed.updatedAt), trigger, observed, evidence,
    previousMission: null, previousStrategy: null,
    context: strategyContext({ strategy: null }, evidence, observed, trigger),
    ...overrides,
  };
}
