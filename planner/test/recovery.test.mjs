import test from 'node:test';
import { fakeEngine, observation, review, pendingReview } from './helpers/strategy-fixtures.mjs';
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
import { initialEvidence, observeEvidence } from '../evidence.mjs';
import { validateReview } from '../strategy.mjs';

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

test('restart repairs a missing mission projection after document commit without regenerating the published mission', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-committed-projection-'));
  const observed = observation();
  const evidence = observeEvidence(initialEvidence(), observed);
  const mission = {
    phase: 'survival', objective: 'Recover food before building.', home: null,
    bots: Object.fromEntries(['Roy', 'Moss', 'Flint', 'Spruce'].map(name => [name, {
      task: 'Gather food.', program: [{ action: 'ensure_item', item: 'beef', count: 4 }],
    }])),
  };
  const strategy = validateReview(review(mission), null, evidence, observed).strategy;
  const published = { ...mission, id: 'committed-before-crash', goalId: strategy.goal.id, observedAt: observed.updatedAt, generatedAt: observed.updatedAt };
  await writeFile(path.join(stateDir, 'pending-mission.json'), JSON.stringify(pendingReview(observed, { id: published.id })));
  let calls = 0;
  const engine = fakeEngine({ complete: async () => { calls++; throw new Error('must not regenerate committed mission'); } }, {
    revision: 7, evidence, strategy, mission: published, lastReviewAt: Date.now(), lastTriggerFingerprint: 'initial',
  });
  const missionFile = path.join(stateDir, 'mission.json');
  const planner = await startPlanner({
    engine, token: 'test-only-relay-auth-credential', stateDir, missionFile,
    observedFile: path.join(stateDir, 'absent-observations.json'), port: 0, pollMs: 1000000,
  });
  await planner.close();
  assert.deepEqual(JSON.parse(await readFile(missionFile, 'utf8')), published);
  assert.equal(JSON.parse(await readFile(path.join(stateDir, 'pending-mission.json'), 'utf8')), null);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8')).lastMissionError, null, 'committed pending review recovers without touching missing observations');
  assert.equal((await engine.getAdventureState()).revision, 7, 'projection recovery does not publish another durable revision');
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
      engine: fakeEngine({ complete: async () => { calls++; throw new Error('must not run'); } }),
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
