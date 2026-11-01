import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlanningVision, nextPerspective } from '../vision.mjs';
import { startPlanner } from '../server.mjs';
import { fakeEngine, observation, review } from './helpers/strategy-fixtures.mjs';

const bytes = Buffer.from('RIFF0000WEBPtest'); // Transport fixture; not a live model image.
function frame(bot, now) {
  return { kind: 'pov', bot, sourceSession: bot + '-session', sourceDimension: 'overworld', capturedAt: new Date(now).toISOString(),
    sha256: createHash('sha256').update(bytes).digest('hex'), image: { type: 'image', mimeType: 'image/webp', data: bytes.toString('base64') } };
}
function observed(now) {
  const state = observation({ updatedAt: new Date(now + 1).toISOString(), objective: 'Find food and accessible stone.', home: null });
  state.bots = ['Roy', 'Spruce', 'Flint', 'Moss'].map(name => ({ ...state.bots[0], name, session: name + '-session', updatedAt: state.updatedAt }));
  return state;
}

test('non-building reviews receive fresh POVs; bounded cadence rotates all online actors and never substitutes after failure', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  let fail = false;
  const vision = createPlanningVision(async (state, request) => {
    calls.push(request);
    if (fail) throw new Error('Camera failed');
    return { frames: [frame(request.povBot, now)], baseView: { status: 'not_requested' } };
  });
  assert.equal((await vision(observed(now), null)).frames[0].bot, 'Roy');
  now += 30000;
  assert.equal((await vision(observed(now), null)).reused, true);
  assert.equal(calls.length, 1);
  for (const bot of ['Spruce', 'Flint', 'Moss', 'Roy']) {
    now += 61000;
    assert.equal((await vision(observed(now), null)).frames[0].bot, bot);
  }
  assert.ok(calls.every(call => call.includeBase === false));
  now += 61000;
  fail = true;
  await assert.rejects(vision(observed(now), null), /Camera failed/);
  const count = calls.length;
  await assert.rejects(vision(observed(now), null), /cadence/);
  assert.equal(calls.length, count, 'failure cannot create a capture storm');
  assert.equal(nextPerspective({ bots: observed(now).bots.filter(bot => bot.name !== 'Flint') }, 'Spruce'), 'Moss');
});

test('new actor session or dimension invalidates the normal short-lived image cache', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const vision = createPlanningVision(async (state, request) => {
    calls++;
    return { frames: [frame(request.povBot, now)], baseView: { status: 'not_requested' } };
  });
  await vision(observed(now), null);
  const reconnected = observed(now);
  reconnected.bots[0].session = 'new-world-session';
  await assert.rejects(vision(reconnected, null), /cadence/);
  now += 61000;
  const next = await vision(observed(now), null);
  assert.equal(next.frames[0].bot, 'Spruce');
  assert.equal(calls, 2);
});

test('capture preparation does not occupy the model queue; an ordinary mission gets image input with no base', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-pov-queue-'));
  const observedFile = path.join(stateDir, 'state.json');
  await writeFile(observedFile, JSON.stringify(observed(Date.now())));
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let started;
  const capturing = new Promise(resolve => { started = resolve; });
  const order = [];
  const plan = { phase: 'survival', objective: 'Collect accessible food.', home: null,
    bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, { task: 'Get food.', program: [{ action: 'ensure_item', item: 'beef', count: 1 }] }])) };
  const engine = fakeEngine({ complete: async (messages, id, options) => {
    order.push(options.role);
    if (options.role === 'repair') return { text: '!stats', finishReason: 'stop' };
    assert.equal(options.images.length, 1);
    assert.equal(JSON.parse(messages[1].content).visualObservations[0].kind, 'pov');
    assert.equal(JSON.parse(messages[1].content).observed.home, null);
    return { text: JSON.stringify(review(plan, { visualAssessment: 'Roy sees an exposed slope; choose accessible food.' })) };
  } });
  const token = 'test-pov-relay-token-private';
  const planner = await startPlanner({ engine, token, stateDir, observedFile, missionFile: path.join(stateDir, 'mission.json'), port: 0, pollMs: 1000000,
    captureView: async () => {
      started(); await hold;
      const image = frame('Roy', Date.now());
      await writeFile(observedFile, JSON.stringify(observed(Date.parse(image.capturedAt))));
      return { frames: [image], baseView: { status: 'not_requested' } };
    },
  });
  try {
    await capturing;
    const response = await fetch(`http://127.0.0.1:${planner.server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'Moss', messages: [{ role: 'user', content: 'Repair food collection.' }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(order, ['repair']);
    release();
  } finally { release(); await planner.close(); }
  assert.deepEqual(order, ['repair', 'mission']);
  assert.equal(JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8')).lastMissionError, null);
});
