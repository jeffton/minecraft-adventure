import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openPlayerAgent } from '../agent.mjs';
import { PLAYER_OBJECTIVE, planningObservation } from '../mission.mjs';
import { playerState } from '../observations.mjs';

const historicalNotes = { goal: 'Defeat the Ender Dragon', home: { x: 12, y: 64, z: 8 }, discoveries: ['observed sheep'] };

test('selected objective replaces the old UI goal without changing remembered discoveries or world facts', () => {
  const notes = structuredClone(historicalNotes);
  const bot = {
    inventory: { items: () => [{ name: 'white_wool', count: 2 }] },
    entity: { position: { x: 12, y: 64, z: 8 } },
    game: { dimension: 'overworld' }, _client: { ended: false }, health: 19, food: 17,
  };
  const state = playerState(bot, { worldId: 'current', session: 'present', life: 0, notes, events: [] });
  assert.equal(state.objective, PLAYER_OBJECTIVE);
  assert.equal(state.longTerm, PLAYER_OBJECTIVE);
  assert.deepEqual(state.home, notes.home);
  assert.deepEqual(state.bots[0].inventory, [{ name: 'white_wool', count: 2 }]);
  assert.deepEqual(notes, historicalNotes);
});

test('actual strategist request receives the chosen objective above historical note goals and preserves raw clock facts', async () => {
  const models = createModels();
  const provider = fauxProvider({
    provider: 'openai-codex', tokensPerSecond: 1000000,
    models: ['gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id, reasoning: true, input: ['text', 'image'], contextWindow: 131072 })),
  });
  let request;
  provider.setResponses([async context => {
    request = structuredClone(context);
    return fauxAssistantMessage('Select a base site from observed terrain.');
  }]);
  models.setProvider(provider.provider);
  const observation = planningObservation({
    objective: 'Obsolete dragon goal', notes: historicalNotes,
    inventory: [{ name: 'white_wool', count: 2 }],
    time: { timeOfDay: 11800, sunrise: 0, sunset: 12000 }, weather: { thunder: true },
    controller: { active: { version: 'current' } },
  });
  const agent = await openPlayerAgent({
    stateDir: await mkdtemp(path.join(tmpdir(), 'minecraft-objective-')), worldId: 'current', models, tools: [],
    getFeedback: () => ({ key: 'selected-objective', needsEngineering: true, observation }),
  });
  try {
    await agent.step(observation);
    const system = request.messages.filter(message => message.role === 'system');
    assert.ok(JSON.stringify(system).includes(PLAYER_OBJECTIVE));
    assert.match(JSON.stringify(system), /takes precedence over older goals/);
    const injected = request.messages.filter(message => message.role === 'user').at(-1);
    const payload = JSON.parse(injected.content).observation;
    assert.equal(payload.objective, PLAYER_OBJECTIVE);
    assert.deepEqual(payload.notes, historicalNotes);
    assert.deepEqual(payload.time, observation.time);
    assert.deepEqual(payload.weather, observation.weather);
    assert.deepEqual(payload.inventory, observation.inventory);
  } finally {
    await agent.close();
  }
});
