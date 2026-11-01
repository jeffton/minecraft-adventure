import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { MODEL, MISSION_INSTRUCTIONS } from '../contracts.mjs';
import { openEngine } from '../engine.mjs';
import { startPlanner } from '../server.mjs';
import { ModelQueue } from '../queue.mjs';

function observed(age = 0) {
  const updatedAt = new Date(Date.now() - age).toISOString();
  return { updatedAt, bots: [{ name: 'Roy', status: 'online', updatedAt }] };
}

test('stale persisted mission without current observations is never sent to the model or republished as new', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-stale-pending-'));
  await writeFile(path.join(stateDir, 'pending-mission.json'), JSON.stringify({ id: 'stale', observed: observed(600000), previousMission: null }));
  const observedFile = path.join(stateDir, 'state.json');
  let calls = 0;
  const missionFile = path.join(stateDir, 'mission.json');
  const planner = await startPlanner({
    engine: { complete: async () => { calls++; throw new Error('must not call'); }, close: async () => {} },
    token: 'test-relay-private-token-value', stateDir, observedFile, missionFile,
    port: 0, queue: new ModelQueue({ intervalMs: 0 }), pollMs: 1000000,
  });
  await planner.close();
  assert.equal(calls, 0);
  assert.match(JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8')).lastMissionError, /ENOENT/);
  await assert.rejects(readFile(missionFile), { code: 'ENOENT' });
});

test('provider dispatch rejects stale persisted mission content even outside the HTTP queue', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-stale-dispatch-'));
  const models = createModels();
  const faux = fauxProvider({ provider: 'openai-codex', models: [{ id: MODEL }] });
  faux.setResponses([fauxAssistantMessage('must never call upstream')]);
  models.setProvider(faux.provider);
  const engine = await openEngine({ stateDir, models, intervalMs: 0 });
  try {
    await assert.rejects(engine.complete([
      { role: 'system', content: MISSION_INSTRUCTIONS },
      { role: 'user', content: JSON.stringify({ observed: observed(600000), previousMission: null }) },
    ], 'stale-dispatch'), /did not finish/);
    assert.equal(faux.state.callCount, 0);
  } finally { await engine.close(); }
});
