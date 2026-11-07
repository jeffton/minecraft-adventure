import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openPlanningMemory, planningMemoryTools } from '../planning-memory.mjs';
import { atomicJson } from '../observations.mjs';
import { openPlayerAgent } from '../agent.mjs';
import { planningObservation } from '../mission.mjs';

const legacyHome = 'Overworld chest168,70,-175 table167,70,-175 furnace164,70,-172';

test('general note replacement cannot erase or relocate an existing home; explicit selection survives reopen', async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'player-home-')), 'notes.json');
  await atomicJson(file, { home: legacyHome, lesson: 'Keep chest access clear' });
  const selections = [];
  const memory = await openPlanningMemory(file, choice => selections.push(choice));
  await memory.remember({ lesson: 'Roof complete' });
  await memory.remember({ home: { x: 999 }, lesson: 'Respawned' });
  assert.equal(memory.home, legacyHome);
  assert.deepEqual(memory.notes, { home: legacyHome, lesson: 'Respawned' });
  const home = { dimension: 'overworld', position: { x: 168, y: 70, z: -175 }, reason: 'Retain my established chest base' };
  await memory.selectHome(home);
  assert.deepEqual(selections, [{ previous: legacyHome, home }]);
  const reopened = await openPlanningMemory(file);
  assert.deepEqual(reopened.home, home);
  assert.equal(reopened.notes.lesson, 'Respawned');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), reopened.notes);
});

test('real model tools select a home, retain it across fresh mission threads, restart and respawn observations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'player-home-model-'));
  const file = path.join(directory, 'notes.json');
  const models = createModels();
  const provider = fauxProvider({
    provider: 'openai-codex', tokensPerSecond: 1000000,
    models: ['gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id, reasoning: true, input: ['text'], contextWindow: 131072 })),
  });
  const selected = { dimension: 'overworld', position: { x: 168, y: 70, z: -175 }, reason: 'Observed chest and shelter' };
  const requests = [];
  const response = value => async context => { requests.push(structuredClone(context)); return value; };
  provider.setResponses([
    response(fauxAssistantMessage(fauxToolCall('select_home', selected), { stopReason: 'toolUse' })),
    response(fauxAssistantMessage(fauxToolCall('remember', { notes: { lesson: 'Keep home intact' } }), { stopReason: 'toolUse' })),
    response(fauxAssistantMessage('Continue the base.')),
    response(fauxAssistantMessage('Return to the same home.')),
    response(fauxAssistantMessage('Home retained after respawn.')),
  ]);
  models.setProvider(provider.provider);
  let memory = await openPlanningMemory(file);
  assert.equal(memory.home, null);
  const observation = life => planningObservation({ session: 'test', life, notes: memory.notes, home: memory.home });
  const open = () => openPlayerAgent({ stateDir: directory, worldId: 'current', models, tools: planningMemoryTools(memory) });
  let agent = await open();
  try {
    await agent.step(observation(0));
    await agent.step(observation(0));
  } finally { await agent.close(); }
  memory = await openPlanningMemory(file);
  agent = await open();
  try { await agent.step(observation(1)); } finally { await agent.close(); }
  for (const request of [requests[3], requests[4]]) {
    const payload = JSON.parse(request.messages.filter(message => message.role === 'user').at(-1).content);
    assert.deepEqual(payload.observation.home, selected);
    assert.deepEqual(payload.observation.notes.home, selected);
    assert.equal(payload.observation.notes.lesson, 'Keep home intact');
  }
  assert.equal(JSON.parse(requests[4].messages.filter(message => message.role === 'user').at(-1).content).observation.life, 1);
});
