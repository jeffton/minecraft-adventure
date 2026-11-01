import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { startBroker } from '../credential-broker.mjs';
import { brokerModels } from '../engine.mjs';
import { MODEL_ROLES } from '../contracts.mjs';

// The bundled catalog can predate a real model. Supply the authoritative cached
// descriptor, not an old model renamed inside the production provider.
test('broker loads canonical cached model metadata read-only and serves it to the nonroot planner', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-canonical-models-'));
  const socketPath = path.join(stateDir, 'broker.sock');
  const modelsStorePath = path.join(stateDir, 'models-store.json');
  const base = openaiCodexProvider().getModels().find(model => model.id === 'gpt-6.1-sol');
  const catalog = Object.values(MODEL_ROLES).map(role => ({
    ...base, id: role.model, name: 'Canonical cached ' + role.model,
    cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
  }));
  const contents = JSON.stringify({ 'openai-codex': { models: catalog, checkedAt: Date.now(), lastModified: Date.now() } });
  await writeFile(modelsStorePath, contents);
  const broker = await startBroker({ socketPath, modelsStorePath, authPath: path.join(stateDir, 'auth.json') });
  try {
    const models = await brokerModels(socketPath);
    const repair = models.getModel('openai-codex', 'gpt-6.1-terra');
    assert.equal(repair.name, 'Canonical cached gpt-6.1-terra');
    assert.equal(repair.contextWindow, 500000);
    assert.equal(repair.cost.output, 5);
    assert.equal(repair.maxTokens, 2048);
    assert.equal(models.getModel('openai-codex', 'gpt-6.1-sol').maxTokens, 4096);
    assert.equal(models.getModel('openai-codex', 'gpt-5.6-terra'), undefined);
    assert.equal(await readFile(modelsStorePath, 'utf8'), contents);
  } finally { await new Promise(resolve => broker.close(resolve)); }
});

test('missing canonical model is an explicit startup error, not a static-model alias', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-missing-model-'));
  const socketPath = path.join(stateDir, 'broker.sock');
  const broker = await startBroker({ socketPath, runtime: { getModels: provider => {
    assert.equal(provider, 'openai-codex');
    return [];
  } } });
  try {
    await assert.rejects(brokerModels(socketPath), /absent from the canonical catalog/);
  } finally { await new Promise(resolve => broker.close(resolve)); }
});
