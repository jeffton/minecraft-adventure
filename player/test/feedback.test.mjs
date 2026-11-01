import test from 'node:test';
import assert from 'node:assert/strict';
import { actionFeedback, observationFeedback } from '../feedback.mjs';

function snapshot(count) {
  return { at: 'now', health: 20, food: 18, position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'oak_log', count }], blocks: Array.from({ length: 100 }, (_, index) => ({ name: index < 75 ? 'air' : 'stone', type: index < 75 ? 0 : 1, position: { x: index % 5, y: 64, z: index }, properties: {} })) };
}

test('model feedback keeps current prerequisites and effects without replaying every RPC world snapshot', () => {
  const before = snapshot(0);
  const after = snapshot(4);
  const raw = { id: 'identity', name: 'Gather oak', state: 'completed', settled: true, before, after, callCount: 30, calls: Array.from({ length: 30 }, () => ({ method: 'equip', args: ['wooden_axe'], value: before })), value: { found: [{ x: 1, y: 70, z: 2 }], state: after } };
  const projected = actionFeedback(raw);
  assert.deepEqual(projected.effects.inventoryDelta, { oak_log: 4 });
  assert.deepEqual(projected.after.inventory, after.inventory);
  assert.equal(projected.untrustedValue.state.blocks.length, 25);
  assert.deepEqual(projected.untrustedValue.found, raw.value.found);
  assert.equal(projected.id, 'identity');
  assert.equal(projected.name, 'Gather oak');
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < Buffer.byteLength(JSON.stringify(raw)) / 10);
  assert.equal(raw.before.blocks.length, 100, 'host verification evidence is not modified');
});

test('non-air projection explicitly states omissions and preserves exact non-air blocks', () => {
  const raw = snapshot(1);
  const projected = observationFeedback(raw);
  assert.deepEqual(projected.blocks, raw.blocks.slice(75));
  assert.match(projected.localBlocks, /Air is omitted/);
  assert.equal(raw.blocks.length, 100);
});
