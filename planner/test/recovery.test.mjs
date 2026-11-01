import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { MODEL, MODEL_ROLES } from '../contracts.mjs';
import { openEngine } from '../engine.mjs';
import { startPlanner } from '../server.mjs';
import { ModelQueue } from '../queue.mjs';

test('an interrupted actual pi-durable model run resumes from SQLite after reopening', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-planner-recovery-'));
  const slow = fauxProvider({ provider: 'openai-codex', models: Object.values(MODEL_ROLES).map(role => ({ id: role.model, reasoning: true })), tokensPerSecond: 5 });
  slow.setResponses([fauxAssistantMessage('a long partial answer that cannot finish before shutdown')]);
  const models = createModels();
  models.setProvider(slow.provider);
  let engine = await openEngine({ stateDir, models, intervalMs: 100 });
  const pending = engine.complete([{ role: 'user', content: 'persist this admitted turn' }], 'interrupted', { role: 'mission' });
  const interrupted = pending.catch(error => error);
  while (slow.state.callCount === 0) await sleep(5);
  await engine.close();
  await interrupted;
  const fast = fauxProvider({ provider: 'openai-codex', models: Object.values(MODEL_ROLES).map(role => ({ id: role.model, reasoning: true })), tokensPerSecond: 100000 });
  const starts = [];
  fast.setResponses([
    (_context, options, _state, model) => {
      starts.push(Date.now());
      assert.equal(model.id, MODEL_ROLES.mission.model);
      assert.equal(options.reasoning, 'medium');
      return fauxAssistantMessage('resumed durable answer');
    },
    (_context, options, _state, model) => {
      starts.push(Date.now());
      assert.equal(model.id, MODEL);
      assert.equal(options.reasoning, 'low');
      return fauxAssistantMessage('next answer');
    },
  ]);
  models.setProvider(fast.provider);
  engine = await openEngine({ stateDir, models, intervalMs: 100 });
  try {
    const result = await engine.complete([{ role: 'user', content: 'persist this admitted turn' }], 'interrupted', { role: 'mission' });
    assert.equal(result.text, 'resumed durable answer');
    assert.equal(fast.state.callCount, 1, 'restart resumes once, repeated request reads persisted result');
    await engine.complete([{ role: 'user', content: 'next request after recovery' }], 'next');
    assert.ok(starts[1] - starts[0] >= 95, 'recovered model and subsequent generation share persisted pacing');
  } finally { await engine.close(); }
});

for (const scenario of ['stale', 'offline']) {
  test('mission planner refuses ' + scenario + ' observed state without model inference', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-planner-freshness-'));
    const observedFile = path.join(stateDir, 'state.json');
    const old = new Date(Date.now() - 120000).toISOString();
    const fresh = new Date().toISOString();
    await writeFile(observedFile, JSON.stringify({
      updatedAt: scenario === 'stale' ? old : fresh,
      bots: [{ name: 'Roy', status: scenario === 'offline' ? 'offline' : 'online', updatedAt: scenario === 'stale' ? old : fresh }],
    }));
    let calls = 0;
    const planner = await startPlanner({
      engine: { complete: async () => { calls++; throw new Error('must not run'); }, close: async () => {} },
      token: 'test-only-relay-auth-credential',
      stateDir,
      observedFile,
      missionFile: path.join(stateDir, 'mission.json'),
      port: 0,
      queue: new ModelQueue({ intervalMs: 0 }),
      pollMs: 1000000,
    });
    await planner.close();
    assert.equal(calls, 0);
    const status = JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8'));
    assert.match(status.lastMissionError, scenario === 'stale' ? /stale/ : /online/);
  });
}
