import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressHistory } from '../progress.mjs';

const snapshot = (x, food, inventory = []) => ({ position: { x, y: 64, z: 0 }, dimension: 'overworld', health: 20, food, inventory });
const action = fields => ({ name: 'scout', state: 'completed', session: 'today', startedAt: '2026-11-01T20:00:00Z', completedAt: '2026-11-01T20:01:00Z', before: snapshot(0, 20), after: snapshot(30, 15), calls: [{ method: 'goto' }], ...fields });

test('resource-free travel and active waiting do not masquerade as material progress', () => {
  const history = new ProgressHistory();
  history.completed(action({}));
  history.completed(action({ name: 'wait', before: snapshot(30, 15), after: snapshot(30, 15), callCount: 2, calls: [], waitingOnly: true }));
  const result = history.observation({ session: 'today' });
  assert.equal(result.lastMaterialProgressAt, null);
  assert.equal(result.currentRun.trajectory.grossTravel, 30);
  assert.equal(result.currentRun.waiting, 1);
  assert.equal(history.state.actions[0].effects.foodDelta, -5);
});

test('host outcomes survive rehydration and retain failed partial acquisitions without claiming a base', () => {
  const first = new ProgressHistory();
  first.completed(action({ state: 'failed', error: 'next craft unavailable\nstack', after: snapshot(3, 20, [{ name: 'oak_log', count: 4 }]) }));
  first.died('2026-11-01T20:02:00Z');
  const second = new ProgressHistory(structuredClone(first.state));
  const result = second.observation({ session: 'today', now: Date.parse('2026-11-01T20:03:00Z') });
  assert.equal(result.deaths, 1);
  assert.equal(result.secondsSinceMaterialProgress, 120);
  assert.equal(result.latestMaterialProgress.state, 'failed');
  assert.equal(result.latestMaterialProgress.effects.inventoryDelta.oak_log, 4);
  assert.deepEqual(result.currentRun.retainedSupplyChanges, { oak_log: 4 });
  assert.match(result.interpretation, /does not prove a functional shelter/);
});

test('back and forth movement reveals zero net travel and repeated destinations rather than progress', () => {
  const history = new ProgressHistory();
  for (const [from, to] of [[0, 10], [10, 0], [0, 10], [10, 0]]) {
    history.completed(action({ before: snapshot(from, 20), after: snapshot(to, 20) }));
  }
  const result = history.observation({ session: 'today' });
  assert.equal(result.currentRun.trajectory.netTravel, 0);
  assert.equal(result.currentRun.trajectory.grossTravel, 40);
  assert.equal(result.currentRun.trajectory.repeatedDestinations, 2);
  assert.equal(result.currentRun.trajectory.mostRepeatedDestination.arrivals, 2);
  assert.equal(result.lastMaterialProgressAt, null);
});

test('large historical and stagnant current runs project aggregates without losing durable evidence', () => {
  const history = new ProgressHistory();
  for (let i = 0; i < 1760; i++) {
    history.completed(action({ session: 'yesterday', before: snapshot(i % 2, 20), after: snapshot((i + 1) % 2, 20) }));
  }
  for (let i = 0; i < 1760; i++) {
    history.completed(action({ before: snapshot(i % 2, 20), after: snapshot((i + 1) % 2, 20) }));
  }
  const saved = structuredClone(history.state);
  const result = history.observation({ session: 'today' });
  assert.equal(result.totalActions, 3520);
  assert.equal(result.currentRun.actions, 1760);
  assert.equal(result.recent.actions, 1760);
  assert.equal(result.currentRun.trajectory.grossTravel, 1760);
  assert.equal(result.currentRun.trajectory.mostRepeatedDestination.arrivals, 880);
  assert.ok(JSON.stringify(result).length < 6000, 'projection size does not grow with action count');
  assert.deepEqual(history.state, saved, 'projection must not compact or mutate the full evidence');
});

test('current session and strategic boundary separate old success from present resource-free travel', () => {
  const history = new ProgressHistory();
  history.completed(action({ session: 'yesterday', after: snapshot(0, 20, [{ name: 'oak_log', count: 64 }]) }));
  history.completed(action({ completedAt: '2026-11-01T20:02:00Z', before: snapshot(0, 20), after: snapshot(10, 20) }));
  history.completed(action({ completedAt: '2026-11-01T20:03:00Z', before: snapshot(10, 20), after: snapshot(0, 20) }));
  const result = history.observation({ session: 'today', since: '2026-11-01T20:02:30Z' });
  assert.equal(result.latestMaterialProgress.session, 'yesterday');
  assert.equal(result.currentRun.actions, 2);
  assert.equal(result.recent.actions, 1);
  assert.equal(result.recent.trajectory.netTravel, 10);
  assert.deepEqual(result.recent.retainedSupplyChanges, {});
  assert.equal(history.observation({ session: 'next-session' }).currentRun.actions, 0);
});

test('retained supplies distinguish collected then consumed or lost items from accumulated gains', () => {
  const history = new ProgressHistory();
  history.completed(action({ before: snapshot(0, 20), after: snapshot(0, 20, [{ name: 'oak_log', count: 4 }]) }));
  history.completed(action({ before: snapshot(0, 20, [{ name: 'oak_log', count: 4 }]), after: snapshot(0, 20, [{ name: 'oak_planks', count: 16 }]), completedAt: '2026-11-01T20:02:00Z' }));
  const result = history.observation({ session: 'today', since: '2026-11-01T20:00:00Z' });
  assert.deepEqual(result.recent.retainedSupplyChanges, { oak_planks: 16 });
  assert.deepEqual(result.recent.observedInventoryDelta, { oak_planks: 16 });
});

test('old displacement records, discontinuities and dimension changes do not invent trajectories', () => {
  const history = new ProgressHistory({ actions: [{ name: 'legacy', at: '2026-10-31T20:01:00Z', displacement: 30, effects: null }], deaths: 0, placedBlocks: 0, lastMaterialProgressAt: null });
  const legacy = history.observation();
  assert.equal(legacy.currentRun.trajectory.unknownTravelActions, 1);
  assert.equal(legacy.currentRun.trajectory.netTravel, null);
  assert.equal(legacy.currentRun.trajectory.grossTravel, null);
  assert.equal(legacy.currentRun.retainedSupplyChanges, null);
  history.completed(action({}));
  history.completed(action({ before: snapshot(100, 20), after: snapshot(110, 20) }));
  assert.equal(history.observation({ session: 'today' }).currentRun.trajectory.netTravel, null);
  history.completed(action({ after: { ...snapshot(0, 20), dimension: 'the_nether' } }));
  const result = history.observation({ session: 'today' });
  assert.equal(result.currentRun.trajectory.netTravel, null);
  assert.equal(result.currentRun.trajectory.unknownTravelActions, 1);
  assert.equal(history.state.actions.at(-1).toDimension, 'the_nether');
  assert.deepEqual(history.state.actions.at(-1).from, snapshot(0, 20).position);
});
