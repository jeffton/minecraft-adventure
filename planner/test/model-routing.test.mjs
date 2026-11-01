import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openEngine } from '../engine.mjs';
import { MODEL_ROLES } from '../contracts.mjs';
import { startPlanner } from '../server.mjs';
import { ModelQueue } from '../queue.mjs';

const token = 'test-model-routing-private-bearer';
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
const plan = {
  phase: 'recovery', objective: 'Prepare tools before building.', home: null,
  bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, {
    task: 'Prepare a wooden pickaxe.', program: [{ action: 'ensure_item', item: 'wooden_pickaxe', count: 1 }],
  }])),
};

async function fixture(responses) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-model-routing-'));
  const models = createModels();
  const provider = fauxProvider({
    provider: 'openai-codex',
    models: Object.values(MODEL_ROLES).map(role => ({ id: role.model, reasoning: true })),
    tokensPerSecond: 100000,
  });
  const calls = [];
  provider.setResponses(responses.map(response => (context, options, _state, model) => {
    calls.push({ model: model.id, reasoning: options.reasoning, context });
    return response;
  }));
  models.setProvider(provider.provider);
  const engine = await openEngine({ stateDir, models, intervalMs: 0 });
  return { stateDir, engine, calls };
}

async function waitForMission(stateDir, previousId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = await readFile(path.join(stateDir, 'status.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return 'null';
    });
    if (JSON.parse(status)?.lastMissionError) return;
    const mission = await readFile(path.join(stateDir, 'mission.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return 'null';
    });
    if (JSON.parse(mission)?.id && JSON.parse(mission).id !== previousId) return;
    await sleep(10);
  }
  assert.fail('Startup mission did not settle');
}

test('real relay routes mission to Sol medium and repairs to Terra low without leaking the previous view', async () => {
  const { stateDir, engine, calls } = await fixture([
    fauxAssistantMessage(JSON.stringify(plan)), fauxAssistantMessage('!runProgram()'),
    fauxAssistantMessage(JSON.stringify(plan)),
  ]);
  const observedFile = path.join(stateDir, 'observed.json');
  const updatedAt = new Date().toISOString();
  await writeFile(observedFile, JSON.stringify({ updatedAt, bots: [{ name: 'Roy', status: 'online', updatedAt }] }));
  const missionFile = path.join(stateDir, 'mission.json');
  const planner = await startPlanner({
    engine, token, stateDir, observedFile, missionFile, port: 0,
    queue: new ModelQueue({ intervalMs: 0 }), pollMs: 1000000,
  });
  const url = 'http://127.0.0.1:' + planner.server.address().port;
  try {
    await waitForMission(stateDir);
    // Startup mission has settled before sending repair chat.
    const response = await fetch(url + '/v1/chat/completions', {
      method: 'POST', headers, body: JSON.stringify({
        user: 'Roy', model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'repair-marker' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, MODEL_ROLES.repair.model);
    assert.equal(JSON.parse(await readFile(missionFile, 'utf8')).phase, 'recovery');
    assert.deepEqual((await (await fetch(url + '/healthz')).json()).models, MODEL_ROLES);
    await engine.complete([{ role: 'user', content: 'next-mission-marker' }], 'next-mission', { role: 'mission' });
    assert.deepEqual(calls.map(({ model, reasoning }) => ({ model, reasoning })), [
      { model: 'gpt-6.1-sol', reasoning: 'medium' },
      { model: 'gpt-5.6-terra', reasoning: 'low' },
      { model: 'gpt-6.1-sol', reasoning: 'medium' },
    ]);
    assert.doesNotMatch(JSON.stringify(calls[2].context), /repair-marker/);
  } finally { await planner.close(); }
});

for (const stopReason of ['length', 'error']) {
  test(`${stopReason} from Sol never replaces the previous mission or poisons the following Terra request`, async () => {
    const { stateDir, engine, calls } = await fixture([
      fauxAssistantMessage(JSON.stringify(plan), { stopReason }), fauxAssistantMessage('!runProgram()'),
    ]);
    const observedFile = path.join(stateDir, 'observed.json');
    const updatedAt = new Date().toISOString();
    await writeFile(observedFile, JSON.stringify({ updatedAt, bots: [{ name: 'Roy', status: 'online', updatedAt }] }));
    const missionFile = path.join(stateDir, 'mission.json');
    await writeFile(missionFile, JSON.stringify({ ...plan, id: 'previous' }));
    const planner = await startPlanner({
      engine, token, stateDir, observedFile, missionFile, port: 0,
      queue: new ModelQueue({ intervalMs: 0 }), pollMs: 1000000,
    });
    const url = 'http://127.0.0.1:' + planner.server.address().port;
    try {
      await waitForMission(stateDir, 'previous');
      const response = await fetch(url + '/v1/chat/completions', {
        method: 'POST', headers,
        body: JSON.stringify({ user: 'Flint', messages: [{ role: 'user', content: 'recover' }] }),
      });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(await readFile(missionFile, 'utf8')).id, 'previous');
      assert.ok(JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8')).lastMissionError);
      assert.deepEqual(calls.map(call => call.model), ['gpt-6.1-sol', 'gpt-5.6-terra']);
    } finally { await planner.close(); }
  });
}
