import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionGate } from '../decision-gate.mjs';

test('planning starts during physical work, refills after a handoff, and never busy-polls a full queue', async () => {
  const gate = new DecisionGate();
  const state = { action: { id: 'gather', state: 'running' }, health: 20 };
  assert.equal(gate.claim(state), 'plan_ahead');
  let release;
  const planning = new Promise(resolve => { release = resolve; });
  let physicalSteps = 0;
  const pending = planning.then(() => { state.next = { name: 'craft' }; });
  await new Promise(resolve => setImmediate(() => { physicalSteps++; resolve(); }));
  assert.equal(physicalSteps, 1, 'the executor progresses while model response is pending');
  assert.equal(gate.claim(state), null, 'no duplicate concurrent request for the same action');
  release();
  await pending;
  assert.equal(gate.claim(state), null);
  state.action = { id: 'craft', state: 'running' };
  state.next = null;
  assert.equal(gate.claim(state), 'plan_ahead', 'refill the queue before this stage completes');
  state.action.state = 'completed';
  assert.equal(gate.claim(state), 'act', 'completion is never blocked by an ahead-planning claim');
});

test('safety and shutdown suppress planning without consuming the next action opportunity', () => {
  const gate = new DecisionGate();
  const state = { action: { id: 'mine', state: 'running' }, health: 20 };
  for (const change of [{ stopping: true }, { health: 0 }, { reflexOwner: 'eat' }]) {
    assert.equal(gate.claim({ ...state, ...change }), null);
  }
  assert.equal(gate.claim(state), 'plan_ahead');
});
