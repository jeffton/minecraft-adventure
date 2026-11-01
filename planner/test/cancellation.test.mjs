import test from 'node:test';
import { fakeEngine, observation, review } from './helpers/strategy-fixtures.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openEngine } from '../engine.mjs';
import { MODEL } from '../contracts.mjs';
import { ModelQueue } from '../queue.mjs';
import { startPlanner } from '../server.mjs';

const token = 'private-test-relay-bearer-token';
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

test('disconnected queued HTTP client frees capacity and never starts model inference', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-cancel-http-'));
  let release;
  let started;
  const initialStarted = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const engine = fakeEngine({
    complete: async () => { calls++; started(); await gate; return { text: '!stay()', finishReason: 'stop' }; },
    close: async () => {},
  });
  const queue = new ModelQueue({ intervalMs: 0 });
  const planner = await startPlanner({ engine, token, stateDir, missionFile: path.join(stateDir, 'mission.json'), queue, port: 0 });
  const url = 'http://127.0.0.1:' + planner.server.address().port + '/v1/chat/completions';
  const request = { method: 'POST', headers, body: JSON.stringify({ user: 'Roy', messages: [{ role: 'user', content: 'observe' }] }) };
  const first = fetch(url, request);
  await initialStarted;
  const controller = new AbortController();
  const second = fetch(url, { ...request, signal: controller.signal }).catch(error => error);
  try {
    for (let i = 0; queue.pending !== 2 && i < 100; i++) await sleep(5);
    assert.equal(queue.pending, 2);
    controller.abort();
    await second;
    for (let i = 0; queue.pending !== 1 && i < 100; i++) await sleep(5);
    assert.equal(queue.pending, 1, 'queued disconnect must immediately free capacity');
    release();
    assert.equal((await first).status, 200, 'live request must remain intact');
    await queue.drain();
    assert.equal(calls, 1);
  } finally { release(); await planner.close(); }
});

test('active client cancellation aborts real durable generation before next request', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-cancel-pi-'));
  const models = createModels();
  const slow = fauxProvider({ provider: 'openai-codex', models: [{ id: MODEL }], tokensPerSecond: 5 });
  slow.setResponses([fauxAssistantMessage('a long unfinished generation requiring cancellation')]);
  models.setProvider(slow.provider);
  const engine = await openEngine({ stateDir, models, intervalMs: 0 });
  const controller = new AbortController();
  const result = engine.complete([{ role: 'user', content: 'start' }], 'cancel-me', { signal: controller.signal }).catch(error => error);
  while (slow.state.callCount === 0) await sleep(5);
  controller.abort();
  assert.ok(await result instanceof Error);
  const fast = fauxProvider({ provider: 'openai-codex', models: [{ id: MODEL }], tokensPerSecond: 100000 });
  fast.setResponses([fauxAssistantMessage('next live request')]);
  models.setProvider(fast.provider);
  try {
    assert.equal((await engine.complete([{ role: 'user', content: 'next' }], 'next')).text, 'next live request');
  } finally { await engine.close(); }
});

test('mission dispatch uses a fresh observed snapshot after waiting behind the model queue', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-dispatch-snapshot-'));
  const observedFile = path.join(stateDir, 'state.json');
  const missionFile = path.join(stateDir, 'mission.json');
  function observed(marker) {
    const updatedAt = new Date().toISOString();
    return observation({ marker, updatedAt });
  }
  await writeFile(observedFile, JSON.stringify(observed('before queue')));
  let admit;
  let queued;
  const atQueue = new Promise(resolve => { queued = resolve; });
  const gate = new Promise(resolve => { admit = resolve; });
  const queue = { run: async operation => { queued(); await gate; return operation(); }, drain: async () => {} };
  const plan = {
    phase: 'survival', objective: 'Prepare tools',
    bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, {
      task: 'Prepare logs', program: [{ action: 'ensure_item', item: 'oak_log', count: 12 }],
    }])), home: null,
  };
  const engine = fakeEngine({
    complete: async messages => {
      const input = JSON.parse(messages[1].content);
      assert.equal(input.observed.marker, 'at dispatch');
      return { text: JSON.stringify(review(plan)) };
    },
    close: async () => {},
  });
  const planner = await startPlanner({ engine, token, stateDir, missionFile, observedFile, queue, port: 0, pollMs: 1000000 });
  await atQueue;
  await writeFile(observedFile, JSON.stringify(observed('at dispatch')));
  admit();
  await planner.close();
  assert.equal(JSON.parse(await readFile(missionFile, 'utf8')).phase, 'survival');
});
