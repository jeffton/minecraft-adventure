import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openPlanningMemory, planningMemoryTools } from '../planning-memory.mjs';
import { openPlayerAgent } from '../agent.mjs';
import { planningObservation } from '../mission.mjs';
import { survivalGuideTool } from '../survival-guide.mjs';

test('strategist reads progression knowledge and retains its own plan across short notes, fresh missions, restart/death and world isolation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'player-survival-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  const provider = fauxProvider({
    provider: 'openai-codex', tokensPerSecond: 1000000,
    models: ['gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id, reasoning: true, input: ['text'], contextWindow: 131072 })),
  });
  const plan = {
    goal: 'Build a beautiful house and defeat the dragon',
    verified: [{ fact: 'Overworld bed used', evidence: 'server sleep acknowledgement, action-bed' }],
    approaches: ['Finish the roof', 'Choose mined obsidian or casting after surveying supplies'],
    unresolved: ['Nether fortress location unknown'],
  };
  const revised = { ...plan, approaches: ['Finish the roof', 'Cast a portal if a suitable lava source is found'] };
  const requests = [];
  const response = value => async request => { requests.push(structuredClone(request)); return value; };
  provider.setResponses([
    response(fauxAssistantMessage(fauxToolCall('survival_guide', {}), { stopReason: 'toolUse' })),
    response(fauxAssistantMessage(fauxToolCall('remember', { notes: { plan, objective: 'Roof work' } }), { stopReason: 'toolUse' })),
    response(fauxAssistantMessage('Continue building.')),
    response(fauxAssistantMessage(fauxToolCall('remember', { notes: { objective: 'Recover after respawn' } }), { stopReason: 'toolUse' })),
    response(fauxAssistantMessage('Recover, without forgetting the project.')),
    response(fauxAssistantMessage(fauxToolCall('remember', { notes: { plan: revised, objective: 'Roof work' } }), { stopReason: 'toolUse' })),
    response(fauxAssistantMessage('Plan updated from evidence.')),
    response(fauxAssistantMessage('Scout this different world.')),
  ]);
  models.setProvider(provider.provider);
  let memory = await openPlanningMemory(path.join(directory, 'a', 'notes.json'));
  const observation = life => planningObservation({ notes: memory.notes, session: 'current', life });
  const open = worldId => openPlayerAgent({
    stateDir: path.join(directory, worldId), worldId, models,
    tools: [...planningMemoryTools(memory), survivalGuideTool],
  });
  let agent = await open('a');
  try {
    await agent.step(observation(0));
    await agent.step(observation(1));
  } finally { await agent.close(); }
  assert.deepEqual(memory.notes.plan, plan);
  memory = await openPlanningMemory(path.join(directory, 'a', 'notes.json'));
  agent = await open('a');
  try { await agent.step(observation(1)); } finally { await agent.close(); }
  assert.deepEqual(memory.notes.plan, revised);
  memory = await openPlanningMemory(path.join(directory, 'b', 'notes.json'));
  agent = await open('b');
  try { await agent.step(observation(0)); } finally { await agent.close(); }
  assert.equal(memory.notes.plan, undefined);
  const lastUser = request => JSON.parse(request.messages.filter(message => message.role === 'user').at(-1).content);
  assert.deepEqual(lastUser(requests[3]).observation.notes.plan, plan);
  assert.deepEqual(lastUser(requests[5]).observation.notes.plan, plan);
  assert.equal(lastUser(requests[7]).observation.notes.plan, undefined);
  assert.equal(lastUser(requests[7]).worldId, 'b');
  const guideMessage = requests[1].messages.find(message => message.role === 'toolResult' && message.toolName === 'survival_guide');
  assert.ok(guideMessage, 'actual model receives the guide as a tool result');
  assert.match(JSON.stringify(guideMessage), /10 ordinary obsidian/);
  assert.match(JSON.stringify(guideMessage), /diamond or netherite pickaxe, not stone or iron/);
  assert.match(JSON.stringify(guideMessage), /20% chance to shatter/);
  assert.match(JSON.stringify(guideMessage), /fill only empty slots/);
  for (const request of requests) {
    assert.match(JSON.stringify(request.messages.filter(message => message.role === 'system')), /survival_guide tool/);
  }
});
