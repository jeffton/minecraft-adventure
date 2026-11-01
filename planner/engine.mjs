import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { AssistantEntry, Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { MODEL, MAX_OUTPUT_TOKENS } from './contracts.mjs';
import { admittedModels } from './admission.mjs';

export function readBrokerAuth(socketPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/auth', method: 'GET', timeout: 15000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) request.destroy(new Error('Credential broker response too large'));
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

export function brokerModels(socketPath) {
  const models = createModels({ identity: { attribution: { name: 'Minecraft Adventure' } } });
  const codex = openaiCodexProvider();
  const terra = codex.getModels().find(model => model.id === MODEL);
  if (!terra) throw new Error('Configured Terra model is absent from the SDK registry');
  models.setProvider({
    ...codex,
    auth: { apiKey: {
      name: 'Local Codex credential broker',
      resolve: async () => readBrokerAuth(socketPath),
    } },
    getModels: () => [{ ...terra, maxTokens: MAX_OUTPUT_TOKENS }],
    streamSimple: (model, context, options) => codex.streamSimple(model, context, {
      ...options,
      maxTokens: MAX_OUTPUT_TOKENS,
      reasoning: 'low',
      maxRetries: 0,
    }),
  });
  return models;
}

export async function openEngine({ stateDir, socketPath, models = brokerModels(socketPath), timeoutMs = 120000, intervalMs = 20000 }) {
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
    model: { provider: 'openai-codex', modelId: MODEL },
    thinkingLevel: 'low',
    tools: [],
    instructions: 'You are the model component of Minecraft Adventure. Follow the supplied Minecraft task and conversation. Return the requested textual response only. You have no shell, files, network tools or authority outside the game. Never invent completed game actions.',
  } });
  harness.resume();
  await root.waitForIdle(context);

  return {
    async complete(messages, requestId, { signal } = {}) {
      signal?.throwIfAborted();
      // Mindcraft supplies its complete current context. Do not append it to a second growing native chat.
      // Reset hides old entries from the next model input, but preserves originals in durable storage.
      await root.reset(undefined, context);
      const submission = await root.submit({
        type: 'input',
        requestId,
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
        if (!message || ['error', 'aborted'].includes(message.stopReason)) throw new Error('Model response failed');
        const text = message.content.filter(item => item.type === 'text').map(item => item.text).join('');
        if (!text.trim()) throw new Error('Model returned no textual answer');
        return { text, usage: message.usage, finishReason: message.stopReason === 'length' ? 'length' : 'stop' };
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        if (cancellation) await cancellation;
      }
    },
    close: () => harness.close(context),
  };
}
