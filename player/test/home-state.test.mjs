import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openPlanningMemory, planningMemoryTools } from '../planning-memory.mjs';
import { planningObservation } from '../mission.mjs';
import { playerState } from '../observations.mjs';

const home = { dimension: 'overworld', position: { x: 10, y: 65, z: 20 }, reason: 'Observed open grassland' };

test('concurrent general/home updates preserve facilities and coordinates, relocation labels former-site knowledge, new worlds start empty', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'home-state-'));
  const file = path.join(directory, 'world-a', 'notes.json');
  let memory = await openPlanningMemory(file);
  await assert.rejects(memory.rememberHome({ facilities: [] }), /Select a home/);
  await memory.selectHome(home);
  const knowledge = { facilities: [{ name: 'chest', position: home.position, contents: [{ name: 'coal', count: 8 }], observedAt: '2026-11-07T10:00:00Z' }], furnace: 'Fuel not checked', table: 'Placed east of chest' };
  await Promise.all([
    memory.rememberHome(knowledge),
    memory.remember({ lesson: 'Returned after respawn', homeState: { invented: true }, home: { invented: true } }),
  ]);
  assert.deepEqual(memory.home, home);
  assert.deepEqual(memory.homeState.knowledge, knowledge);
  assert.equal(memory.notes.lesson, 'Returned after respawn');
  const stored = structuredClone(memory.homeState);
  memory = await openPlanningMemory(file);
  assert.deepEqual(memory.homeState, stored);
  const tools = planningMemoryTools(memory);
  await tools.find(tool => tool.name === 'select_home').execute({ ...home, position: { x: 100, y: 65, z: 100 } });
  assert.deepEqual(memory.homeState.home, home, 'old facilities must not appear at the relocated home');
  await tools.find(tool => tool.name === 'remember_home').execute({ knowledge: { facilities: [], pending: 'New site not built yet' } });
  assert.deepEqual(memory.homeState.home.position, { x: 100, y: 65, z: 100 });
  const fresh = await openPlanningMemory(path.join(directory, 'world-b', 'notes.json'));
  assert.equal(fresh.homeState, null);
  assert.equal(fresh.home, null);
  assert.deepEqual(planningObservation({ notes: fresh.notes }).homeState, null);
});

test('UI state and every planning observation expose the same canonical home knowledge without claiming synchronized stock', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'home-state-ui-'));
  const memory = await openPlanningMemory(path.join(directory, 'notes.json'));
  await memory.selectHome(home);
  await memory.rememberHome({ chest: { items: { coal: 3 }, uncertain: 'Another player may have changed stock' } });
  const bot = { inventory: { items: () => [] }, entity: { position: home.position }, game: { dimension: 'overworld' }, _client: { ended: false } };
  const state = playerState(bot, { worldId: 'one', session: 'after-respawn', events: [], notes: memory.notes });
  assert.deepEqual(state.homeState, memory.homeState);
  assert.deepEqual(planningObservation({ notes: memory.notes }).homeState, memory.homeState);
  assert.match(memory.homeState.provenance, /not automatically synchronized/);
  assert.ok(Date.parse(memory.homeState.recordedAt));
});
