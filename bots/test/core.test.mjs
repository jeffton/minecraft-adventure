import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lodgeBlueprint, validateMission, missionPrompt } from '../blueprint.mjs';

process.env.ADVENTURE_ROOT = mkdtempSync(join(tmpdir(), 'roy-adventure-state-'));
const { aggregateState, atomicJson, OBS, CONTROL } = await import('../runtime.mjs');
mkdirSync(CONTROL, { recursive: true });
mkdirSync(OBS, { recursive: true });

test('lodge has a usable entry, window openings, a continuous floor and no duplicate block positions', () => {
  const plan = lodgeBlueprint();
  const get = (x, y, z) => plan.find(block => block.x === x && block.y === y && block.z === z);
  assert.equal(new Set(plan.map(b => `${b.x},${b.y},${b.z}`)).size, plan.length);
  for (let x = 0; x < 7; x++) for (let z = 0; z < 9; z++) assert.equal(get(x, -1, z).material, 'oak_planks');
  assert.equal(get(3, 0, 0).material, 'oak_door');
  assert.equal(get(3, 1, 0), undefined, 'upper door position must not be blocked');
  assert.ok(get(2, 1, 0).material.includes('glass'));
  assert.ok(plan.filter(b => b.y >= 3).length > 70, 'roof and gables are planned');
});

test('mission validation rejects malformed/missing bot tasks and out-of-world home values', () => {
  const mission = { id: '1', phase: 'settling', objective: 'Home', home: null,
    bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, { task: 'Gather useful supplies' }])) };
  assert.equal(validateMission(mission), mission);
  assert.throws(() => validateMission({ ...mission, home: { x: Infinity, y: 64, z: 0 } }));
  assert.throws(() => validateMission({ ...mission, bots: { Roy: { task: 'Go' } } }));
  assert.match(missionPrompt('Roy', mission, { x: 1, y: 64, z: 2 }), /reserve x -1\.\.9/);
});

test('diary schema stays complete at startup and after a disconnect or stale observation', () => {
  aggregateState();
  let state = JSON.parse(readFileSync(join(OBS, 'state.json')));
  assert.equal(state.bots.length, 4);
  assert.equal(typeof state.longTerm, 'string');
  assert.equal(typeof state.serverVersion, 'string');
  for (const bot of state.bots) {
    assert.equal(bot.health, null);
    assert.equal(bot.food, null);
    assert.deepEqual(bot.inventory, []);
    assert.equal(typeof bot.task, 'string');
  }
  atomicJson(join(OBS, 'Roy.json'), { name: 'Roy', status: 'offline', updatedAt: new Date().toISOString(), events: [] });
  atomicJson(join(OBS, 'Flint.json'), { name: 'Flint', status: 'online', health: 20, food: 20,
    updatedAt: '2000-01-01T00:00:00Z', inventory: [{ name: 'iron_pickaxe', count: 1 }] });
  aggregateState();
  state = JSON.parse(readFileSync(join(OBS, 'state.json')));
  const flint = state.bots.find(bot => bot.name === 'Flint');
  assert.equal(flint.status, 'offline');
  assert.equal(flint.health, null);
  assert.deepEqual(flint.inventory, []);
  assert.equal(state.milestones.find(m => m.id === 'iron').completed, false, 'stale gear is not observed current progress');
  assert.equal(state.bots.find(bot => bot.name === 'Roy').role, 'builder and expedition coordinator');
});
