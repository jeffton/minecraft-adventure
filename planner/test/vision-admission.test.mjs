import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openEngine } from '../engine.mjs';
import { MODEL_ROLES, MISSION_INSTRUCTIONS } from '../contracts.mjs';
import { observation } from './helpers/strategy-fixtures.mjs';

for (const metadata of ['legacy', 'missing', 'empty']) {
  test(`provider admission rejects ${metadata} metadata on image-bearing mission, including recovered-format input`, async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-vision-admission-'));
    const models = createModels();
    let calls = 0;
    const provider = fauxProvider({ provider: 'openai-codex', models: Object.values(MODEL_ROLES).map(role => ({ id: role.model, reasoning: true, input: ['text', 'image'] })), tokensPerSecond: 100000 });
    provider.setResponses([() => { calls++; return fauxAssistantMessage('Must not be sent'); }]);
    models.setProvider(provider.provider);
    const engine = await openEngine({ stateDir, models, intervalMs: 0 });
    const input = { observed: observation(),
      ...(metadata === 'legacy' ? { visualObservation: { capturedAt: '2000-01-01' } } : {}),
      ...(metadata === 'empty' ? { visualObservations: [] } : {}),
    };
    try {
      await assert.rejects(engine.complete([
        { role: 'system', content: MISSION_INSTRUCTIONS },
        { role: 'user', content: JSON.stringify(input) },
      ], 'reject-' + metadata, { role: 'mission', images: [{ type: 'image', mimeType: 'image/webp', data: 'AA==' }] }), /failed|finish/i);
      assert.equal(calls, 0);
    } finally { await engine.close(); }
  });
}
