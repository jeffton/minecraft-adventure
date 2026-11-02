import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineeringSignals } from '../engineering-signals.mjs';

const notify = (signals, fields = {}) => signals.notify({
  kind: 'action_failure', key: 'retreat:no path', version: 'v1', life: 1, ...fields,
});
const snapshot = (x = 0, inventory = []) => ({
  dimension: 'overworld', position: { x, y: 64, z: 0 }, inventory, food: 20,
});
const outcome = fields => ({
  id: 'action', name: 'retreat', state: 'completed', before: snapshot(), after: snapshot(), ...fields,
});
const context = { version: 'v1', life: 1, sequence: 12 };

test('hundreds of identical errors coalesce behind one active writer', () => {
  const signals = new EngineeringSignals();
  notify(signals);
  const first = signals.start();
  assert.ok(first);
  for (let i = 0; i < 400; i++) {
    notify(signals, { sequence: i });
    assert.equal(signals.start(), null);
  }
  const pending = signals.finish();
  assert.equal(pending.reasons.length, 1);
  assert.equal(pending.reasons[0].count, 401);
  assert.ok(signals.start());
  signals.finish();
  assert.equal(signals.start(), null);
  notify(signals);
  assert.equal(signals.start(), null, 'same-tier repetition must not restart an unchanged review');
});

test('no cooldown: a new error can start immediately after a no-patch review', () => {
  const signals = new EngineeringSignals({ now: () => 100 });
  notify(signals);
  const first = signals.start();
  signals.finish({ feedbackKey: first.key, patched: false });
  assert.equal(signals.feedback(), null);
  assert.equal(signals.start(), null);
  notify(signals, { key: 'craft:missing item' });
  assert.ok(signals.start());
});

test('delivered feedback acknowledges only the issued evidence, not later events', () => {
  const signals = new EngineeringSignals();
  notify(signals);
  signals.start();
  notify(signals, { key: 'new error' });
  const fresh = signals.feedback();
  signals.delivered(fresh.key);
  notify(signals, { key: 'later error' });
  const pending = signals.finish({ feedbackKey: fresh.key });
  assert.deepEqual(pending.reasons.map(reason => reason.key), ['later error']);
});

test('repeated problems escalate at 1, 4, 16, 64 without per-action jobs', () => {
  const signals = new EngineeringSignals();
  const counts = [];
  for (let count = 1; count <= 65; count++) {
    notify(signals);
    const batch = signals.start();
    if (batch) {
      counts.push(count);
      signals.finish();
    }
  }
  assert.deepEqual(counts, [1, 4, 16, 64]);
});

test('activation retires obsolete pending evidence without scheduling its own review', () => {
  const signals = new EngineeringSignals();
  notify(signals);
  const before = signals.feedback();
  signals.activated('v2');
  assert.equal(signals.feedback(), null);
  assert.equal(signals.start(), null);
  const historical = signals.records.get(before.reasons[0].identity);
  assert.equal(historical.count, 1);
  signals.delivered(before.key);
  notify(signals, { version: 'v2' });
  const batch = signals.start();
  assert.equal(batch.reasons.length, 1);
  assert.equal(batch.reasons[0].version, 'v2');
  assert.equal(batch.reasons[0].count, 1);
});

test('finishing old feedback after activation preserves fresh current-version failures', () => {
  const signals = new EngineeringSignals();
  notify(signals);
  const old = signals.start();
  for (let i = 0; i < 3; i++) notify(signals);
  signals.activated('v2');
  notify(signals, { version: 'v2' });
  const pending = signals.finish({ feedbackKey: old.key, baseVersion: 'v1', patched: true });
  assert.equal(pending.reasons.length, 1);
  assert.equal(pending.reasons[0].version, 'v2');
  assert.ok(signals.start());
});

test('activation preserves evidence already attributed to the active version', () => {
  const signals = new EngineeringSignals();
  notify(signals);
  notify(signals, { version: 'v2' });
  signals.activated('v2');
  assert.deepEqual(signals.feedback().reasons.map(reason => reason.version), ['v2']);
});

test('versions and lives scope identical signatures separately', () => {
  const signals = new EngineeringSignals();
  notify(signals);
  signals.start();
  signals.finish();
  notify(signals, { version: 'v2' });
  signals.start();
  signals.finish();
  notify(signals, { version: 'v2', life: 2 });
  assert.equal(signals.feedback().reasons[0].count, 1);
});

test('completed stationary retreat is detected despite successful return status', () => {
  const signals = new EngineeringSignals();
  for (let i = 0; i < 3; i++) signals.actionOutcome(outcome({}), context);
  assert.equal(signals.feedback(), null);
  signals.actionOutcome(outcome({}), context);
  assert.equal(signals.feedback().reasons[0].kind, 'action_no_effect');
  assert.equal(signals.feedback().reasons[0].details.repetitions, 4);
});

test('travel, food and placement break stationary no-effect streaks', () => {
  for (const productive of [
    outcome({ after: snapshot(10) }),
    outcome({ before: { ...snapshot(), food: 10 } }),
  ]) {
    const signals = new EngineeringSignals();
    for (let i = 0; i < 3; i++) signals.actionOutcome(outcome({}), context);
    signals.actionOutcome(productive, context);
    for (let i = 0; i < 3; i++) signals.actionOutcome(outcome({}), context);
    assert.equal(signals.feedback(), null);
  }
  const signals = new EngineeringSignals();
  signals.hostProgress({ deaths: 0, placedBlocks: 1 });
  signals.start();
  signals.finish();
  for (let i = 0; i < 3; i++) signals.actionOutcome(outcome({}), { ...context, placedBlocks: 1 });
  signals.actionOutcome(outcome({}), { ...context, placedBlocks: 2 });
  assert.equal(signals.feedback(), null);
});

test('new materials signal once, not for every additional item', () => {
  const signals = new EngineeringSignals();
  signals.actionOutcome(outcome({ after: snapshot(0, [{ name: 'oak_log', count: 1 }]) }), context);
  assert.equal(signals.start().reasons[0].kind, 'material_discovery');
  signals.finish();
  for (let count = 1; count < 100; count++) {
    signals.actionOutcome(outcome({
      before: snapshot(0, [{ name: 'oak_log', count }]),
      after: snapshot(0, [{ name: 'oak_log', count: count + 1 }]),
    }), context);
  }
  assert.equal(signals.feedback(), null);
});

test('unchanged multi-stack inventory cannot conceal stationary repetition', () => {
  const signals = new EngineeringSignals();
  const inventory = [{ name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 1 }];
  for (let i = 0; i < 10; i++) {
    signals.actionOutcome(outcome({ before: snapshot(0, inventory), after: snapshot(0, inventory) }), context);
  }
  assert.equal(signals.feedback().reasons[0].kind, 'action_no_effect');
  // Merging/splitting stacks preserves the same total, not acquired supplies.
  signals.actionOutcome(outcome({
    before: snapshot(0, [{ name: 'cobblestone', count: 32 }, { name: 'cobblestone', count: 33 }]),
    after: snapshot(0, inventory),
  }), context);
  assert.equal(signals.feedback().reasons[0].details.repetitions, 11);
});

test('failed outcomes are actionable even without before/after snapshots', () => {
  const signals = new EngineeringSignals();
  signals.actionOutcome(outcome({ state: 'failed', error: 'No path\nstack', before: null }), context);
  const reason = signals.start().reasons[0];
  assert.equal(reason.kind, 'action_failure');
  assert.equal(reason.key, 'retreat:No path');
});

test('host counters detect death changes and first construction, not every block', () => {
  const signals = new EngineeringSignals();
  signals.hostProgress({ deaths: 0, placedBlocks: 0 }, context);
  assert.equal(signals.feedback(), null);
  signals.hostProgress({ deaths: 1, placedBlocks: 1 }, context);
  assert.deepEqual(signals.start().reasons.map(reason => reason.kind), ['death', 'construction_started']);
  signals.finish();
  signals.hostProgress({ deaths: 1, placedBlocks: 20 }, context);
  assert.equal(signals.feedback(), null);
});

test('requestedAt preserves earliest unseen evidence and inspect cannot mutate records', () => {
  let time = 100;
  const signals = new EngineeringSignals({ now: () => time });
  notify(signals);
  time = 200;
  notify(signals, { key: 'other' });
  const view = signals.inspect();
  assert.equal(view.pending.requestedAt, 100);
  view.pending.reasons[0].details = 'tampered';
  assert.equal(signals.feedback().reasons[0].details, undefined);
});
