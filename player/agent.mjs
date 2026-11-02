import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import {
  AssistantEntry, GenerationTask, Harness, LiveDoc, createRegistry, defineDoc, defineExtension, defineTool, hook,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const PLAYER_MODEL = 'gpt-6.1-sol';
const DIARY_MODEL = 'gpt-6.1-terra';
const context = BACKGROUND_CONTEXT;
const Conversations = defineDoc({
  kind: 'minecraft.player-conversations', version: 1, scope: 'session',
  initial: () => ({ diary: null, controllerMode: 'hot-reload-v3' }),
  checkpointWhen: () => true,
});

export const PLAYER_INSTRUCTIONS = `You are Roy's background realtime Minecraft controller engineer. A persistent OS-isolated JavaScript controller owns observe→decide→act locally without model approval. Inspect source, actual outcomes and real POV images, then hot-edit it through controller_edit. Ship the smallest useful exact edit immediately when a concrete defect is clear; do not regenerate unchanged source, explain a plan, build an offline fixture suite or perform a manual test/deploy ritual. Admission checks syntax, imports and the async decide entrypoint only. The harness safely cancels generated work, drains host RPC and hot-reloads the version. Real gameplay errors feed the next iteration; there is no gameplay approval or automatic rollback.
Preserve survival, food/tools, home/storage/bed, exploration and eventual dragon progression. Controller state carries resource dependencies, observed sites, exploration frontiers and failure lessons; death invalidates transient assumptions, not long-term goals. Base patches on the inspected active baseVersion; stale patches cannot replace newer source. One owner controls the player, while you improve its code in the background. Missing resources require spatial reasoning and legitimate exploration, not invented coordinates. Images show real observed terrain; host outcomes establish actual effects. Submit the change rather than narrating intentions. You have no host shell/files/network/credentials; tools define the API.`;

const DIARY_INSTRUCTIONS = `Write Roy's Minecraft adventure diary from the supplied factual events. Return one short subjective paragraph in English, in Roy's first-person voice: concrete, warm, occasionally dryly funny. Describe how the real experience felt, not telemetry or a list. Never invent actions, emotions of other players, achievements, encounters or completed construction. Distinguish failed attempts from success. Do not mention tools, model names or the harness. No heading, bullets, preamble or markdown fences.`;

function readBroker(socketPath, endpoint) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: endpoint, method: 'GET', timeout: 15000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('error', () => reject(new Error('Credential broker response failed')));
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Credential broker unavailable (${response.statusCode})`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Malformed credential broker response')); }
      });
    });
    request.on('error', () => reject(new Error('Credential broker connection failed')));
    request.on('timeout', () => request.destroy(new Error('Credential broker timeout')));
    request.end();
  });
}

// Same credential broker and provider as planner/engine.mjs, without its DSL/admission
// wrappers or 4096-token Sol cap. Secrets stay inside the provider's auth resolver.
export async function playerModels(socketPath) {
  const models = createModels({ identity: { attribution: { name: 'Minecraft Adventure' } } });
  const provider = openaiCodexProvider();
  const catalog = await readBroker(socketPath, '/models');
  const configured = [PLAYER_MODEL, DIARY_MODEL].map(id => {
    const model = catalog.find(candidate => candidate.provider === 'openai-codex' && candidate.id === id);
    if (!model) throw new Error(`Configured player model absent from canonical catalog: ${id}`);
    return model;
  });
  models.setProvider({
    ...provider,
    auth: { apiKey: { name: 'Local Codex credential broker', resolve: () => readBroker(socketPath, '/auth') } },
    getModels: () => configured,
    streamSimple: (model, transcript, options) => provider.streamSimple(model, transcript, {
      ...options, maxRetries: 0,
    }),
  });
  return models;
}

function nativeResult(value) {
  if (value && typeof value === 'object' && (
    (Array.isArray(value.output) && value.output.every(block => ['text', 'image'].includes(block?.type))) ||
    'control' in value || 'isError' in value
  )) return value;
  return { output: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }] };
}

/**
 * tools: plain {name, description, parameters: JSONSchema, execute(args, api, context)}[]
 * or native Pi tool definitions. Plain results become tool text; native results pass through.
 * step() does not own the game loop: action handles/programs keep running during model calls.
 * getFeedback({phase: 'beforeRequest' | 'onYield'}):
 * null | {key, needsEngineering, baseVersion, reasons, observation, images?}.
 * Existing requests accept refreshed snapshots with the same semantic key;
 * only a new key at onYield can request another model round.
 */
export async function openPlayerAgent({
  stateDir, worldId, socketPath, tools, instructions = '', onEvent = () => {}, models, getFeedback,
  signal, onStatus = () => {},
}) {
  const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  signal?.throwIfAborted();
  onStatus({ phase: 'opening', tasks: [] });
  if (typeof worldId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(worldId)) {
    throw new Error('worldId must be a safe, nonempty world identifier');
  }
  const directory = path.join(stateDir, 'worlds', worldId);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  models ??= await playerModels(socketPath);
  signal?.throwIfAborted();
  const emit = event => onEvent({ ...event, worldId });
  let modelCalls = 0;
  let diaryCalls = 0;
  let toolCalls = 0;
  let lastFeedbackKey;
  let busy = false;
  let narrating = false;
  let closed = false;
  const registry = createRegistry();
  const registeredTools = tools.map(tool => defineTool({
    ...tool,
    parameters: Type.Unsafe(tool.parameters),
    // Context admission/compaction owns model capacity. Never cut structured JSON
    // or controller source into an unreadable prefix at the tool boundary.
    outputLimits: tool.outputLimits ?? { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
    async execute(args, api, callContext) {
      toolCalls++;
      emit({ type: 'tool_start', name: tool.name, callId: api.callId, taskId: api.taskId });
      try {
        const result = nativeResult(await tool.execute(args, api, callContext));
        // Pi terminates only when every call in a round requests it. Read the
        // persisted round so remember+candidate/edit works after replay too.
        // Any failed admission/tool leaves its control unset and permits repair.
        const round = await api.snapshot(LiveDoc, api.conversationId, callContext);
        if (!result.isError && round?.tools?.some(call => ['controller_candidate', 'controller_edit'].includes(call.name))) {
          result.control = { ...result.control, terminate: true };
        }
        emit({ type: 'tool_end', name: tool.name, callId: api.callId, isError: result.isError === true });
        return result;
      } catch (error) {
        emit({ type: 'tool_end', name: tool.name, callId: api.callId, isError: true });
        throw error;
      }
    },
  }));
  async function readFreshFeedback(phase) {
    const feedback = await getFeedback?.({ phase });
    if (!feedback?.needsEngineering || (phase === 'onYield' && feedback.key === lastFeedbackKey)) return;
    lastFeedbackKey = feedback.key;
    return feedback;
  }
  function feedbackContent(feedback) {
    const text = JSON.stringify({
      worldId, observation: feedback.observation,
      feedback: {
        key: feedback.key, baseVersion: feedback.baseVersion, reasons: feedback.reasons,
        instruction: 'Inspect this fresh controller evidence. Keep local play running; submit improvements against this baseVersion, not an obsolete version.',
      },
    });
    return feedback.images?.length ? [{ type: 'text', text }, ...feedback.images] : text;
  }
  const player = defineExtension({
    name: 'minecraft.player', tools: registeredTools,
    hooks: [hook(GenerationTask, {
      async beforeRequest(request) {
        const feedback = await readFreshFeedback('beforeRequest');
        if (!feedback) return;
        emit({ type: 'feedback_injected', key: feedback.key, baseVersion: feedback.baseVersion });
        // Request-only evidence must be sampled again: reusing a cached snapshot
        // after newer tool results would put obsolete state last in the context.
        return {
          messages: [...request.messages, { role: 'user', content: feedbackContent(feedback), timestamp: Date.now() }],
        };
      },
      async onYield() {
        const feedback = await readFreshFeedback('onYield');
        if (!feedback) return;
        emit({ type: 'feedback_continue', key: feedback.key, baseVersion: feedback.baseVersion });
        return { continue: feedbackContent(feedback) };
      },
    })],
  });
  registry.install(player);
  // Enforcement belongs at the model boundary: Pi hooks report exceptions but do
  // not block generation. Never rely on an observational hook for a budget.
  const boundedModels = new Proxy(models, {
    get(target, key) {
      if (key === 'completeSimple') return (model, transcript, options) => boundedModels.streamSimple(model, transcript, options).result();
      if (key !== 'streamSimple') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (model, transcript, options) => {
        const output = new AssistantMessageEventStream();
        void (async () => {
          let failure = 'provider_request_failed';
          const fail = (reason = 'error') => {
            emit({ type: 'model_error', model: model.id, category: failure });
            output.push({ type: 'error', reason, error: {
              role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: reason, errorMessage: `Player model request failed: ${failure}`, timestamp: Date.now(),
            } });
            output.end();
          };
          try {
            const playing = model.id === PLAYER_MODEL;
            if (playing) modelCalls++;
            else diaryCalls++;
            emit({ type: 'model_start', model: model.id, request: playing ? modelCalls : diaryCalls });
            const upstream = target.streamSimple(model, transcript, options);
            for await (const event of upstream) {
              if (event.type === 'error') {
                fail(event.reason);
                return;
              }
              if (event.type === 'done') {
                const calls = event.message.content.filter(block => block.type === 'toolCall');
                if (!playing && (calls.length || event.message.stopReason === 'toolUse')) {
                  failure = 'diary_tools_forbidden';
                  fail();
                  return;
                }
                emit({ type: 'model_end', model: model.id, stopReason: event.message.stopReason, tools: calls.map(call => call.name) });
              }
              output.push(event);
            }
            output.end(await upstream.result());
          } catch {
            // Neither thrown provider diagnostics nor error terminal events may
            // copy credential-bearing response bodies into durable storage.
            fail(options?.signal?.aborted ? 'aborted' : 'error');
          }
        })();
        return output;
      };
    },
  });
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, 'agent.sqlite')), {
    models: boundedModels, registry,
    settings: {
      stream: { timeoutMs: 120000, maxRetries: 0 },
      retry: { enabled: false, maxRetries: 0 },
      afterFailedRun: 'withdraw',
      toolExecution: 'sequential',
      compaction: {
        enabled: true, backgroundTokens: 0,
        // Use the catalog's actual context capacity, reserving its supported
        // answer budget rather than forcing a 64k tactical working set.
        modelOverrides: Object.fromEntries([PLAYER_MODEL, DIARY_MODEL].map(id => [
          `openai-codex/${id}`, { reserveTokens: models.getModel('openai-codex', id).maxTokens },
        ])),
      },
    },
    onReport: (_error, info) => emit({ type: 'harness_report', category: info.type }),
  }, context);
  let closing;
  const close = () => {
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    closing ??= harness.close(BACKGROUND_CONTEXT);
    return closing;
  };
  // Cancelling a wait does not abort stored tasks. Closing checkpoints them for reopen.
  const onAbort = () => { void close().catch(error => emit({ type: 'close_error', message: error.message })); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const root = await harness.root(context);
    await root.configure({
      model: { provider: 'openai-codex', modelId: PLAYER_MODEL }, thinkingLevel: 'medium',
      extensions: [player], tools: registeredTools,
      instructions: `${PLAYER_INSTRUCTIONS}\n\nWorld identity: ${worldId}\n\n${instructions}`,
    }, context);
    let diaryId = (await harness.snapshot(Conversations, context))?.diary;
    const diary = diaryId
      ? await harness.conversation(diaryId, context)
      : await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { extensions: [], tools: [] } }, context);
    if (!diaryId) await root.commit(async tx => { (await tx.doc(Conversations)).diary = diary.id; }, context);
    await diary.configure({
      model: { provider: 'openai-codex', modelId: DIARY_MODEL }, thinkingLevel: 'low',
      extensions: [], tools: [], instructions: DIARY_INSTRUCTIONS,
    }, context);
    const inspection = await harness.inspect(context);
    const tasks = inspection.tasks.map(({ record, state }) => ({ id: record.id, taskKind: record.kind, ...state }));
    onStatus({ phase: tasks.some(task => task.kind === 'blocked') ? 'blocked' : 'recovering', tasks });
    const controllerMode = (await harness.snapshot(Conversations, context))?.controllerMode;
    harness.resume();
    if (controllerMode !== 'hot-reload-v3') {
      emit({ type: 'migration_started', controllerMode: 'hot-reload-v3' });
      // Existing generations retain their old tool schema: configure only changes
      // future turns. Retire obsolete turns before requiring candidate baseVersion.
      // Abort preserves the root, its history and all controller/world documents.
      await root.abort(context);
      await root.commit(async tx => {
        (await tx.doc(Conversations)).controllerMode = 'hot-reload-v3';
      }, context);
      emit({ type: 'migration_completed', controllerMode: 'hot-reload-v3' });
    }
    await root.waitForIdle(context);
    await diary.waitForIdle(context);
    signal?.throwIfAborted();
    onStatus({ phase: 'ready', tasks: [] });

    async function run(conversation, content, model) {
      const submission = await conversation.submit({ type: 'input', content }, context);
      const settled = await submission.wait(context);
      if (settled.status !== 'done' || settled.type !== 'input') throw new Error(`Player model run failed: ${settled.reason}`);
      const answer = await conversation.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
      const message = answer?.model?.find(item => item.role === 'assistant');
      if (!message || (message.stopReason !== 'stop' && !(model === PLAYER_MODEL && message.stopReason === 'toolUse'))) {
        throw new Error(`Player model response incomplete: ${message?.stopReason}`);
      }
      return {
        text: message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
        model, answerEntryId: settled.answer, worldId, usage: message.usage,
      };
    }

    return {
      async step(observation, { images = [], feedbackKey } = {}) {
        if (closed) throw new Error('Player agent is closed');
        if (busy) throw new Error('Player agent step already running');
        busy = true;
        modelCalls = 0;
        toolCalls = 0;
        lastFeedbackKey = feedbackKey;
        try {
          const text = JSON.stringify({ worldId, observation });
          const result = await run(root, images.length ? [{ type: 'text', text }, ...images] : text, PLAYER_MODEL);
          return { ...result, modelCalls, toolCalls, feedbackKey: lastFeedbackKey };
        } finally { busy = false; }
      },
      async narrate(facts) {
        if (closed) throw new Error('Player agent is closed');
        if (narrating) throw new Error('Diary narration already running');
        narrating = true;
        diaryCalls = 0;
        try {
          return await run(diary, JSON.stringify({ worldId, facts }), DIARY_MODEL);
        } finally { narrating = false; }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
