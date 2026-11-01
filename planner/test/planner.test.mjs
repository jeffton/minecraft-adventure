import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openEngine, readBrokerAuth } from '../engine.mjs';
import { ModelQueue } from '../queue.mjs';
import { MODEL } from '../contracts.mjs';
import { startPlanner } from '../server.mjs';
import { startBroker } from '../credential-broker.mjs';

const token = 'test-only-local-relay-credential';
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
const plan = {
  phase: 'homestead',
  objective: 'Establish a safe lit home before preparing for Nether travel.',
  bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, { task: 'Gather logs and regroup at the observed camp.', program: [{ action: 'ensure_item', item: 'oak_log', count: 12 }, { action: 'regroup' }] }])),
  home: { x: 10, y: 65, z: -10 },
};
async function directory() { return mkdtemp(path.join(tmpdir(), 'minecraft-planner-test-')); }

test('real durable harness preserves completed submissions after restart without duplicating full Mindcraft context', async () => {
  const stateDir = await directory();
  const seen = [];
  const models = createModels();
  const faux = fauxProvider({ provider: 'openai-codex', models: [{ id: MODEL }], tokensPerSecond: 100000 });
  models.setProvider(faux.provider);
  faux.setResponses([
    (context) => { seen.push(context); return fauxAssistantMessage('!collectBlocks("oak_log", 4)'); },
    (context) => { seen.push(context); return fauxAssistantMessage('!goToPlayer("Spruce", 3)'); },
  ]);
  let engine = await openEngine({ stateDir, models, intervalMs: 0 });
  try {
    const first = await engine.complete([{ role: 'user', content: 'first-observation-marker' }], 'first');
    assert.match(first.text, /collectBlocks/);
    await engine.close();
    engine = await openEngine({ stateDir, models, intervalMs: 0 });
    assert.equal((await engine.complete([{ role: 'user', content: 'first-observation-marker' }], 'first')).text, first.text);
    assert.equal(faux.state.callCount, 1, 'same persisted request must not call model twice');
    await engine.complete([{ role: 'user', content: 'second-observation-marker' }], 'second');
    const latest = JSON.stringify(seen[1]);
    assert.match(latest, /second-observation-marker/);
    assert.doesNotMatch(latest, /first-observation-marker/);
    assert.equal(faux.state.callCount, 2);
  } finally { await engine.close(); }
});

test('global model queue serializes calls and paces starts even after model failure', async () => {
  let now = 100000;
  const queue = new ModelQueue({ intervalMs: 20000, now: () => now, wait: async duration => { now += duration; } });
  const starts = [];
  let active = 0;
  let peak = 0;
  const call = fail => queue.run(async () => {
    active++;
    peak = Math.max(peak, active);
    starts.push(now);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (fail) throw new Error('upstream failed');
    return 'ok';
  });
  const results = await Promise.allSettled([call(false), call(true), call(false)]);
  assert.equal(peak, 1);
  assert.deepEqual(starts, [100000, 120000, 140000]);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].value, 'ok');
  await queue.drain();
});

test('relay requires auth, validates bot/stream input, and emits OpenAI text contract', async () => {
  const stateDir = await directory();
  let calls = 0;
  const engine = {
    complete: async messages => { calls++; assert.match(JSON.stringify(messages), /game state/); return { text: '!stay()', usage: { input: 10, output: 2, totalTokens: 12 }, finishReason: 'stop' }; },
    close: async () => {},
  };
  const planner = await startPlanner({ engine, token, stateDir, missionFile: path.join(stateDir, 'mission.json'), port: 0, queue: new ModelQueue({ intervalMs: 0 }) });
  const url = 'http://127.0.0.1:' + planner.server.address().port;
  const payload = { user: 'Roy', model: 'ignored-model', messages: [{ role: 'system', content: 'game state' }] };
  try {
    assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', body: JSON.stringify(payload) })).status, 401);
    assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...payload, stream: true }) })).status, 400);
    assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...payload, user: 'stranger' }) })).status, 400);
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.model, MODEL);
    assert.equal(answer.choices[0].message.content, '!stay()');
    assert.equal(answer.choices[0].finish_reason, 'stop');
    assert.equal(calls, 1);
  } finally { await planner.close(); }
});

test('missions use observed state, publish validated shared plan and respect interval across process restart', async () => {
  const stateDir = await directory();
  const observedFile = path.join(stateDir, 'state.json');
  const missionFile = path.join(stateDir, 'mission.json');
  await writeFile(observedFile, JSON.stringify({ updatedAt: new Date().toISOString(), bots: [{ name: 'Roy', status: 'online', updatedAt: new Date().toISOString(), health: 16, inventory: { oak_log: 12 } }] }));
  let calls = 0;
  const engine = {
    complete: async messages => {
      calls++;
      assert.match(JSON.stringify(messages), /oak_log/);
      return { text: JSON.stringify(plan), finishReason: 'stop' };
    },
    close: async () => {},
  };
  const options = { engine, token, stateDir, missionFile, observedFile, port: 0, queue: new ModelQueue({ intervalMs: 0 }), pollMs: 1000000 };
  let planner = await startPlanner(options);
  try {
    // Initial mission is launched at startup. Closing waits for its publication.
    await planner.close();
    const mission = JSON.parse(await readFile(missionFile, 'utf8'));
    assert.equal(mission.phase, 'homestead');
    assert.equal(mission.bots.Roy.task, plan.bots.Roy.task);
    assert.deepEqual(mission.bots.Roy.program, plan.bots.Roy.program);
    assert.ok(mission.id && mission.generatedAt);
    planner = await startPlanner(options);
    await planner.missionTick();
    assert.equal(calls, 1, 'five-minute budget survives a restart');
  } finally { await planner.close(); }
});

test('malformed model mission is reported and never replaces a published plan', async () => {
  const stateDir = await directory();
  const observedFile = path.join(stateDir, 'state.json');
  const missionFile = path.join(stateDir, 'mission.json');
  await writeFile(observedFile, JSON.stringify({ updatedAt: new Date().toISOString(), bots: [{ name: 'Roy', status: 'online', updatedAt: new Date().toISOString(), health: 20 }] }));
  await writeFile(missionFile, JSON.stringify({ ...plan, id: 'existing' }));
  const engine = { complete: async () => ({ text: JSON.stringify({ ...plan, phase: 'shell', command: 'run external code' }) }), close: async () => {} };
  const planner = await startPlanner({ engine, token, stateDir, missionFile, observedFile, port: 0, queue: new ModelQueue({ intervalMs: 0 }), pollMs: 1000000 });
  await planner.close();
  assert.equal(JSON.parse(await readFile(missionFile, 'utf8')).id, 'existing');
  assert.match(JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8')).lastMissionError, /invalid keys/);
});

test('credential broker exposes only Codex resolved access auth on a restricted Unix socket', async () => {
  const stateDir = await directory();
  const socketPath = path.join(stateDir, 'auth.sock');
  const requests = [];
  const broker = await startBroker({
    socketPath,
    runtime: { getAuth: async provider => { requests.push(provider); return { auth: { apiKey: 'test-access-only', headers: { 'chatgpt-account-id': 'test-account' } }, env: { SECRET_OTHER: 'must-not-leak' }, refresh: 'must-not-leak' }; } },
  });
  try {
    const auth = await readBrokerAuth(socketPath);
    assert.equal(auth.auth.apiKey, 'test-access-only');
    assert.equal(auth.env, undefined);
    assert.doesNotMatch(JSON.stringify(auth), /must-not-leak/);
    assert.deepEqual(requests, ['openai-codex']);
    const status = await new Promise((resolve, reject) => {
      const request = http.get({ socketPath, path: '/auth?provider=openrouter' }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
    });
    assert.equal(status, 404);
  } finally { await new Promise(resolve => broker.close(resolve)); }
});
