import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLibrary } from './skills.mjs';

function fixture() {
  const library = new SkillLibrary({ directory: mkdtempSync(join(tmpdir(), 'minecraft-skills-test-')) });
  const skill = library.save({ name: 'make-planks', description: 'Craft planks from available logs', code: 'await mc.call("craft","oak_planks");' });
  const before = { inventory: [{ name: 'oak_log', count: 1 }], health: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', blocks: [] };
  const after = { ...before, inventory: [{ name: 'oak_planks', count: 4 }] };
  const action = { id: 'action-1', worldId: 'world-1', sourceHash: skill.hash, state: 'completed', before, after, calls: [] };
  return { library, skill, action };
}

test('source is reusable, while verified evidence stays bound to source hash and original world', () => {
  const { library, action } = fixture();
  const result = library.verify('make-planks', { worldId: 'world-1', action, expected: { inventoryDelta: { oak_planks: 4 } } });
  assert.equal(result.worldId, 'world-1');
  assert.deepEqual(library.list()[0].verifiedWorlds, ['world-1']);
  assert.throws(() => library.verify('make-planks', { worldId: 'world-2', action, expected: { inventory: { oak_planks: 1 } } }), /different world/);
  library.save({ name: 'make-planks', description: 'A changed implementation', code: 'return "trust me";' });
  assert.deepEqual(library.list()[0].verifiedWorlds, []);
  assert.throws(() => library.verify('make-planks', { worldId: 'world-1', action, expected: { inventory: { oak_planks: 1 } } }), /source does not match/);
});

test('untrusted skill return and unrelated state changes cannot verify claimed outcome', () => {
  const { library, action } = fixture();
  action.value = { success: true, inventory: [{ name: 'diamond', count: 64 }] };
  assert.throws(() => library.verify('make-planks', { worldId: 'world-1', action, expected: { inventory: { diamond: 1 } } }), /observed 0/);
  action.before = structuredClone(action.after);
  action.after.position.x = 4;
  assert.throws(() => library.verify('make-planks', { worldId: 'world-1', action, expected: { inventory: { oak_planks: 1 } } }), /relevant observed progress/);
  assert.throws(() => library.verify('make-planks', { worldId: 'world-1', action, expected: { success: true } }), /Unknown skill postcondition/);
});

test('failed action cannot be verified even after partial real progress', () => {
  const { library, action } = fixture();
  action.state = 'failed';
  assert.throws(() => library.verify('make-planks', { worldId: 'world-1', action, expected: { inventoryDelta: { oak_planks: 4 } } }), /Only completed/);
});

test('block placement verification needs observed old and new block, not an unknown coordinate', () => {
  const { library, action } = fixture();
  const position = { x: 0, y: 64, z: 1 };
  action.before.blocks = [{ position, name: 'air' }];
  action.after.blocks = [{ position, name: 'oak_planks' }];
  const expected = { blocks: [{ ...position, name: 'oak_planks' }] };
  assert.equal(library.verify('make-planks', { worldId: 'world-1', action, expected }).checks[0].before, 'air');
  action.before.blocks = [];
  assert.throws(() => library.verify('make-planks', { worldId: 'world-1', action, expected }), /relevant observed progress/);
});

test('historical block RPC cannot override a contradictory final host observation', () => {
  const { library, action } = fixture();
  const position = { x: 0, y: 64, z: 1 };
  action.before.blocks = [{ position, name: 'air' }];
  action.after.blocks = [{ position, name: 'air' }];
  action.calls = [{ method: 'placeBlock', value: { position, name: 'oak_planks' } }];
  assert.throws(() => library.verify('make-planks', {
    worldId: 'world-1', action, expected: { blocks: [{ ...position, name: 'oak_planks' }] }
  }), /observed air/);
});

test('skill names cannot escape library directory', () => {
  const { library } = fixture();
  assert.throws(() => library.get('../credentials'), /lowercase slug/);
  assert.throws(() => library.save({ name: '../../escape', description: 'bad', code: 'return 1' }), /lowercase slug/);
});
