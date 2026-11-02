import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldDrainForRepair } from '../control-drain.mjs';

function fixture() {
  const observed = { dimension: 'overworld', position: { x: 1, y: 64, z: 2 }, health: 20, food: 20, inventory: [] };
  return {
    analysis: { worldEffect: 12, reasons: [{ kind: 'rpc_failure', details: { actionId: 'current', method: 'goto', args: [{ x: 8, y: 64, z: 2 }] } }] },
    action: { id: 'current', name: 'Explore', state: 'running', before: structuredClone(observed),
      calls: Array.from({ length: 4 }, () => ({ method: 'goto', args: [{ x: 8, y: 64, z: 2 }], error: 'No path' })) },
    observed, worldEffect: 12, reflexOwner: null,
  };
}

test('an older failed action with the same name cannot cancel a new attempt', () => {
  const f = fixture();
  f.analysis.reasons[0].details.actionId = 'old';
  assert.equal(shouldDrainForRepair(f), false);
  f.analysis.reasons = [{ kind: 'action_no_effect', key: 'Explore' }];
  assert.equal(shouldDrainForRepair(f), false);
});

test('only repeated identical current failures qualify, not exploration of different alternatives', () => {
  const f = fixture();
  assert.equal(shouldDrainForRepair(f), true);
  f.action.calls[0].args[0].x = 20;
  assert.equal(shouldDrainForRepair(f), false);
});

test('current movement, retained supplies, world effects or safety ownership suppress patch cancellation', () => {
  for (const change of [
    f => { f.observed.position.x += 3; },
    f => { f.observed.inventory = [{ name: 'oak_log', count: 1 }]; },
    f => { f.worldEffect++; },
    f => { f.reflexOwner = 'eating'; },
    f => { f.observed.health--; },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(shouldDrainForRepair(f), false);
  }
});
