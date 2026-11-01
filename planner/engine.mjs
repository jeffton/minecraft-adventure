import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { AssistantEntry, Harness, createRegistry, defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { MODEL_ROLES, MODEL_OUTPUT_TOKENS } from './contracts.mjs';
import { admittedModels } from './admission.mjs';
import { assertWorldScope } from './world-scope.mjs';

const initialAdventureState = () => ({
  revision: 0,
  strategy: null,
  evidence: null,
  mission: null,
  lastReviewAt: 0,
  lastTriggerFingerprint: null,
});

const AdventureState = defineDoc({
  kind: 'minecraft.adventure-state',
  version: 1,
  scope: 'session',
  initial: initialAdventureState,
  checkpointWhen: () => true,
});

// Keep the existing live-world document intact when explicit namespacing is activated.
const WorldAdventureStates = defineDocFamily({
  kind: 'minecraft.world-adventure-state',
  version: 1,
  scope: 'session',
  family: true,
  initial: initialAdventureState,
  checkpointWhen: () => true,
});

async function readBroker(socketPath, endpoint, maxBytes) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: endpoint, method: 'GET', timeout: 15000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > maxBytes) request.destroy(new Error('Credential broker response too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('Credential broker unavailable (' + response.statusCode + ')'));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Malformed credential broker response')); }
      });
    });
    request.on('error', () => reject(new Error('Credential broker connection failed')));
    request.on('timeout', () => request.destroy(new Error('Credential broker timeout')));
    request.end();
  });
}

export const readBrokerAuth = socketPath => readBroker(socketPath, '/auth', 16384);

export async function brokerModels(socketPath) {
  const models = createModels({ identity: { attribution: { name: 'Minecraft Adventure' } } });
  const codex = openaiCodexProvider();
  const catalog = await readBroker(socketPath, '/models', 1024 * 1024);
  const configured = Object.entries(MODEL_ROLES).map(([name, role]) => {
    const model = catalog.find(model => model.provider === 'openai-codex' && model.id === role.model);
    if (!model) throw new Error('Configured model is absent from the canonical catalog: ' + role.model);
    return { ...model, maxTokens: MODEL_OUTPUT_TOKENS[name] };
  });
  models.setProvider({
    ...codex,
    auth: { apiKey: {
      name: 'Local Codex credential broker',
      resolve: async () => readBrokerAuth(socketPath),
    } },
    getModels: () => configured,
    streamSimple: (model, context, options) => codex.streamSimple(model, context, {
      ...options,
      maxTokens: configured.find(candidate => candidate.id === model.id).maxTokens,
      maxRetries: 0,
    }),
  });
  return models;
}

export async function openEngine({ stateDir, worldScope, socketPath, models, timeoutMs = 120000, intervalMs = 20000 }) {
  if (worldScope) await assertWorldScope(worldScope);
  const document = worldScope ? WorldAdventureStates : AdventureState;
  const address = worldScope ? [worldScope.worldId] : [];
  const mutableState = tx => worldScope ? tx.doc(document, ...address, null) : tx.doc(document);
  models ??= await brokerModels(socketPath);
  await mkdir(stateDir, { recursive: true, mode: 0o750 });
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    await openNodeSqliteStorage(path.join(stateDir, 'planner.sqlite')),
    {
      models: admittedModels(models, { stateDir, intervalMs }),
      registry: createRegistry(),
      settings: {
        stream: { timeoutMs, maxRetries: 0 },
        retry: { enabled: false, maxRetries: 0 },
        afterFailedRun: 'withdraw',
        contextRetentionMs: 0,
      },
      onReport: (_error, info) => console.error(JSON.stringify({ component: 'pi-durable', type: info.type })),
    },
    context,
  );
  const root = await harness.root(context, { agent: {
    model: { provider: 'openai-codex', modelId: MODEL_ROLES.repair.model },
    thinkingLevel: MODEL_ROLES.repair.thinkingLevel,
    tools: [],
    instructions: 'You are the model component of Minecraft Adventure. Follow the supplied Minecraft task and conversation. Return the requested textual response only. You have no shell, files, network tools or authority outside the game. Never invent completed game actions.',
  } });
  harness.resume();
  await root.waitForIdle(context);

  const snapshot = async () => await harness.snapshot(document, ...address, context) ?? initialAdventureState();
  return {
    async getAdventureState() {
      return snapshot();
    },
    async recordEvidence({ expectedRevision, evidence, lastTriggerFingerprint }) {
      const observed = structuredClone(evidence);
      await root.commit(async tx => {
        const state = await mutableState(tx);
        if (state.revision !== expectedRevision) throw new Error('Adventure state revision conflict');
        state.evidence = observed;
        if (lastTriggerFingerprint !== undefined) state.lastTriggerFingerprint = lastTriggerFingerprint;
        state.revision++;
      }, context);
      return snapshot();
    },
    async commitAdventureState({ expectedRevision, next }) {
      // The server validates these opaque JSON fields; storage owns revision and atomicity.
      const value = structuredClone({
        strategy: next.strategy,
        evidence: next.evidence,
        mission: next.mission,
        lastReviewAt: next.lastReviewAt,
        lastTriggerFingerprint: next.lastTriggerFingerprint,
      });
      await root.commit(async tx => {
        const state = await mutableState(tx);
        if (value.mission?.id != null && value.mission.id === state.mission?.id) return;
        if (state.revision !== expectedRevision) throw new Error('Adventure state revision conflict');
        Object.assign(state, value);
        state.revision++;
      }, context);
      return snapshot();
    },
    async complete(messages, requestId, { signal, role = 'repair' } = {}) {
      signal?.throwIfAborted();
      if (!Object.hasOwn(MODEL_ROLES, role)) throw new Error('Unknown planner model role: ' + role);
      // The shared HTTP queue owns serialization; configure only between completed runs.
      const selected = MODEL_ROLES[role];
      await root.configure({
        model: { provider: 'openai-codex', modelId: selected.model },
        thinkingLevel: selected.thinkingLevel,
      }, context);
      // Mindcraft supplies its complete current context. Do not append it to a second growing native chat.
      // Reset hides old entries from the next model input, but preserves originals in durable storage.
      await root.reset(undefined, context);
      const submission = await root.submit({
        type: 'input',
        requestId: worldScope ? `world:${worldScope.worldId}:${requestId}` : requestId,
        content: JSON.stringify({ conversation: messages }),
      }, context);
      let cancellation;
      const abort = () => {
        cancellation ??= root.abort(context);
        void cancellation.catch(() => console.error('Planner abort failed'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const deadline = setTimeout(abort, timeoutMs + 5000);
      try {
        const settled = await submission.wait(context);
        if (settled.status !== 'done' || settled.type !== 'input') throw new Error('Model run did not finish: ' + settled.reason);
        const answer = await root.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
        const message = answer?.model?.find(item => item.role === 'assistant');
        if (!message || message.stopReason !== 'stop') throw new Error('Model response failed or incomplete: ' + message?.stopReason);
        const text = message.content.filter(item => item.type === 'text').map(item => item.text).join('');
        if (!text.trim()) throw new Error('Model returned no textual answer');
        return { text, usage: message.usage, finishReason: 'stop', answerEntryId: settled.answer };
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        if (cancellation) await cancellation;
      }
    },
    close: () => harness.close(context),
  };
}
