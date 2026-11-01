import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressHistory } from '../progress.mjs';

const snapshot = (x, food, inventory = []) => ({ position: { x, y: 64, z: 0 }, dimension: 'overworld', health: 20, food, inventory });
const action = fields => ({ name: 'scout', state: 'completed', startedAt: '2026-11-01T20:00:00Z', completedAt: '2026-11-01T20:01:00Z', before: snapshot(0, 20), after: snapshot(30, 15), calls: [{ method: 'goto' }], ...fields });

test('resource-free travel and active waiting do not masquerade as material progress', () => {
  const history = new ProgressHistory();
  history.completed(action({}));
  history.completed(action({ name: 'wait', after: snapshot(0, 20), callCount: 2, calls: [{ method: 'observe' }, { method: 'waitTicks' }] }));
  const result = history.observation();
  assert.equal(result.lastMaterialProgressAt, null);
  assert.equal(result.actions[0].displacement, 30);
  assert.equal(result.actions[0].effects.foodDelta, -5);
  assert.equal(result.actions[1].waitingOnly, true);
});

test('host outcomes survive rehydration and retain failed partial acquisitions without claiming a base', () => {
  const first = new ProgressHistory();
  first.completed(action({ state: 'failed', error: 'next craft unavailable\nstack', after: snapshot(3, 20, [{ name: 'oak_log', count: 4 }]) }));
  first.died('2026-11-01T20:02:00Z');
  const second = new ProgressHistory(structuredClone(first.state));
  const result = second.observation(Date.parse('2026-11-01T20:03:00Z'));
  assert.equal(result.deaths, 1);
  assert.equal(result.secondsSinceMaterialProgress, 120);
  assert.equal(result.actions[0].state, 'failed');
  assert.equal(result.actions[0].effects.inventoryDelta.oak_log, 4);
  assert.match(result.interpretation, /does not prove a functional shelter/);
});
