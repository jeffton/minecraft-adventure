import test from 'node:test';
import assert from 'node:assert/strict';
import { initialEvidence, observeEvidence, resetSinceReview } from '../evidence.mjs';
import { evaluateGoal, goalAdvanced, reviewTrigger, strategyContext, validateReview } from '../strategy.mjs';
import { observation, review } from './helpers/strategy-fixtures.mjs';

const mission = {
  phase: 'survival', objective: 'Restore food before building.', home: null,
  bots: Object.fromEntries(['Roy', 'Moss', 'Flint', 'Spruce'].map(name => [name, {
    task: 'Gather accessible food.', program: [{ action: 'ensure_item', item: 'beef', count: 4 }],
  }])),
};
function setup() {
  const observed = observation();
  const evidence = observeEvidence(initialEvidence(), observed);
  const strategy = validateReview(review(mission), null, evidence, observed).strategy;
  return { observed, evidence, strategy };
}
function nextAnswer(strategy, overrides = {}) {
  return review(mission, { ...strategy, basis: 'blocked', ...overrides });
}
function failures(observed, contexts = ['old', 'old', 'old'], attemptIds = ['a', 'b', 'c']) {
  const next = structuredClone(observed);
  next.bots[0].events = contexts.map((controllerRevision, index) => ({
    session: next.bots[0].session, sequence: index + 1, at: next.updatedAt,
    type: 'attempt_failed', data: {
      attemptId: attemptIds[index], action: 'ensure_item', target: 'beef', kind: 'precondition',
      controllerRevision, preconditions: 'no-loaded-cow', reason: 'No loaded cow',
    },
  }));
  return next;
}
const trigger = (strategy, evidence, observed, lastTriggerFingerprint = null) => reviewTrigger(
  { strategy, lastTriggerFingerprint }, evidence, observed, 1000, 999, 300000,
);

test('goal criteria reject subjective, impossible, extra and incorrectly typed measurements', () => {
  const { evidence, observed } = setup();
  const invalid = [
    { metric: 'beautiful_house', min: 1 },
    { metric: 'food', bot: 'Roy', min: 21 },
    { metric: 'health', bot: 'visitor', min: 1 },
    { metric: 'inventory', bot: 'Roy', item: 'imaginary_food', min: 4 },
    { metric: 'near_home', bot: 'Roy', maxDistance: 17 },
    { metric: 'lodge_placements', min: 1.5 },
    { metric: 'milestone', id: 'dragon' },
    { metric: 'food', bot: 'Roy', min: 18, reason: 'trust model' },
  ];
  for (const criterion of invalid) {
    const answer = review(mission);
    answer.strategy.goal.success = [criterion];
    assert.throws(() => validateReview(answer, null, evidence, observed));
  }
});

test('inventory objectives respect the acquisition minimum cap even when more items are already owned', () => {
  const { observed, evidence } = setup();
  const answer = review(mission);
  answer.strategy.goal.success = [{ metric: 'inventory', bot: 'Roy', item: 'oak_log', min: 64 }];
  assert.equal(validateReview(answer, null, evidence, observed).strategy.goal.success[0].min, 64);
  observed.bots[0].inventory = [{ name: 'oak_log', count: 65 }];
  const stocked = observeEvidence(evidence, observed);
  answer.strategy.goal.success[0].min = 65;
  assert.throws(() => validateReview(answer, null, stocked, observed), /Inventory objective exceeds the controller acquisition minimum limit/);
});

test('future equipment objectives cannot bypass capability limits using a real item ID', () => {
  const { observed, evidence } = setup();
  for (const item of ['elytra', 'ender_pearl', 'blaze_rod']) {
    const answer = review(mission);
    answer.strategy.goal.success = [{ metric: 'inventory', bot: 'Roy', item, min: 1 }];
    assert.throws(() => validateReview(answer, null, evidence, observed), /Inventory objective requires an unimplemented acquisition capability/);
  }
});

test('unsupported acquisition is allowed only when that online bot already owns the full objective threshold', () => {
  const { observed, evidence } = setup();
  const answer = review(mission);
  answer.strategy.goal.success = [{ metric: 'inventory', bot: 'Roy', item: 'elytra', min: 2 }];
  observed.bots[0].inventory = [{ name: 'elytra', count: 1 }];
  let seen = observeEvidence(evidence, observed);
  assert.throws(() => validateReview(answer, null, seen, observed), /unimplemented acquisition capability/);
  observed.bots[0].inventory.push({ name: 'elytra', count: 1 });
  seen = observeEvidence(seen, observed);
  const accepted = validateReview(answer, null, seen, observed).strategy;
  assert.equal(evaluateGoal(accepted.goal, seen, observed).complete, true, 'owned stacks satisfy the actual target threshold');
  observed.bots[0].status = 'offline';
  seen = observeEvidence(seen, observed);
  assert.throws(() => validateReview(answer, null, seen, observed), /unimplemented acquisition capability/, 'last-known inventory cannot authorize a future acquisition');
  observed.bots[0].status = 'online';
  observed.bots[0].inventory = [];
  observed.bots.push({ ...structuredClone(observed.bots[0]), name: 'Moss', session: 'moss-session', inventory: [{ name: 'elytra', count: 2 }] });
  seen = observeEvidence(seen, observed);
  assert.throws(() => validateReview(answer, null, seen, observed), /unimplemented acquisition capability/, 'historical maxima and teammate inventories do not satisfy Roy objective');
});

test('same-goal reviews cannot weaken criteria or disguise switches as continuation', () => {
  const { strategy, evidence, observed } = setup();
  const weakened = nextAnswer(strategy);
  weakened.strategy.goal = { ...strategy.goal, success: [{ metric: 'food', bot: 'Roy', min: 1 }] };
  assert.throws(() => validateReview(weakened, strategy, evidence, observed), /criteria/);
  assert.throws(() => validateReview(nextAnswer(strategy, { decision: 'switch' }), strategy, evidence, observed), /identity/);
  const renamed = nextAnswer(strategy, { goal: { ...strategy.goal, id: 'other-goal' } });
  assert.throws(() => validateReview(renamed, strategy, evidence, observed), /identity/);
  assert.deepEqual(validateReview(nextAnswer(strategy), strategy, evidence, observed).strategy.goal, strategy.goal);
});

test('dependencies require measured completion and newly completed goal is available to its successor', () => {
  const { strategy, evidence, observed } = setup();
  const answer = nextAnswer(strategy, {
    decision: 'switch', basis: 'completed',
    goal: { ...strategy.goal, id: 'prepare-tools', dependsOn: ['roy-food'], success: [{ metric: 'inventory', bot: 'Roy', item: 'stone_pickaxe', min: 1 }] },
  });
  assert.throws(() => validateReview(answer, strategy, evidence, observed), /not been observed complete/);
  observed.bots[0].food = 18;
  const fed = observeEvidence(evidence, observed);
  const accepted = validateReview(answer, strategy, fed, observed).strategy;
  assert.deepEqual(accepted.completedGoals.map(goal => goal.id), ['roy-food']);
  assert.deepEqual(accepted.goal.dependsOn, ['roy-food']);
  const invented = structuredClone(answer);
  invented.strategy.goal.dependsOn = ['defeated-dragon'];
  assert.throws(() => validateReview(invented, strategy, fed, observed), /not been observed complete/);
});

test('historical equipment and first lodge placement do not establish current inventory or a complete building', () => {
  const { observed, evidence } = setup();
  observed.bots[0].inventory = [{ name: 'stone_pickaxe', count: 1 }];
  let seen = observeEvidence(evidence, observed);
  observed.bots[0].inventory = [];
  observed.milestones = [{ id: 'lodge', completed: false }];
  seen = observeEvidence(seen, observed);
  seen.achievements.lodge = { firstSeen: observed.updatedAt };
  seen.totals.lodgeVerifiedPlacements = 1;
  const goal = { success: [{ metric: 'inventory', bot: 'Roy', item: 'stone_pickaxe', min: 1 }, { metric: 'milestone', id: 'lodge' }] };
  assert.equal(seen.achievements.stone.firstSeen, observed.updatedAt);
  assert.equal(evaluateGoal(goal, seen, observed).complete, false);
  assert.deepEqual(evaluateGoal(goal, seen, observed).criteria.map(c => c.value), [0, 0]);
  assert.equal(evaluateGoal({ success: [{ metric: 'lodge_placements', min: 1 }] }, seen, observed).complete, true);
});

test('offline equipment, food and distance remain unknown rather than counting last-known facts', () => {
  const { observed, evidence, strategy } = setup();
  observed.home = { dimension: 'overworld', x: 0, y: 64, z: 0 };
  observed.bots[0].food = 20;
  observed.bots[0].inventory = [{ name: 'stone_pickaxe', count: 1 }];
  let seen = observeEvidence(evidence, observed);
  observed.bots[0].status = 'offline';
  seen = observeEvidence(seen, observed);
  const goal = { success: [strategy.goal.success[0], { metric: 'near_home', bot: 'Roy', maxDistance: 4 }, { metric: 'inventory', bot: 'Roy', item: 'stone_pickaxe', min: 1 }] };
  const result = evaluateGoal(goal, seen, observed);
  assert.equal(result.complete, false);
  assert.ok(result.criteria.every(c => !c.known && c.value === null));
});

test('stagnation requires three distinct same-context failures and no measured goal advancement', () => {
  const { observed, evidence, strategy } = setup();
  const repeated = observeEvidence(evidence, failures(observed, ['old', 'old', 'old'], ['a', 'a', 'a']));
  assert.equal(trigger(strategy, repeated, observed), null);
  const revised = observeEvidence(evidence, failures(observed, ['old', 'new', 'new']));
  assert.equal(trigger(strategy, revised, observed), null, 'controller change separates blocker context');
  const stuck = observeEvidence(evidence, failures(observed));
  const event = trigger(strategy, stuck, observed);
  assert.equal(event.kind, 'stagnation');
  assert.equal(trigger(strategy, stuck, observed, event.fingerprint), null, 'identical blocker cannot repeatedly trigger');
  const advanced = structuredClone(observed);
  advanced.bots[0].food++;
  const improving = observeEvidence(stuck, advanced);
  assert.equal(goalAdvanced(strategy, improving, advanced), true);
  assert.equal(trigger(strategy, improving, advanced), null, 'measured goal progress suppresses stagnation');
  const reset = validateReview(nextAnswer(strategy), strategy, stuck, observed).strategy;
  assert.equal(trigger(reset, stuck, observed), null, 'reviewed failures do not count again');
});

test('regroup progress measures decreasing distance only inside the observed home dimension', () => {
  const { evidence, observed } = setup();
  observed.home = { dimension: 'overworld', x: 20, y: 64, z: 0 };
  const answer = review(mission);
  answer.strategy.goal.success = [{ metric: 'near_home', bot: 'Roy', maxDistance: 4 }];
  const strategy = validateReview(answer, null, evidence, observed).strategy;
  observed.bots[0].position.x = 10;
  const closer = observeEvidence(evidence, observed);
  assert.equal(goalAdvanced(strategy, closer, observed), true);
  assert.equal(evaluateGoal(strategy.goal, closer, observed).complete, false);
  observed.bots[0].dimension = 'the_nether';
  const elsewhere = observeEvidence(closer, observed);
  assert.equal(goalAdvanced(strategy, elsewhere, observed), false);
  assert.equal(evaluateGoal(strategy.goal, elsewhere, observed).criteria[0].known, false);
});

test('completion triggers once, and unrelated monotonic progress cannot mask a stuck food goal', () => {
  const { observed, evidence, strategy } = setup();
  const next = failures(observed);
  next.bots[0].inventory = [{ name: 'oak_log', count: 12 }];
  const busy = observeEvidence(evidence, next);
  assert.equal(goalAdvanced(strategy, busy, next), false);
  assert.equal(trigger(strategy, busy, next).kind, 'stagnation');
  next.bots[0].food = 18;
  const complete = observeEvidence(busy, next);
  const event = trigger(strategy, complete, next);
  assert.equal(event.kind, 'completed');
  assert.equal(trigger(strategy, complete, next, event.fingerprint), null);
});

test('strategy context exposes bounded verified programs without event cursors or placement history', () => {
  const observed = observation();
  observed.bots[0].events = Array.from({ length: 12 }, (_, i) => ({
    session: observed.bots[0].session, sequence: i + 1, at: new Date(Date.now() + i).toISOString(),
    type: 'attempt_completed', data: {
      attemptId: `success-${i}`, controllerRevision: 'tested-controller', preconditions: `food-and-tools-${i}`,
      program: [{ action: 'ensure_item', item: 'oak_log', count: i + 1 }],
      inventory: [{ name: 'oak_log', count: i + 1 }], food: 18, health: 20,
    },
  }));
  const evidence = observeEvidence(initialEvidence(), observed);
  const context = strategyContext({ strategy: null }, evidence, observed, { kind: 'initial' });
  assert.equal(context.evidence.verifiedPrograms.length, 8);
  assert.equal(context.evidence.verifiedPrograms[0].actualEndState.inventory[0].count, 12);
  assert.equal(context.evidence.cursors, undefined);
  assert.equal(context.evidence.verifiedLodgePositions, undefined);
  assert.ok(context.evidence.verifiedPrograms.every(entry => entry.successes === 1 && entry.controllerRevision === 'tested-controller'));
  assert.deepEqual(resetSinceReview(evidence).verifiedPrograms, evidence.verifiedPrograms, 'review retains proven skill examples');
});
