import test from 'node:test';
import assert from 'node:assert/strict';
import { initialEvidence, observeEvidence, resetSinceReview } from '../evidence.mjs';

const at = '2026-11-01T15:00:00Z';
function observation(events = [], overrides = {}) {
  return { updatedAt: at, bots: { Roy: {
    name: 'Roy', session: 'session-a', controllerRevision: 'rev-a', status: 'online',
    health: 20, food: 20, inventory: [], dimension: 'overworld', position: { x: 0, y: 70, z: 0 },
    events: events.map((event, index) => ({ session: 'session-a', sequence: index + 1, at, ...event })), ...overrides,
  } } };
}
const failure = (attemptId, overrides = {}) => ({ type: 'attempt_failed', data: {
  attemptId, missionId: 'mission-a', action: 'gather', target: 'oak_log', kind: 'navigation',
  reason: 'No path', controllerRevision: 'rev-a', preconditions: 'terrain-a', ...overrides,
} });
const observe = (events, overrides) => observeEvidence(initialEvidence(), observation(events, overrides));

test('JSON restart and repeated snapshots do not recount death, meal, craft or mining', () => {
  const snapshot = observation([
    { type: 'death' }, { type: 'eat', data: { item: 'apple', count: 1, food: 8, health: 20 } },
    { type: 'craft', data: { item: 'stick', count: 4 } },
    { type: 'gather', data: { material: 'stone', position: { x: 1, y: 70, z: 0 } } },
  ]);
  const initial = initialEvidence();
  const first = observeEvidence(initial, snapshot);
  assert.equal(initial.totals.deaths, 0);
  assert.deepEqual(first.totals, { deaths: 1, meals: 1, crafted: 4, mined: 1, lodgeVerifiedPlacements: 0 });
  assert.deepEqual(observeEvidence(JSON.parse(JSON.stringify(first)), snapshot), first);
});

test('missing sequences are explicit gaps and a new session does not invent a death', () => {
  const snapshot = observation([{ type: 'death', sequence: 4 }]);
  const first = observeEvidence(initialEvidence(), snapshot);
  assert.equal(first.evidenceGapCount, 3);
  assert.equal(observeEvidence(first, snapshot).evidenceGapCount, 3);
  const next = observeEvidence(first, observation([], { session: 'session-b' }));
  assert.deepEqual(next.cursors.Roy, { session: 'session-b', sequence: 0 });
  assert.equal(next.totals.deaths, 1);
});

test('online telemetry requires a session, starting/offline may omit one', () => {
  assert.throws(() => observe([], { session: undefined }), /requires a producer session/);
  assert.equal(observe([], { session: undefined, status: 'starting' }).current.Roy.inventory, null);
  assert.throws(() => observe([{ type: 'death', session: 'wrong' }]), /Invalid sequenced event/);
});

test('offline and omitted bot inventories are unknown, not lost; last-known state survives', () => {
  const first = observe([], { inventory: [{ name: 'stone_pickaxe', count: 1 }] });
  for (const snapshot of [observation([], { status: 'offline' }), { bots: {}, updatedAt: at }]) {
    const next = observeEvidence(first, snapshot);
    assert.equal(next.current.Roy.inventory, null);
    assert.deepEqual(next.lastKnown.Roy.inventory, [{ name: 'stone_pickaxe', count: 1 }]);
    assert.equal(next.achievements.stone.firstSeen, at);
    assert.equal(next.sinceReview.foodEquipmentChanges.Roy.after, null);
    assert.equal(next.progressFingerprint, first.progressFingerprint);
  }
});

test('consumed food is a meal, not lost progress; reset establishes food/equipment baseline', () => {
  const first = observe([], { food: 5, inventory: [{ name: 'apple', count: 2 }, { name: 'iron_pickaxe', count: 1 }] });
  const next = observeEvidence(resetSinceReview(first), observation([
    { type: 'eat', data: { item: 'apple', count: 1, food: 9, health: 20 } },
  ], { food: 9, inventory: [{ name: 'apple', count: 1 }] }));
  assert.equal(next.sinceReview.counters.meals, 1);
  assert.deepEqual(next.sinceReview.foodEquipmentChanges.Roy, {
    before: { food: 5, equipment: [{ name: 'iron_pickaxe', count: 1 }] }, after: { food: 9, equipment: [] },
  });
  assert.equal(next.progressFingerprint, first.progressFingerprint);
  assert.equal(next.inventoryMax.apple, 2);
  assert.equal(next.achievements.iron.firstSeen, at);
  assert.deepEqual(next.current.Roy.inventory, [{ name: 'apple', count: 1 }]);
});

test('verified actual lodge positions count once, never air or model text or complete-house claims', () => {
  const good = { scope: 'lodge', verified: true, material: 'oak_planks', position: { x: 2, y: 70, z: 3 } };
  const build = data => ({ type: 'build', data });
  const first = observe([
    build('Built a house'), build({ ...good, material: 'air' }), build({ ...good, material: 'minecraft:cave_air' }),
    build({ ...good, verified: false }), build({ ...good, position: 'house' }), build(good), build(good),
  ]);
  assert.equal(first.totals.lodgeVerifiedPlacements, 1);
  assert.equal(first.achievements.lodge.firstSeen, at);
  const next = observeEvidence(first, observation([{ ...build(good), session: 'session-b' }], { session: 'session-b' }));
  assert.equal(next.totals.lodgeVerifiedPlacements, 1);
  assert.equal(next.achievements.lodgeComplete, undefined);
});

test('blockers separate revisions and preconditions, deduplicate attempts and survive reset', () => {
  const events = [failure('one'), failure('one'), failure('two'), failure('three'),
    failure('four', { controllerRevision: 'rev-b' }), failure('five', { preconditions: 'terrain-b' })];
  const first = observe(events);
  assert.equal(first.blockers.length, 3);
  assert.equal(first.blockers[0].count, 3);
  assert.deepEqual(first.blockers[0].attemptIds, ['one', 'two', 'three']);
  const reset = resetSinceReview(first);
  assert.deepEqual(reset.blockers, first.blockers);
  assert.deepEqual(reset.cursors, first.cursors);
  assert.deepEqual(reset.totals, first.totals);
  assert.deepEqual(reset.sinceReview.counters, initialEvidence().totals);
  assert.deepEqual(observeEvidence(reset, observation(events)).blockers, first.blockers);
});

test('bounded blocker card preserves frequent failures and reports evicted coverage', () => {
  const first = observe([failure('one'), failure('two'), failure('three'), failure('four'),
    ...Array.from({ length: 15 }, (_, i) => failure(`other-${i}`, { target: `target-${i}` }))]);
  assert.equal(first.blockers.length, 12);
  assert.equal(first.coverageGaps.blockers, 4);
  assert.equal(first.blockers[0].count, 4);
  assert.deepEqual(first.blockers[0].attemptIds, ['two', 'three', 'four']);
});

const programData = (overrides = {}) => ({
  attemptId: 'run-1', missionId: 'mission-a', controllerRevision: 'rev-a', preconditions: 'terrain-a',
  program: [{ action: 'ensure_item', item: 'stone_pickaxe', count: 1 }], ...overrides,
});
const completed = (overrides = {}) => ({ type: 'attempt_completed', data: programData({
  inventory: [{ name: 'stone_pickaxe', count: 1 }], food: 14, health: 20, ...overrides,
}) });

test('verified declarative programs survive JSON restart and snapshot replay; versions remain separate', () => {
  const events = [{ type: 'attempt_started', data: programData() }, completed()];
  const first = observe(events);
  assert.equal(first.verifiedPrograms.length, 1);
  assert.equal(first.verifiedPrograms[0].attempts, 1);
  assert.equal(first.verifiedPrograms[0].successes, 1);
  assert.deepEqual(first.verifiedPrograms[0].actualEndState, { inventory: [{ name: 'stone_pickaxe', count: 1 }], food: 14, health: 20 });
  const restart = JSON.parse(JSON.stringify(first));
  assert.deepEqual(observeEvidence(restart, observation(events)), first);
  const next = observeEvidence(restart, observation([...events, completed({ controllerRevision: 'rev-b', attemptId: 'run-2' })]));
  assert.equal(next.verifiedPrograms.length, 2);
  assert.deepEqual(resetSinceReview(next).verifiedPrograms, next.verifiedPrograms);
});

test('unverified sequences never become reusable, failed follow-up does not retire a verified example', () => {
  assert.deepEqual(observe([{ type: 'attempt_started', data: programData() }]).verifiedPrograms, []);
  const first = observe([completed(), failure('run-2', { program: programData().program })]);
  assert.equal(first.verifiedPrograms.length, 1);
  assert.equal(first.verifiedPrograms[0].successes, 1);
  assert.equal(first.verifiedPrograms[0].attempts, 2);
  assert.throws(() => observe([completed({ program: [{ action: 'eval', code: 'anything' }] })]), /declarative/);
  assert.throws(() => observe([completed({ food: undefined })]), /actual end/);
});

test('verified reusable examples are bounded to eight recent contexts', () => {
  const first = observe(Array.from({ length: 12 }, (_, i) => completed({ controllerRevision: `rev-${i}`, attemptId: `run-${i}` })));
  assert.equal(first.verifiedPrograms.length, 8);
});
