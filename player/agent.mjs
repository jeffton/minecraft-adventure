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
const MAX_MODEL_CALLS = 8;
const MAX_TOOL_CALLS = 12;
const context = BACKGROUND_CONTEXT;
const Conversations = defineDoc({
  kind: 'minecraft.player-conversations', version: 1, scope: 'session',
  initial: () => ({ diary: null }),
});

export const PLAYER_INSTRUCTIONS = `You are Roy, an autonomous Minecraft survival player and programmer. Play the game, not a task-management simulation. Survive, acquire food and useful equipment, build a good-looking practical home with storage and a bed, explore and eventually defeat the dragon. Choose your own tactics from current evidence.
Use the real tools to observe, write and run short JavaScript skills, inspect their action handles, cancel obsolete actions and store reusable skills. Tool descriptions and runtime instructions define the available Minecraft API. You have no host shell, filesystem, arbitrary network or credentials. Do not invent API methods or issue JSON pretending to call tools.
Keep useful local programs running while you think. Starting code returns a handle, not proof of completion. Do not cancel useful work simply to deliberate, repeatedly poll a running handle, or start conflicting movement/inventory programs. Prefer one productive bounded program over many tiny tool calls. Each observation permits at most 8 model requests and 12 tool calls; start useful work and yield a brief status instead of polling in a loop.
Act on fresh observations and actual prerequisites. Death invalidates old inventory and equipment assumptions. Inspect failures and change the failing approach; do not repeat impossible equipment, crafting, navigation or resource requests. Reuse successful skills, improve them from failures and save generally useful code. A skill is verified only by host-observed game effects, never its own claimed return value.
Images are actual attached Minecraft views; identify visible hazards and construction quality, respect their timestamps and do not assume unseen terrain. Structured game observations are authoritative for inventory, health, position and action outcomes. Distinguish intended, started and verified results. Preserve concise strategic memory, useful locations, action handles and lessons through conversation compaction; skills are stored separately by the supplied tools.`;

const DIARY_INSTRUCTIONS = `Write Roy's Minecraft adventure diary from the supplied factual events. Return one short subjective paragraph in English, in Roy's first-person voice: concrete, warm, occasionally dryly funny. Describe how the real experience felt, not telemetry or a list. Never invent actions, emotions of other players, achievements, encounters or completed construction. Distinguish failed attempts from success. Do not mention tools, model names or the harness. No heading, bullets, preamble or markdown fences.`;

function readBroker(socketPath, endpoint, maxBytes) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: endpoint, method: 'GET', timeout: 15000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > maxBytes) request.destroy(new Error('Credential broker response too large'));
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
  const catalog = await readBroker(socketPath, '/models', 1024 * 1024);
  const configured = [PLAYER_MODEL, DIARY_MODEL].map(id => {
    const model = catalog.find(candidate => candidate.provider === 'openai-codex' && candidate.id === id);
    if (!model) throw new Error(`Configured player model absent from canonical catalog: ${id}`);
    return { ...model, maxTokens: id === PLAYER_MODEL ? 8192 : 2048 };
  });
  models.setProvider({
    ...provider,
    auth: { apiKey: { name: 'Local Codex credential broker', resolve: () => readBroker(socketPath, '/auth', 16384) } },
    getModels: () => configured,
    streamSimple: (model, transcript, options) => provider.streamSimple(model, transcript, {
      ...options, maxTokens: model.id === PLAYER_MODEL ? 8192 : 2048, maxRetries: 0,
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
 * getFeedback(): null | {key, needsAction, observation, images?}; keys identify
 * state changes, not clock ticks. Fresh idle feedback can continue a native run.
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
    outputLimits: tool.outputLimits ?? { maxBytes: 24000, maxLines: 300 },
    async execute(args, api, callContext) {
      if (++toolCalls > MAX_TOOL_CALLS) throw new Error('Player tool budget exhausted; wait for a fresh observation');
      emit({ type: 'tool_start', name: tool.name, callId: api.callId, taskId: api.taskId });
      try {
        const result = nativeResult(await tool.execute(args, api, callContext));
        // Pi terminates only when every call in a round requests it. Read the
        // persisted round so remember+execute works too, including after replay.
        // Any failed admission/tool leaves its control unset and permits repair.
        const round = await api.snapshot(LiveDoc, api.conversationId, callContext);
        if (!result.isError && round?.tools?.some(call => ['execute', 'queue_next'].includes(call.name))) {
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
  const player = defineExtension({
    name: 'minecraft.player', tools: registeredTools,
    hooks: [hook(GenerationTask, {
      async onYield() {
        if (!getFeedback || modelCalls >= MAX_MODEL_CALLS - 1 || toolCalls >= MAX_TOOL_CALLS - 1) return;
        const feedback = await getFeedback();
        if (!feedback?.needsAction || feedback.key === lastFeedbackKey ||
            feedback.observation.action?.state === 'running' || feedback.observation.reflexOwner) return;
        lastFeedbackKey = feedback.key;
        const text = JSON.stringify({
          worldId, observation: feedback.observation,
          feedback: { key: feedback.key, instruction: 'Use this fresh server-backed state to start the next useful action.' },
        });
        emit({ type: 'feedback_continue', key: feedback.key });
        return { continue: feedback.images?.length ? [{ type: 'text', text }, ...feedback.images] : text };
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
            if ((playing && modelCalls >= MAX_MODEL_CALLS) || (!playing && diaryCalls >= 2)) {
              failure = 'model_budget_exhausted';
              fail();
              return;
            }
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
                if (playing && toolCalls + calls.length > MAX_TOOL_CALLS) {
                  failure = 'tool_budget_exhausted';
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
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 12000, backgroundTokens: 0 },
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
    harness.resume();
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
      async step(observation, { images = [] } = {}) {
        if (closed) throw new Error('Player agent is closed');
        if (busy) throw new Error('Player agent step already running');
        busy = true;
        modelCalls = 0;
        toolCalls = 0;
        lastFeedbackKey = undefined;
        try {
          const text = JSON.stringify({ worldId, observation });
          const result = await run(root, images.length ? [{ type: 'text', text }, ...images] : text, PLAYER_MODEL);
          return { ...result, modelCalls, toolCalls };
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
