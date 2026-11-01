import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openEngine } from '../engine.mjs';
import { MODEL_ROLES } from '../contracts.mjs';

const initial = {
  revision: 0, strategy: null, evidence: null, mission: null,
  lastReviewAt: 0, lastTriggerFingerprint: null,
};

function nextState(id = 'mission-one') {
  return {
    strategy: { objective: 'Prepare tools before attempting construction.' },
    evidence: { observedAt: '2026-11-01T12:00:00Z', source: 'test observation', inventory: [] },
    mission: id === null ? null : { id, phase: 'recovery', objective: 'Gather supplies.' },
    lastReviewAt: 1793534400000,
    lastTriggerFingerprint: 'inventory-empty',
  };
}

async function fixture() {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-adventure-state-'));
  const models = createModels();
  const provider = fauxProvider({
    provider: 'openai-codex',
    models: Object.values(MODEL_ROLES).map(role => ({ id: role.model, reasoning: true })),
    tokensPerSecond: 100000,
  });
  models.setProvider(provider.provider);
  return { provider, open: () => openEngine({ stateDir, models, intervalMs: 0 }) };
}

test('new engine exposes empty strategic state without deriving facts from chat or calling a model', async () => {
  const f = await fixture();
  const engine = await f.open();
  try {
    assert.deepEqual(await engine.getAdventureState(), initial);
    assert.equal(f.provider.state.callCount, 0);
  } finally { await engine.close(); }
});

test('one committed checkpoint rehydrates strategy, evidence and mission together before any file projection', async () => {
  const f = await fixture();
  let engine = await f.open();
  const next = nextState();
  const expected = { ...structuredClone(next), revision: 1 };
  try {
    assert.deepEqual(await engine.commitAdventureState({ expectedRevision: 0, next }), expected);
    next.strategy.objective = 'Caller mutation must not alter storage';
    next.evidence.inventory.push({ name: 'oak_log', count: 64 });
    // Stop after the SQLite commit, before a server could project mission.json.
    await engine.close();
    engine = await f.open();
    assert.deepEqual(await engine.getAdventureState(), expected);
    assert.equal(f.provider.state.callCount, 0);
  } finally { await engine.close(); }
});

test('session state survives model role configuration and context reset, with answer entry provenance', async () => {
  const f = await fixture();
  f.provider.setResponses([fauxAssistantMessage('mission response'), fauxAssistantMessage('repair response')]);
  const engine = await f.open();
  try {
    const expected = await engine.commitAdventureState({ expectedRevision: 0, next: nextState() });
    const mission = await engine.complete([{ role: 'user', content: 'planning input' }], 'plan', { role: 'mission' });
    const repair = await engine.complete([{ role: 'user', content: 'repair input' }], 'repair', { role: 'repair' });
    assert.ok(Number.isInteger(mission.answerEntryId));
    assert.ok(Number.isInteger(repair.answerEntryId));
    assert.notEqual(mission.answerEntryId, repair.answerEntryId);
    assert.deepEqual(await engine.getAdventureState(), expected);
    assert.equal((await engine.complete([{ role: 'user', content: 'repair input' }], 'repair')).answerEntryId, repair.answerEntryId);
    assert.equal(f.provider.state.callCount, 2);
  } finally { await engine.close(); }
});

test('duplicate mission is idempotent, revision conflict rolls back and later valid commits remain usable', async () => {
  const f = await fixture();
  const engine = await f.open();
  try {
    const first = await engine.commitAdventureState({ expectedRevision: 0, next: nextState() });
    const duplicate = { ...nextState(), strategy: { objective: 'Do not reapply this replay' }, lastReviewAt: 0 };
    assert.deepEqual(await engine.commitAdventureState({ expectedRevision: 0, next: duplicate }), first);
    await assert.rejects(engine.commitAdventureState({ expectedRevision: 0, next: nextState('mission-two') }), /revision conflict/);
    assert.deepEqual(await engine.getAdventureState(), first);
    const next = nextState('mission-two');
    assert.deepEqual(await engine.commitAdventureState({ expectedRevision: 1, next }), { ...next, revision: 2 });
  } finally { await engine.close(); }
});

test('null mission does not make unrelated strategic updates appear to be duplicate publications', async () => {
  const f = await fixture();
  const engine = await f.open();
  try {
    await engine.commitAdventureState({ expectedRevision: 0, next: nextState(null) });
    const next = { ...nextState(null), lastTriggerFingerprint: 'health-changed', revision: 99, untrustedExtra: 'not stored' };
    const result = await engine.commitAdventureState({ expectedRevision: 1, next });
    assert.equal(result.revision, 2);
    assert.equal(result.lastTriggerFingerprint, 'health-changed');
    assert.equal(result.untrustedExtra, undefined);
  } finally { await engine.close(); }
});

test('evidence polling persists across restart without changing the existing mission, strategy or review clock', async () => {
  const f = await fixture();
  let engine = await f.open();
  try {
    const first = await engine.commitAdventureState({ expectedRevision: 0, next: nextState() });
    const evidence = { observedAt: '2026-11-01T12:01:00Z', inventory: [{ name: 'oak_log', count: 1 }] };
    const polled = await engine.recordEvidence({ expectedRevision: 1, evidence });
    const expected = { ...first, revision: 2, evidence: structuredClone(evidence) };
    assert.deepEqual(polled, expected);
    evidence.inventory[0].count = 64;
    await engine.close();
    engine = await f.open();
    assert.deepEqual(await engine.getAdventureState(), expected);
    const consumed = await engine.recordEvidence({
      expectedRevision: 2, evidence: expected.evidence, lastTriggerFingerprint: 'inventory-changed',
    });
    assert.deepEqual(consumed, { ...expected, revision: 3, lastTriggerFingerprint: 'inventory-changed' });
    // Replaying an already-published mission cannot undo evidence collected later.
    assert.deepEqual(await engine.commitAdventureState({ expectedRevision: 0, next: nextState() }), consumed);
    const mission = nextState('mission-after-poll');
    const published = await engine.commitAdventureState({ expectedRevision: 3, next: mission });
    assert.deepEqual(published, { ...mission, revision: 4 });
    assert.equal(f.provider.state.callCount, 0);
  } finally { await engine.close(); }
});

test('evidence conflicts roll back and an explicit null fingerprint clears only that marker', async () => {
  const f = await fixture();
  const engine = await f.open();
  try {
    const first = await engine.commitAdventureState({ expectedRevision: 0, next: nextState() });
    await assert.rejects(engine.recordEvidence({
      expectedRevision: 0, evidence: { observedAt: 'rejected' }, lastTriggerFingerprint: null,
    }), /revision conflict/);
    assert.deepEqual(await engine.getAdventureState(), first);
    const evidence = { observedAt: '2026-11-01T12:01:00Z', inventory: [] };
    assert.deepEqual(await engine.recordEvidence({ expectedRevision: 1, evidence, lastTriggerFingerprint: null }), {
      ...first, revision: 2, evidence, lastTriggerFingerprint: null,
    });
  } finally { await engine.close(); }
});
