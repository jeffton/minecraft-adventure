import test from 'node:test';
import { fakeEngine, observation, review, pendingReview } from './helpers/strategy-fixtures.mjs';
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
  const result = observation({ updatedAt: new Date(Date.now() - age).toISOString() });
  result.bots[0].updatedAt = result.updatedAt;
  return result;
}

test('stale persisted mission without current observations is never sent to the model or republished as new', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-stale-pending-'));
  await writeFile(path.join(stateDir, 'pending-mission.json'), JSON.stringify(pendingReview(observed(600000), { id: 'stale' })));
  const observedFile = path.join(stateDir, 'state.json');
  let calls = 0;
  const missionFile = path.join(stateDir, 'mission.json');
  const planner = await startPlanner({
    engine: fakeEngine({ complete: async () => { calls++; throw new Error('must not call'); } }),
    token: 'test-relay-private-token-value', stateDir, observedFile, missionFile,
    port: 0, queue: new ModelQueue({ intervalMs: 0 }), pollMs: 1000000,
  });
  await planner.close();
  assert.equal(calls, 0);
  assert.match(JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8')).lastMissionError, /ENOENT/);
  assert.equal(JSON.parse(await readFile(missionFile, 'utf8')), null, 'projection of an empty durable mission is null');
});

const plan = {
  phase: 'recovery', objective: 'Prepare tools before building.', home: null,
  bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, {
    task: 'Prepare a pickaxe.', program: [{ action: 'ensure_item', item: 'wooden_pickaxe', count: 1 }],
  }])),
};

for (const world of ['fresh', 'stale', 'offline']) {
  test(`long inference with ${world} current observations ${world === 'fresh' ? 'publishes with original observedAt' : 'does not replace the mission'}`, async t => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-publication-freshness-'));
    const observedFile = path.join(stateDir, 'state.json');
    const missionFile = path.join(stateDir, 'mission.json');
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const input = observed();
    await writeFile(observedFile, JSON.stringify(input));
    await writeFile(missionFile, JSON.stringify({ ...plan, id: 'previous' }));
    let calls = 0;
    const planner = await startPlanner({
      engine: fakeEngine({
        complete: async messages => {
          calls++;
          assert.equal(JSON.parse(messages[1].content).observed.updatedAt, input.updatedAt);
          now += 75000; // Admission plus Sol generation exceeds the input freshness window.
          const latest = world === 'stale' ? input : observed();
          if (world === 'offline') latest.bots[0].status = 'offline';
          await writeFile(observedFile, JSON.stringify(latest));
          return { text: JSON.stringify(review(plan)), finishReason: 'stop' };
        },
        close: async () => {},
      }),
      token: 'test-relay-private-token-value', stateDir, observedFile, missionFile,
      port: 0, queue: new ModelQueue({ intervalMs: 0 }), pollMs: 1000000,
    });
    await planner.close();
    assert.equal(calls, 1);
    const mission = JSON.parse(await readFile(missionFile, 'utf8'));
    const status = JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8'));
    if (world === 'fresh') {
      assert.notEqual(mission.id, 'previous');
      assert.equal(mission.observedAt, input.updatedAt);
      assert.notEqual(mission.observedAt, JSON.parse(await readFile(observedFile, 'utf8')).updatedAt);
      assert.equal(status.lastMissionError, null);
    } else {
      assert.equal(mission.id, 'previous');
      assert.match(status.lastMissionError, world === 'stale' ? /stale/ : /online/);
    }
  });
}

test('hour-old recovered mission gets a new request id and fresh input rather than a cached plan', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-recovered-input-'));
  const observedFile = path.join(stateDir, 'state.json');
  const missionFile = path.join(stateDir, 'mission.json');
  const current = observed();
  await writeFile(observedFile, JSON.stringify(current));
  await writeFile(path.join(stateDir, 'pending-mission.json'), JSON.stringify(pendingReview(observed(3600000), { id: 'hour-old' })));
  let calls = 0;
  const planner = await startPlanner({
    engine: fakeEngine({
      complete: async (messages, requestId) => {
        calls++;
        assert.notEqual(requestId, 'mission-hour-old');
        assert.equal(JSON.parse(messages[1].content).observed.updatedAt, current.updatedAt);
        return { text: JSON.stringify(review(plan)), finishReason: 'stop' };
      }, close: async () => {},
    }),
    token: 'test-relay-private-token-value', stateDir, observedFile, missionFile,
    port: 0, queue: new ModelQueue({ intervalMs: 0 }), pollMs: 1000000,
  });
  await planner.close();
  assert.equal(calls, 1);
  const mission = JSON.parse(await readFile(missionFile, 'utf8'));
  assert.notEqual(mission.id, 'hour-old');
  assert.equal(mission.observedAt, current.updatedAt);
});

for (const admitted of [true, false]) {
  test(`fresh recovered ${admitted ? 'admitted request replays original identity and input' : 'unsubmitted request refreshes changed input with a new identity'}`, async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-pending-provenance-'));
    const observedFile = path.join(stateDir, 'state.json');
    const missionFile = path.join(stateDir, 'mission.json');
    const original = { ...observed(), marker: 'persisted-input' };
    const current = { ...structuredClone(original), marker: 'new-world-input' };
    const pending = pendingReview(original, { dispatchedAt: admitted ? Date.now() : null });
    await writeFile(observedFile, JSON.stringify(current));
    await writeFile(path.join(stateDir, 'pending-mission.json'), JSON.stringify(pending));
    let calls = 0;
    const planner = await startPlanner({
      engine: fakeEngine({
        complete: async (messages, id) => {
          calls++;
          assert.equal(id === 'mission-' + pending.id, admitted);
          assert.equal(JSON.parse(messages[1].content).observed.marker, admitted ? 'persisted-input' : 'new-world-input');
          const dispatch = JSON.parse(await readFile(path.join(stateDir, 'pending-mission.json'), 'utf8'));
          assert.equal(typeof dispatch.dispatchedAt, 'number', 'admission is persisted before model invocation');
          return { text: JSON.stringify(review(plan)) };
        },
      }),
      token: 'test-relay-private-token-value', stateDir, observedFile, missionFile,
      port: 0, queue: new ModelQueue({ intervalMs: 0 }), pollMs: 1000000,
    });
    await planner.close();
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8')).lastMissionError, null);
    assert.equal(JSON.parse(await readFile(missionFile, 'utf8')).id === pending.id, admitted);
  });
}

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
