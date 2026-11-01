import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openEngine } from '../engine.mjs';
import { MODEL_ROLES } from '../contracts.mjs';
import { assertWorldScope, prepareWorldScope, readWorldId, worldPaths, plannerWorldConfig, botWorldConfig } from '../world-scope.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'minecraft-world-scope-'));
  const uidA = path.join(root, 'world-a-uid.dat');
  const uidB = path.join(root, 'world-b-uid.dat');
  await writeFile(uidA, Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
  await writeFile(uidB, Buffer.from('112233445566778899aabbccddeeff00', 'hex'));
  const a = await prepareWorldScope({ root, uidFile: uidA, dryRun: false });
  const b = await prepareWorldScope({ root, uidFile: uidB, dryRun: false });
  const models = createModels();
  const provider = fauxProvider({
    provider: 'openai-codex', tokensPerSecond: 100000,
    models: Object.values(MODEL_ROLES).map(role => ({ id: role.model, reasoning: true })),
  });
  models.setProvider(provider.provider);
  const stateDir = path.join(root, 'shared-planner');
  return { root, uidA, a, b, provider, stateDir, open: worldScope => openEngine({ stateDir, worldScope, models, intervalMs: 0 }) };
}

const facts = {
  strategy: { goal: { id: 'lodge' }, home: { x: -374, y: 69, z: 2 } },
  evidence: { inventory: [{ name: 'stone_sword', count: 1 }], milestones: ['tools'] },
  mission: { id: 'same-mission-id', home: { x: -374, y: 69, z: 2 } },
  lastReviewAt: 1234, lastTriggerFingerprint: 'old-world-work',
};
const empty = {
  revision: 0, strategy: null, evidence: null, mission: null,
  lastReviewAt: 0, lastTriggerFingerprint: null,
};

test('dry-run reads only the actual Paper identity, and fresh namespaces leave all old filesystem facts intact', async () => {
  const f = await fixture();
  const before = await readFile(f.uidA);
  const prospectiveRoot = path.join(f.root, 'not-created');
  const plan = await prepareWorldScope({ root: prospectiveRoot, uidFile: f.uidA });
  await assert.rejects(access(prospectiveRoot), { code: 'ENOENT' });
  assert.equal(plan.worldId, '00112233-4455-6677-8899-aabbccddeeff');
  for (const [directory, name] of [[f.a.control, 'home.json'], [f.a.observations, 'state.json'], [f.a.botData, 'memory.json'], [f.a.plannerState, 'pending-mission.json']]) {
    await writeFile(path.join(directory, name), JSON.stringify(facts));
  }
  const repeated = await prepareWorldScope({ root: f.root, uidFile: f.uidA, dryRun: false });
  assert.deepEqual(repeated, f.a);
  for (const directory of [f.b.control, f.b.observations, f.b.botData, f.b.plannerState]) assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.a.control, 'home.json'), 'utf8')), facts);
  assert.deepEqual(await readFile(f.uidA), before, 'preparation never writes the server world');
});

test('missing/mismatched identity fails closed before SQLite is created; malformed uid and path identities are rejected', async () => {
  const f = await fixture();
  await assert.rejects(f.open(worldPaths(path.join(f.root, 'absent'), f.a.worldId)), { code: 'ENOENT' });
  await assert.rejects(f.open({ root: f.a.root, worldId: f.b.worldId }), /World namespace path/);
  await assert.rejects(access(f.stateDir), { code: 'ENOENT' });
  await writeFile(f.uidA, 'not a UUID');
  await assert.rejects(readWorldId(f.uidA), /exactly 16 bytes/);
  assert.throws(() => worldPaths(f.root, '../other-world'), /canonical Paper/);
  await writeFile(f.a.manifestFile, JSON.stringify({ version: 1, worldId: f.b.worldId }));
  await assert.rejects(assertWorldScope(f.a), /identity mismatch/);
});

test('explicit environment selects matching sidefiles and rejects mixed worlds and legacy overrides', async () => {
  const f = await fixture();
  const env = { ADVENTURE_WORLD_ID: f.b.worldId, ADVENTURE_ROOT: f.b.root, PLANNER_STATE_DIR: f.stateDir };
  const config = await plannerWorldConfig(env);
  assert.equal(config.databaseDir, f.stateDir);
  assert.equal(config.stateDir, f.b.plannerState);
  assert.equal(config.missionFile, path.join(f.b.control, 'mission.json'));
  assert.equal(config.observedFile, path.join(f.b.observations, 'state.json'));
  assert.deepEqual(config.worldScope, f.b);
  await assert.rejects(plannerWorldConfig({ ...env, ADVENTURE_WORLD_ID: f.a.worldId }), /mismatch/);
  await assert.rejects(plannerWorldConfig({ ...env, ADVENTURE_ROOT: undefined }), /required/);
  await assert.rejects(plannerWorldConfig({ ...env, ADVENTURE_WORLD_ID: undefined }), /requires ADVENTURE_WORLD_ID/);
  await assert.rejects(plannerWorldConfig({ ...env, PLANNER_MISSION_FILE: path.join(f.a.control, 'mission.json') }), /does not match/);
  await assert.rejects(plannerWorldConfig({ ...env, PLANNER_OBSERVED_FILE: path.join(f.a.observations, 'state.json') }), /does not match/);
  const legacy = await plannerWorldConfig({ PLANNER_STATE_DIR: f.stateDir });
  assert.equal(legacy.stateDir, f.stateDir);
  assert.equal(legacy.worldScope, undefined);
});

test('bot startup rejects cross-world and absent memory directories before launch', async () => {
  const f = await fixture();
  const env = { ADVENTURE_WORLD_ID: f.a.worldId, ADVENTURE_ROOT: f.a.root, BOT_DATA_DIR: f.a.botData };
  assert.deepEqual(await botWorldConfig(env), f.a);
  await assert.rejects(botWorldConfig({ ...env, BOT_DATA_DIR: f.b.botData }), /BOT_DATA_DIR does not match/);
  await assert.rejects(botWorldConfig({ ...env, BOT_DATA_DIR: undefined }), /BOT_DATA_DIR does not match/);
  await assert.rejects(botWorldConfig({ ...env, ADVENTURE_WORLD_ID: f.b.worldId }), /mismatch/);
  await assert.rejects(botWorldConfig({ ...env, ADVENTURE_WORLD_ID: undefined }), /requires ADVENTURE_WORLD_ID/);
  assert.equal(await botWorldConfig({ ADVENTURE_ROOT: '/var/lib/minecraft-adventure', BOT_DATA_DIR: '/var/lib/minecraft-adventure/bots' }), null);
});

test('actual SDK isolates two world documents and legacy facts in one SQLite and restores each after restart', async () => {
  const f = await fixture();
  let engine = await f.open();
  const legacy = await engine.commitAdventureState({ expectedRevision: 0, next: facts });
  await engine.close();
  engine = await f.open(f.a);
  assert.deepEqual(await engine.getAdventureState(), empty);
  const first = await engine.commitAdventureState({ expectedRevision: 0, next: facts });
  await engine.close();
  engine = await f.open(f.b);
  assert.deepEqual(await engine.getAdventureState(), empty, 'no coordinates, mission, strategy, inventory or earned milestones inherited');
  const second = await engine.commitAdventureState({ expectedRevision: 0, next: { ...facts, mission: { id: 'same-mission-id' }, strategy: { goal: { id: 'survive' } }, evidence: { inventory: [] } } });
  await engine.close();
  engine = await f.open(f.a);
  try {
    assert.deepEqual(await engine.getAdventureState(), first);
    await assert.rejects(engine.recordEvidence({ expectedRevision: 0, evidence: {} }), /revision conflict/);
    assert.deepEqual(await engine.getAdventureState(), first);
  } finally { await engine.close(); }
  engine = await f.open(f.b);
  try { assert.deepEqual(await engine.getAdventureState(), second); } finally { await engine.close(); }
  engine = await f.open();
  try {
    assert.deepEqual(await engine.getAdventureState(), legacy, 'opting into world scopes never migrates or deletes live legacy facts');
    assert.equal(f.provider.state.callCount, 0);
    assert.deepEqual((await readdir(f.stateDir)).filter(file => file.endsWith('.sqlite')), ['planner.sqlite']);
  } finally { await engine.close(); }
});

test('actual SDK namespaced model requests cannot replay a previous world answer with the same request ID', async () => {
  const f = await fixture();
  f.provider.setResponses([fauxAssistantMessage('world A answer'), fauxAssistantMessage('world B answer')]);
  let engine = await f.open(f.a);
  const a = await engine.complete([{ role: 'user', content: 'old world coordinates' }], 'repair-1');
  await engine.close();
  engine = await f.open(f.b);
  const b = await engine.complete([{ role: 'user', content: 'fresh world observation' }], 'repair-1');
  assert.equal(b.text, 'world B answer');
  assert.notEqual(a.answerEntryId, b.answerEntryId);
  await engine.close();
  engine = await f.open(f.a);
  try {
    const replay = await engine.complete([{ role: 'user', content: 'old world coordinates' }], 'repair-1');
    assert.equal(replay.answerEntryId, a.answerEntryId);
    assert.equal(f.provider.state.callCount, 2);
  } finally { await engine.close(); }
});
