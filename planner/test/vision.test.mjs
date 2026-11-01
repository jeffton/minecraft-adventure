import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openEngine } from '../engine.mjs';
import { MODEL_ROLES } from '../contracts.mjs';
import { startPlanner } from '../server.mjs';
import { fakeEngine, observation, review } from './helpers/strategy-fixtures.mjs';
import { validateVisualFrame, validateVisualSource, needsBuildingView } from '../vision.mjs';

const home = { x: 0, y: 64, z: 0, dimension: 'overworld' };
// Header fixture for transport/checksum tests, never sent to a live model.
const bytes = Buffer.from('RIFF0000WEBPtest');
function frame() {
  return { kind: 'base', home, capturedAt: new Date().toISOString(), bot: 'Roy', sourceSession: 'roy-session', sourceDimension: 'overworld', sha256: createHash('sha256').update(bytes).digest('hex'), image: { type: 'image', mimeType: 'image/webp', data: bytes.toString('base64') } };
}
const plan = {
  phase: 'homestead', objective: 'Build a reachable shelter.', home: { x: home.x, y: home.y, z: home.z },
  bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, {
    task: 'Gather local building wood.', program: [{ action: 'ensure_item', item: 'oak_log', count: 2 }],
  }])),
};

test('only relevant base work requests a view; stale, wrong-base and corrupted images are rejected', () => {
  assert.equal(needsBuildingView(observation(), null), false);
  assert.equal(needsBuildingView(observation({ home, objective: 'Build shelter' }), null), true);
  assert.equal(needsBuildingView(observation({ home, objective: 'Hunt food' }), null), false);
  assert.throws(() => validateVisualFrame({ ...frame(), capturedAt: '2000-01-01' }, home), /stale/);
  assert.throws(() => validateVisualFrame(frame(), { ...home, x: 100 }), /different base/);
  assert.throws(() => validateVisualFrame({ ...frame(), sha256: 'wrong' }, home), /checksum/);
});

test('post-capture producer identity rejects reconnects and dimension changes at identical coordinates', () => {
  const image = frame();
  const observed = observation({ home, updatedAt: image.capturedAt });
  observed.bots[0].updatedAt = image.capturedAt;
  validateVisualSource(image, observed);
  observed.bots[0].session = 'new-session';
  assert.throws(() => validateVisualSource(image, observed), /session\/dimension/);
  observed.bots[0].session = 'roy-session';
  observed.bots[0].dimension = 'nether';
  assert.throws(() => validateVisualSource(image, observed), /session\/dimension/);
});

test('Pi Durable sends an actual image block to the model and does not leak it into later Terra requests', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-vision-engine-'));
  const models = createModels();
  const calls = [];
  const provider = fauxProvider({ provider: 'openai-codex', models: Object.values(MODEL_ROLES).map(role => ({ id: role.model, input: ['text', 'image'], reasoning: true })), tokensPerSecond: 100000 });
  provider.setResponses([0, 1].map(() => context => {
    calls.push(context);
    return fauxAssistantMessage('Observed roof gap.');
  }));
  models.setProvider(provider.provider);
  const engine = await openEngine({ stateDir, models, intervalMs: 0 });
  try {
    await engine.complete([{ role: 'user', content: 'Inspect the base' }], 'vision-test', { role: 'mission', images: [frame().image] });
    const user = calls[0].messages.findLast(message => message.role === 'user');
    assert.equal(user.content.find(item => item.type === 'image').data, bytes.toString('base64'));
    assert.match(user.content.find(item => item.type === 'text').text, /Inspect the base/);
    await engine.complete([{ role: 'user', content: 'Repair a tool program' }], 'repair-after-vision');
    assert.equal(calls[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(item => item.type === 'image').length, 0);
  } finally { await engine.close(); }
});

for (const failure of [false, true]) {
  test(`building review ${failure ? 'exposes capture failure without calling a text-only substitute' : 'attaches image and persists the visual assessment'}`, async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-vision-review-'));
    const observedFile = path.join(stateDir, 'state.json');
    const missionFile = path.join(stateDir, 'mission.json');
    await writeFile(observedFile, JSON.stringify(observation({ home, objective: 'Build shelter' })));
    let calls = 0;
    const engine = fakeEngine({ complete: async (messages, id, options) => {
      calls++;
      assert.equal(options.images[0].data, bytes.toString('base64'));
      assert.equal(JSON.parse(messages[1].content).visualObservations[0].sha256, frame().sha256);
      return { text: JSON.stringify(review(plan, { visualAssessment: 'The visible wall has a gap; close it before decoration.' })) };
    } });
    const planner = await startPlanner({ engine, token: 'test-vision-private-token-value', stateDir, observedFile, missionFile, port: 0, pollMs: 1000000,
      captureView: async () => {
        if (failure) throw new Error('Renderer unavailable');
        const image = frame();
        const confirmedAt = new Date(Date.parse(image.capturedAt) + 1).toISOString();
        const confirmed = observation({ home, objective: 'Build shelter', updatedAt: confirmedAt });
        confirmed.bots[0].updatedAt = confirmedAt;
        await writeFile(observedFile, JSON.stringify(confirmed));
        image.kind = 'pov';
        return { frames: [image], baseView: { status: 'not_requested' } };
      },
    });
    await planner.close();
    const status = JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8'));
    assert.equal(calls, failure ? 0 : 1);
    if (failure) assert.match(status.lastMissionError, /Renderer unavailable/);
    else assert.match((await engine.getAdventureState()).strategy.visualAssessment, /visible wall/);
  });
}
