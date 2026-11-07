import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openPlayerAgent, playerModels } from '../agent.mjs';

const answer = text => fauxAssistantMessage(text);
const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const schema = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false };
const versionedCandidateSchema = {
  ...schema, properties: { ...schema.properties, baseVersion: { type: 'string' } }, required: ['code', 'baseVersion'],
};

async function fixture(responses, tools = [], contextWindow = 131072, getFeedback) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-player-agent-'));
  const models = createModels();
  const provider = fauxProvider({
    provider: 'openai-codex', tokensPerSecond: 1000000,
    models: ['gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id, reasoning: true, input: ['text', 'image'], contextWindow })),
  });
  const calls = [];
  provider.setResponses(responses.map(response => async (context, options, state, model) => {
    calls.push({ context: structuredClone(context), options, model: model.id });
    return typeof response === 'function' ? response(context, options, state, model) : response;
  }));
  models.setProvider(provider.provider);
  const events = [];
  const open = (worldId = 'fresh-one') => openPlayerAgent({
    stateDir, worldId, models, tools, getFeedback,
    instructions: 'Runtime API documentation.', onEvent: event => events.push(event),
  });
  return { open, calls, events, provider, stateDir, models };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('real Pi registry dispatches native tool calls, validates plain schemas and records results in model context', async () => {
  const executed = [];
  const f = await fixture([
    call('execute_code', {}),
    call('execute_code', { code: 'await mc.observe()' }),
    answer('Started inspecting my surroundings.'),
  ], [{
    name: 'execute_code', description: 'Start asynchronous JavaScript; returns an action handle.', parameters: schema,
    execute: async args => { executed.push(args); return { id: 'action-1', status: 'running' }; },
  }]);
  const agent = await f.open();
  try {
    const result = await agent.step({ inventory: [], health: 20 });
    assert.deepEqual(executed, [{ code: 'await mc.observe()' }]);
    assert.equal(result.model, 'gpt-6.1-sol');
    assert.equal(result.toolCalls, 1);
    assert.equal(result.modelCalls, 3);
    assert.ok(Number.isInteger(result.answerEntryId));
    assert.match(JSON.stringify(f.calls[1].context), /invalid|required|Expected.*string/i);
    assert.match(JSON.stringify(f.calls[2].context), /action-1/);
    assert.equal(f.calls[0].options.reasoning, 'medium');
    assert.equal(f.calls[0].context.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? [])[0].name, 'execute_code');
    assert.deepEqual(f.events.filter(event => event.type === 'tool_start').map(event => event.name), ['execute_code']);
  } finally { await agent.close(); }
});

test('accepted exact edits finish without an extra narration turn', async () => {
  const f = await fixture([call('controller_edit', { code: 'exact correction' }), answer('must not be requested')], [{
    name: 'controller_edit', description: 'Apply a version-aware exact edit.', parameters: schema,
    execute: async () => ({ version: 'edited', status: 'pending_validation' }),
  }]);
  const agent = await f.open();
  try {
    const result = await agent.step({});
    assert.equal(result.modelCalls, 1);
    assert.equal(result.toolCalls, 1);
  } finally { await agent.close(); }
});

test('saving controller candidates finishes native turns without narration and retains real staging results', async () => {
  let version = 0;
  const f = await fixture([
    call('controller_candidate', { code: 'gather controller' }),
    call('controller_candidate', { code: 'craft controller' }),
    answer('Inspected controller validation and activation outcomes.'),
  ], [{
    name: 'controller_candidate', description: 'Stage a controller version for validation.', parameters: schema,
    execute: async () => ({ version: `candidate-${++version}`, status: 'pending_validation' }),
  }]);
  let agent = await f.open();
  try {
    const first = await agent.step({ controller: null });
    assert.equal(first.modelCalls, 1);
    assert.equal(first.toolCalls, 1);
    assert.equal((await agent.step({ controller: { version: 'candidate-1', status: 'active' } })).modelCalls, 1);
    assert.equal(version, 2);
    assert.equal(f.calls.length, 2, 'no additional final-answer model requests');
    await agent.close();
    agent = await f.open();
    await agent.step({ controller: { version: 'candidate-2', status: 'active' } });
    assert.doesNotMatch(JSON.stringify(f.calls[2].context), /candidate-1/);
    assert.match(JSON.stringify(f.calls[2].context), /candidate-2/);
    assert.doesNotMatch(JSON.stringify(f.calls[2].context), /pending_validation/);
  } finally { await agent.close(); }
});

for (const completionTool of ['mission', 'controller_candidate', 'controller_edit']) {
  test(`mixed remember and ${completionTool} rounds skip narration in either order, but failed admission permits correction`, async () => {
    const mixed = order => fauxAssistantMessage(order.map(name => fauxToolCall(name, { code: name })), { stopReason: 'toolUse' });
    const executed = [];
    let failAdmission = false;
    const f = await fixture([
      mixed(['remember', completionTool]), mixed([completionTool, 'remember']),
      mixed(['remember', completionTool]), answer('Correct the failed candidate.'),
      mixed([completionTool, 'remember']), answer('Correct the failed candidate again.'),
    ], ['remember', completionTool].map(name => ({
      name, description: 'A controller engineering tool.', parameters: schema,
      execute: async () => {
        executed.push(name);
        if (name === completionTool && failAdmission) throw new Error('Controller state changed');
        return { accepted: true };
      },
    })));
    const agent = await f.open();
    try {
      for (let round = 0; round < 2; round++) {
        const result = await agent.step({});
        assert.equal(result.modelCalls, 1);
        assert.equal(result.toolCalls, 2);
      }
      assert.deepEqual(executed, ['remember', completionTool, completionTool, 'remember']);
      failAdmission = true;
      assert.equal((await agent.step({})).modelCalls, 2);
      assert.match(JSON.stringify(f.calls[3].context), /Controller state changed/);
      assert.equal((await agent.step({})).modelCalls, 2);
      assert.match(JSON.stringify(f.calls[5].context), /Controller state changed/);
      assert.deepEqual(executed.slice(4), ['remember', completionTool, completionTool, 'remember']);
    } finally { await agent.close(); }
  });
}

for (const failure of ['throw', 'error result']) {
  test(`failed candidate admission (${failure}) reaches the model for correction rather than terminating`, async () => {
    let admissions = 0;
    const f = await fixture([
      call('controller_candidate', { code: 'invalid' }),
      call('controller_candidate', { code: 'corrected' }),
      answer('Inspected the staged correction.'),
    ], [{
      name: 'controller_candidate', description: 'Stage a controller version.', parameters: schema,
      execute: async ({ code }) => {
        admissions++;
        if (code === 'invalid') {
          if (failure === 'throw') throw new Error('Controller context changed');
          return { isError: true, output: [{ type: 'text', text: 'Controller context changed' }] };
        }
        return { version: 'corrected-candidate', status: 'pending_validation' };
      },
    }]);
    const agent = await f.open();
    try {
      const result = await agent.step({});
      assert.equal(result.modelCalls, 2);
      assert.equal(result.toolCalls, 2);
      assert.equal(admissions, 2);
      assert.match(JSON.stringify(f.calls[1].context), /Controller context changed/);
      await agent.step({});
      assert.doesNotMatch(JSON.stringify(f.calls[2].context), /corrected-candidate/);
    } finally { await agent.close(); }
  });
}

test('remember without a controller candidate retains the ordinary native continuation', async () => {
  const f = await fixture([call('remember', { code: 'known resource habitat' }), answer('Memory saved.')], [{
    name: 'remember', description: 'Persist strategic memory.', parameters: schema,
    execute: async () => ({ saved: 'resource-habitat-marker' }),
  }]);
  const agent = await f.open();
  try {
    const result = await agent.step({});
    assert.equal(result.modelCalls, 2);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.text, 'Memory saved.');
    assert.match(JSON.stringify(f.calls[1].context), /resource-habitat-marker/);
  } finally { await agent.close(); }
});

async function seedCheckpointedTurn(f, controllerMode) {
  const context = BACKGROUND_CONTEXT;
  const documents = defineDoc({
    kind: 'minecraft.player-conversations', version: 1, scope: 'session',
    initial: () => ({ diary: null, ...(controllerMode ? { controllerMode } : {}) }),
    checkpointWhen: () => true,
  });
  const knowledge = defineDoc({
    kind: 'minecraft.test-controller-knowledge', version: 1, scope: 'session',
    initial: () => ({ skills: ['preserved-shelter-skill'], home: { x: 12, y: 64, z: 34 } }),
    checkpointWhen: () => true,
  });
  const database = path.join(f.stateDir, 'worlds/fresh-one/agent.sqlite');
  const registry = createRegistry();
  const candidate = defineTool({
    name: 'controller_candidate', description: 'Stage controller code.',
    parameters: Type.Unsafe(['hot-reload-v3', 'mission-v1'].includes(controllerMode) ? versionedCandidateSchema : schema),
    execute: async () => ({ output: [{ type: 'text', text: 'Staged.' }] }),
  });
  const extension = defineExtension({ name: 'minecraft.player', tools: [candidate] });
  registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(database), { models: f.models, registry }, context);
  const root = await harness.root(context);
  await root.configure({
    model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' },
    instructions: 'Archived controller engineer instructions.',
    extensions: [extension], tools: [candidate],
  }, context);
  const diary = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { tools: [] } }, context);
  await diary.configure({ model: { provider: 'openai-codex', modelId: 'gpt-6.1-terra' } }, context);
  await root.commit(async tx => {
    (await tx.doc(documents)).diary = diary.id;
    await tx.doc(knowledge);
  }, context);
  const history = await root.submit({ type: 'input', content: 'preserved-root-landmark-marker' }, context);
  await history.wait(context);
  const diaryHistory = await diary.submit({ type: 'input', content: 'preserved-diary-facts-marker' }, context);
  await diaryHistory.wait(context);
  const strategy = controllerMode === 'mission-v1'
    ? await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { tools: [candidate], extensions: [extension] } }, context)
    : null;
  if (strategy) {
    await strategy.configure({ model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' } }, context);
    await root.commit(async tx => { (await tx.doc(documents)).strategy = strategy.id; }, context);
  }
  await (strategy ?? root).submit({ type: 'input', content: 'checkpointed-controller-turn-marker' }, context);
  return { harness, root, strategy, diary, documents, knowledge, database };
}

for (const controllerMode of [undefined, 'persistent-v1', 'reactive-v2', 'hot-reload-v3', 'mission-v1']) {
  const currentMode = controllerMode === 'mission-v1';
  test(`${currentMode ? 'mission restart resumes' : `${controllerMode ?? 'legacy'} migration retires`} a checkpointed generation without losing archived history or documents`, async () => {
    const entered = deferred();
    const f = await fixture([
      answer('Preserved root survival lesson.'),
      answer('Preserved diary paragraph.'),
      async (_context, options) => {
        entered.resolve();
        // Closing the harness checkpoints this unfinished generation. The model
        // must honor cancellation so close does not wait for an external service.
        await new Promise(resolve => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener('abort', resolve, { once: true });
        });
        return answer('Interrupted generation.');
      },
      ...Array.from({ length: 8 }, () => answer('Current controller inspection.')),
    ], [{
      name: 'controller_candidate', description: 'Stage versioned controller code.', parameters: versionedCandidateSchema,
      execute: async () => ({ accepted: true }),
    }]);
    const seeded = await seedCheckpointedTurn(f, controllerMode);
    await entered.promise;
    const checkpointSchema = f.calls.at(-1).context.messages
      .filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? [])
      .findLast(tool => tool.name === 'controller_candidate').parameters;
    assert.equal(checkpointSchema.required.includes('baseVersion'), ['hot-reload-v3', 'mission-v1'].includes(controllerMode), 'the checkpoint actually uses its original tool schema');
    await seeded.harness.close(BACKGROUND_CONTEXT);
    const inspectHarness = await Harness.open(await openNodeSqliteStorage(seeded.database), { models: f.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    const checkpoint = await inspectHarness.inspect(BACKGROUND_CONTEXT);
    assert.ok(checkpoint.tasks.some(({ state }) => state.kind !== 'terminal'), 'a real unfinished generation was persisted');
    await inspectHarness.close(BACKGROUND_CONTEXT);

    let agent = await f.open();
    try {
      const expectedMigrations = currentMode ? [] : ['migration_started', 'migration_completed'];
      assert.deepEqual(f.events.filter(event => event.type.startsWith('migration_')).map(event => event.type), expectedMigrations);
      assert.equal(f.calls.length, currentMode ? 4 : 3, 'legacy generations must not dispatch before retirement; missions resume');
      const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S8sAAAAASUVORK5CYII=' };
      await agent.step({ controller: 'fresh-controller-observation-marker' }, { images: [image] });
      const fresh = f.calls.at(-1).context;
      const freshSchema = fresh.messages.filter(message => message.role === 'system')
        .flatMap(message => message.toolsAdded ?? []).findLast(tool => tool.name === 'controller_candidate').parameters;
      assert.ok(freshSchema.required.includes('baseVersion'), 'the fresh native turn exposes the required versioned candidate interface');
      assert.match(JSON.stringify(fresh), /Minecraft strategist and skill author/);
      assert.doesNotMatch(JSON.stringify(fresh), /preserved-root-landmark-marker|Preserved root survival lesson/);
      assert.doesNotMatch(JSON.stringify(fresh), /checkpointed-controller-turn-marker/);
      const input = fresh.messages.filter(message => message.role === 'user').at(-1);
      assert.deepEqual(input.content.find(block => block.type === 'image'), image);
      assert.match(JSON.stringify(input), /fresh-controller-observation-marker/);
      await agent.narrate({ events: ['fresh-diary-event'] });
      assert.match(JSON.stringify(f.calls.at(-1).context), /preserved-diary-facts-marker/);
      assert.match(JSON.stringify(f.calls.at(-1).context), /Preserved diary paragraph/);
      await agent.close();
      agent = await f.open();
      assert.deepEqual(f.events.filter(event => event.type.startsWith('migration_')).map(event => event.type), expectedMigrations, 'ordinary reopen must not migrate again');
      await agent.step({ controller: 'ordinary-reopen-marker' });
      assert.doesNotMatch(JSON.stringify(f.calls.at(-1).context), /fresh-controller-observation-marker/);
    } finally { await agent.close(); }

    const verifiedStorage = await openNodeSqliteStorage(seeded.database);
    const verified = await Harness.open(verifiedStorage, { models: f.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      assert.equal((await verified.root(BACKGROUND_CONTEXT)).id, seeded.root.id);
      const saved = await verified.snapshot(seeded.documents, BACKGROUND_CONTEXT);
      assert.equal(saved.diary, seeded.diary.id);
      assert.equal(saved.controllerMode, 'mission-v1');
      assert.notEqual(saved.strategy, seeded.root.id);
      if (seeded.strategy) {
        assert.notEqual(saved.strategy, seeded.strategy.id);
        const recovered = await verified.conversation(seeded.strategy.id, BACKGROUND_CONTEXT);
        assert.match(JSON.stringify(await recovered.context(BACKGROUND_CONTEXT)), /checkpointed-controller-turn-marker/);
      }
      const archive = await verified.root(BACKGROUND_CONTEXT);
      assert.match(JSON.stringify(await archive.context(BACKGROUND_CONTEXT)), /preserved-root-landmark-marker/);
      assert.match(JSON.stringify(await archive.context(BACKGROUND_CONTEXT)), /Preserved root survival lesson/);
      assert.deepEqual(await verified.snapshot(seeded.knowledge, BACKGROUND_CONTEXT), {
        skills: ['preserved-shelter-skill'], home: { x: 12, y: 64, z: 34 },
      });
      const tasks = await verifiedStorage.scanTasks({ status: 'terminal' }, 100, undefined, BACKGROUND_CONTEXT);
      const checkpointIds = new Set(checkpoint.tasks.map(({ record }) => record.id));
      assert.ok(tasks.items.some(record => checkpointIds.has(record.id) &&
        record.state.outcome.status === (currentMode ? 'completed' : 'aborted')),
      'the checkpointed generation reaches the appropriate terminal outcome');
    } finally { await verified.close(BACKGROUND_CONTEXT); }
  });
}

test('completed episodes start fresh after reopen, and worlds remain isolated', async () => {
  const f = await fixture([answer('I remember the old oak tree.'), answer('Continue here.'), answer('A fresh start.')]);
  let agent = await f.open();
  try {
    await agent.step({ landmark: 'unique-oak-coordinate-marker' });
    await agent.close();
    agent = await f.open();
    await agent.step({ health: 19 });
    assert.doesNotMatch(JSON.stringify(f.calls[1].context), /unique-oak-coordinate-marker|I remember the old oak tree/);
    await agent.close();
    agent = await f.open('fresh-two');
    await agent.step({ health: 20 });
    assert.doesNotMatch(JSON.stringify(f.calls[2].context), /unique-oak-coordinate-marker|I remember the old oak tree/);
    for (const { context } of f.calls) {
      const instructions = JSON.stringify(context);
      assert.match(instructions, /David's architectural ambition, in every world/);
      assert.match(instructions, /multiple storeys, generous ceiling heights, large well-composed windows and a balcony/);
      assert.match(instructions, /Either omit a basement or give it a proper, usable stairway/);
      assert.match(instructions, /complete house need not be built on the first night/);
      assert.match(instructions, /David's harvesting preference/);
      assert.match(instructions, /David's mining preference/);
      assert.match(instructions, /NOT an instruction to start mining or replace the current mission/);
      assert.match(instructions, /Overworld ore guide for Java 26\.3/);
    }
  } finally { await agent.close(); }
});

test('images reach the real provider transcript as image blocks, not JSON or fake tool calls', async () => {
  const f = await fixture([answer('There is water ahead.')]);
  const agent = await f.open();
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S8sAAAAASUVORK5CYII=' };
  try {
    await agent.step({ camera: 'Roy first person' }, { images: [image] });
    const input = f.calls[0].context.messages.find(message => message.role === 'user');
    assert.ok(Array.isArray(input.content));
    assert.deepEqual(input.content.find(block => block.type === 'image'), image);
  } finally { await agent.close(); }
});

test('runtime work can continue during model waits; overlapping observations are rejected instead of queued', async () => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture([async () => { entered.resolve(); await release.promise; return answer('Still working.'); }]);
  const agent = await f.open();
  try {
    const pending = agent.step({ action: { id: 'long-local-program', status: 'running' } });
    await entered.promise;
    let ticks = 0;
    await new Promise(resolve => setImmediate(() => { ticks++; resolve(); }));
    assert.equal(ticks, 1);
    await assert.rejects(agent.step({ obsolete: true }), /already running/);
    release.resolve();
    await pending;
    assert.equal(f.calls.length, 1);
  } finally { release.resolve(); await agent.close(); }
});

test('Terra narrates in an independent persistent conversation without tools or player transcript resets', async () => {
  const f = await fixture([
    answer('Player plan about private-landmark.'),
    answer('I finally found my feet after a wet morning.'),
    answer('Continue the player plan.'),
    answer('The shelter is taking shape.'),
  ]);
  let agent = await f.open();
  try {
    await agent.step({ landmark: 'player-only-marker' });
    const diary = await agent.narrate({ events: ['diary-only-marker'] });
    assert.equal(diary.model, 'gpt-6.1-terra');
    assert.equal(diary.worldId, 'fresh-one');
    assert.equal(f.calls[1].options.reasoning, 'low');
    assert.equal(f.calls[1].context.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? []).length, 0);
    assert.doesNotMatch(JSON.stringify(f.calls[1].context), /player-only-marker|private-landmark/);
    await agent.step({ health: 20 });
    assert.doesNotMatch(JSON.stringify(f.calls[2].context), /player-only-marker/);
    assert.doesNotMatch(JSON.stringify(f.calls[2].context), /diary-only-marker/);
    await agent.close();
    agent = await f.open();
    await agent.narrate({ events: ['a new factual event'] });
    assert.match(JSON.stringify(f.calls[3].context), /diary-only-marker/);
    assert.doesNotMatch(JSON.stringify(f.calls[3].context), /player-only-marker/);
  } finally { await agent.close(); }
});

test('engineering can inspect beyond eight rounds without losing the turn', async () => {
  let polls = 0;
  const f = await fixture([
    ...Array.from({ length: 8 }, () => call('action_status', {})), answer('Fresh observation received.'),
  ], [{
    name: 'action_status', description: 'Inspect current action once.', parameters: { type: 'object', properties: {} },
    replay: 'safe', execute: async () => { polls++; return { status: 'running' }; },
  }]);
  const agent = await f.open();
  try {
    const result = await agent.step({ status: 'running' });
    assert.equal(f.calls.length, 9);
    assert.equal(polls, 8);
    assert.equal(result.text, 'Fresh observation received.');
    assert.equal(result.modelCalls, 9);
  } finally { await agent.close(); }
});

test('engineering can inspect more than twelve tools and sees genuine tool errors', async () => {
  let executions = 0;
  const f = await fixture([
    fauxAssistantMessage(Array.from({ length: 13 }, (_, i) => fauxToolCall('inspect', {}, { id: `too-many-${i}` })), { stopReason: 'toolUse' }),
    call('inspect', {}), answer('I need a different approach.'),
  ], [{
    name: 'inspect', description: 'Inspect one thing.', parameters: { type: 'object', properties: {} },
    execute: async () => { executions++; throw new Error('Target is not reachable from the observed position'); },
  }]);
  const agent = await f.open();
  try {
    const result = await agent.step({});
    assert.equal(executions, 14);
    assert.match(JSON.stringify(f.calls[2].context), /Target is not reachable/);
    assert.equal(result.text, 'I need a different approach.');
  } finally { await agent.close(); }
});

test('large structured controller and observation results remain complete model-visible JSON', async () => {
  const payload = { code: 'x'.repeat(40_000), state: { routes: 'y'.repeat(24_000) }, finalMarker: 'complete-controller-state' };
  const f = await fixture([call('controller_inspect', {}), answer('Inspected the complete controller.')], [{
    name: 'controller_inspect', description: 'Read complete source and state.', parameters: { type: 'object', properties: {} },
    execute: async () => payload,
  }]);
  const agent = await f.open();
  try {
    await agent.step({});
    const result = f.calls[1].context.messages.findLast(message => message.role === 'toolResult');
    assert.deepEqual(JSON.parse(result.content.find(block => block.type === 'text').text), payload);
  } finally { await agent.close(); }
});

test('unsafe world identifiers are rejected before storage opens', async () => {
  await assert.rejects(openPlayerAgent({ stateDir: '/tmp', worldId: '../old-world', tools: [] }), /worldId/);
});

test('player preserves canonical context and output capacity without fetching credentials at startup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'minecraft-player-broker-'));
  const socketPath = path.join(directory, 'broker.sock');
  const base = openaiCodexProvider().getModels().find(model => model.id === 'gpt-6.1-sol');
  let catalog = ['gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ ...base, id, name: `Canonical ${id}` }));
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    assert.equal(request.url, '/models');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(catalog));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    const models = await playerModels(socketPath);
    assert.equal(models.getModel('openai-codex', 'gpt-6.1-sol').maxTokens, base.maxTokens);
    assert.equal(models.getModel('openai-codex', 'gpt-6.1-terra').maxTokens, base.maxTokens);
    assert.equal(models.getModel('openai-codex', 'gpt-6.1-sol').contextWindow, base.contextWindow);
    assert.equal(models.getModel('openai-codex', 'gpt-6.1-sol').name, 'Canonical gpt-6.1-sol');
    assert.deepEqual(requests, ['/models']);
    catalog = catalog.filter(model => model.id !== 'gpt-6.1-sol');
    await assert.rejects(playerModels(socketPath), /absent from canonical catalog/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('provider error diagnostics never enter persisted transcripts or host event logs', async () => {
  const secret = 'SYNTHETIC_PROVIDER_SECRET_MARKER';
  const f = await fixture([fauxAssistantMessage('', { stopReason: 'error', errorMessage: secret })]);
  const agent = await f.open();
  await assert.rejects(agent.step({ health: 20 }), /model run failed/);
  await agent.close();
  const database = await readFile(path.join(f.stateDir, 'worlds/fresh-one/agent.sqlite'));
  assert.equal(database.includes(Buffer.from(secret)), false);
  assert.doesNotMatch(JSON.stringify(f.events), /SYNTHETIC_PROVIDER_SECRET_MARKER/);
  assert.ok(f.events.some(event => event.type === 'model_error' && event.category === 'provider_request_failed'));
});

test('Terra cannot start nonexistent tools or loop through a narration tool storm', async () => {
  const f = await fixture([call('invented_tool', {}), answer('A short factual paragraph.')]);
  const agent = await f.open();
  try {
    await assert.rejects(agent.narrate({ events: ['one event'] }), /model run failed/);
    assert.equal(f.calls.length, 1);
    assert.ok(f.events.some(event => event.category === 'diary_tools_forbidden'));
    assert.equal((await agent.narrate({ events: ['one new event'] })).text, 'A short factual paragraph.');
  } finally { await agent.close(); }
});

test('new engineer feedback during model thinking continues with persisted fresh facts and real images while play runs', async () => {
  const waiting = deferred();
  const release = deferred();
  let feedback = null;
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S8sAAAAASUVORK5CYII=' };
  const f = await fixture([
    async () => { waiting.resolve(); await release.promise; return answer('The controller is still working.'); },
    answer('The current failure requires a controller improvement.'),
    answer('I remember the actual failure.'),
  ], [], 131072, () => feedback);
  let agent = await f.open();
  try {
    const pending = agent.step({ controller: { version: 'v1' } });
    await waiting.promise;
    feedback = {
      key: 'v1:new-failure', needsEngineering: true, baseVersion: 'v1', reasons: ['error'],
      observation: { action: { id: 'local-1', state: 'running' }, notes: { outcome: 'server-confirmed-failure-marker' }, reflexOwner: 'defending' },
      images: [image],
    };
    release.resolve();
    const result = await pending;
    assert.equal(result.modelCalls, 2);
    assert.equal(result.feedbackKey, 'v1:new-failure');
    const continuation = f.calls[1].context.messages.filter(message => message.role === 'user').at(-1);
    assert.deepEqual(continuation.content.find(block => block.type === 'image'), image);
    const input = JSON.parse(continuation.content.find(block => block.type === 'text').text);
    assert.equal(input.observation.action.state, 'running');
    assert.equal(input.observation.notes.outcome, 'server-confirmed-failure-marker');
    assert.equal(input.feedback.key, 'v1:new-failure');
    assert.equal(input.feedback.baseVersion, 'v1');
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 1);
    await agent.close();
    agent = await f.open();
    await agent.step({ controller: { version: 'v1' } }, { feedbackKey: result.feedbackKey });
    assert.match(JSON.stringify(f.calls[2].context), /server-confirmed-failure-marker/);
    assert.doesNotMatch(JSON.stringify(f.calls[2].context), /The controller is still working/);
  } finally { release.resolve(); await agent.close(); }
});

test('fresh feedback and images reach an existing tool-round request, not an extra model turn', async () => {
  let feedback = null;
  const image = { type: 'image', mimeType: 'image/png', data: 'AA==' };
  const f = await fixture([
    call('inspect_controller', {}),
    answer('Updated assessment.'),
  ], [{
    name: 'inspect_controller', description: 'Inspect local controller evidence.', parameters: { type: 'object', properties: {} },
    execute: async () => {
      feedback = {
        key: 'v2:death-1', needsEngineering: true, baseVersion: 'v2', reasons: ['death', 'version-change'],
        observation: { action: { state: 'running' }, life: 1 }, images: [image],
      };
      return { inspected: true };
    },
  }], 131072, () => feedback);
  const agent = await f.open();
  try {
    const result = await agent.step({});
    assert.equal(result.modelCalls, 2);
    assert.equal(result.toolCalls, 1);
    const fresh = f.calls[1].context.messages.at(-1);
    assert.deepEqual(fresh.content.find(block => block.type === 'image'), image);
    assert.match(JSON.stringify(fresh), /v2:death-1/);
    assert.match(JSON.stringify(fresh), /version-change/);
    assert.equal(f.events.filter(event => event.type === 'feedback_injected').length, 1);
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 0);
  } finally { await agent.close(); }
});

test('existing tool rounds refresh state and images under the same semantic key without extending the turn', async () => {
  let tick = 0;
  const phases = [];
  const image = tick => ({ type: 'image', mimeType: 'image/png', data: `frame-${tick}` });
  const f = await fixture([
    call('observe', {}), call('observe', {}), answer('Current state reviewed.'),
  ], [{
    name: 'observe', description: 'Observe current controller state.', parameters: { type: 'object', properties: {} },
    execute: async () => ({ tick: ++tick, marker: `tool-state-${tick}` }),
  }], 131072, ({ phase }) => {
    phases.push(phase);
    return {
      key: 'v1:active-analysis', needsEngineering: true, baseVersion: 'v1', reasons: ['stagnation'],
      observation: { tick, marker: `fresh-state-${tick}`, action: { state: 'running' } }, images: [image(tick)],
    };
  });
  const agent = await f.open();
  try {
    const result = await agent.step({}, { feedbackKey: 'v1:active-analysis' });
    assert.equal(result.modelCalls, 3);
    assert.equal(result.toolCalls, 2);
    assert.equal(result.feedbackKey, 'v1:active-analysis');
    for (let round = 0; round < 3; round++) {
      const latest = f.calls[round].context.messages.at(-1);
      assert.deepEqual(latest.content.find(block => block.type === 'image'), image(round));
      const input = JSON.parse(latest.content.find(block => block.type === 'text').text);
      assert.equal(input.observation.tick, round);
      assert.equal(input.observation.marker, `fresh-state-${round}`);
      assert.equal(input.feedback.key, 'v1:active-analysis');
      if (round) assert.match(JSON.stringify(f.calls[round].context), new RegExp(`tool-state-${round}`));
      assert.doesNotMatch(JSON.stringify(f.calls[round].context), new RegExp(`fresh-state-${round - 1}`));
    }
    assert.deepEqual(phases, ['beforeRequest', 'beforeRequest', 'beforeRequest', 'onYield']);
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 0);
  } finally { await agent.close(); }
});

test('request-only feedback is not reused after the callback stops supplying a fresh snapshot', async () => {
  let observed = false;
  const f = await fixture([call('observe', {}), answer('Reviewed the latest tool result.')], [{
    name: 'observe', description: 'Inspect current state.', parameters: { type: 'object', properties: {} },
    execute: async () => { observed = true; return { marker: 'newer-tool-state' }; },
  }], 131072, () => observed ? null : {
    key: 'v1:error', needsEngineering: true, baseVersion: 'v1', reasons: ['error'], observation: { marker: 'obsolete-snapshot' },
  });
  const agent = await f.open();
  try {
    const result = await agent.step({});
    assert.equal(result.modelCalls, 2);
    assert.match(JSON.stringify(f.calls[0].context), /obsolete-snapshot/);
    assert.match(JSON.stringify(f.calls[1].context), /newer-tool-state/);
    assert.doesNotMatch(JSON.stringify(f.calls[1].context), /obsolete-snapshot/);
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 0);
  } finally { await agent.close(); }
});

test('a stale candidate is rejected, refreshed and repaired against the current base without stopping local play', async () => {
  let feedback = null;
  const admissions = [];
  const candidateSchema = {
    type: 'object', properties: { code: { type: 'string' }, baseVersion: { type: 'string' } },
    required: ['code', 'baseVersion'], additionalProperties: false,
  };
  const f = await fixture([
    call('controller_candidate', { code: 'old source improvement', baseVersion: 'v1' }),
    call('controller_candidate', { code: 'fresh source improvement', baseVersion: 'v2' }),
    answer('Follow-up inspection.'),
  ], [{
    name: 'controller_candidate', description: 'Stage an improvement against its source version.', parameters: candidateSchema,
    execute: async args => {
      admissions.push(args.baseVersion);
      feedback = {
        key: 'active:v2', needsEngineering: true, baseVersion: 'v2', reasons: ['version-change'],
        observation: { controller: { version: 'v2' }, action: { state: 'running' } },
      };
      if (args.baseVersion !== 'v2') return {
        isError: true, output: [{ type: 'text', text: 'Stale candidate baseVersion: v1; current version: v2. Inspect and repair.' }],
      };
      return { staged: 'v3', baseVersion: 'v2' };
    },
  }], 131072, () => feedback);
  const agent = await f.open();
  try {
    const result = await agent.step({ controller: { version: 'v1' } });
    assert.deepEqual(admissions, ['v1', 'v2']);
    assert.equal(result.modelCalls, 2, 'accepted candidate ends the turn without narration');
    assert.equal(result.toolCalls, 2);
    assert.equal(result.feedbackKey, 'active:v2');
    assert.match(JSON.stringify(f.calls[1].context), /Stale candidate baseVersion/);
    assert.match(JSON.stringify(f.calls[1].context.messages.at(-1)), /active:v2/);
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 0);
    await agent.step({}, { feedbackKey: result.feedbackKey });
    assert.doesNotMatch(JSON.stringify(f.calls[2].context), /staged/);
  } finally { await agent.close(); }
});

test('unchanged relevant feedback refreshes existing requests without producing a yield loop', async () => {
  const feedback = {
    key: 'v1:same-failure', needsEngineering: true, baseVersion: 'v1', reasons: ['error'],
    observation: { action: { state: 'running' } },
  };
  const f = await fixture([answer('Initial assessment.'), answer('No new change.')], [], 131072, () => feedback);
  const agent = await f.open();
  try {
    const first = await agent.step({});
    assert.equal(first.modelCalls, 1);
    const second = await agent.step({}, { feedbackKey: first.feedbackKey });
    assert.equal(second.modelCalls, 1);
    assert.equal(second.feedbackKey, first.feedbackKey);
    assert.equal(f.events.filter(event => event.type === 'feedback_injected').length, 2);
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 0);
  } finally { await agent.close(); }
});

for (const [name, feedback] of [
  ['absent', null],
  ['ordinary movement', { key: 'moving', needsEngineering: false, observation: { action: { state: 'running' } } }],
  ['unchanged key', { key: 'already-observed', needsEngineering: true, baseVersion: 'v1', reasons: ['stagnation'], observation: { action: null } }],
]) {
  test(`engineer yield finishes normally when feedback is ${name}`, async () => {
    const f = await fixture([answer('Finished thinking.')], [], 131072, () => feedback);
    const agent = await f.open();
    try {
      const image = { type: 'image', mimeType: 'image/png', data: 'initial-evidence-frame' };
      assert.equal((await agent.step({ marker: 'initial-observation-evidence' }, { feedbackKey: 'already-observed', images: [image] })).modelCalls, 1);
      const transcript = JSON.stringify(f.calls[0].context);
      if (name !== 'unchanged key') {
        assert.equal(transcript.split('initial-observation-evidence').length - 1, 1);
        assert.equal(transcript.split('initial-evidence-frame').length - 1, 1);
      } else assert.doesNotMatch(transcript, /initial-observation-evidence|initial-evidence-frame/);
      assert.equal(f.events.filter(event => event.type === 'feedback_injected').length, name === 'unchanged key' ? 1 : 0);
      assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 0);
    } finally { await agent.close(); }
  });
}

test('fresh engineering feedback may continue past eight rounds until evidence settles', async () => {
  let key = 0;
  const f = await fixture(Array.from({ length: 20 }, () => answer('Still assessing.')), [], 131072, () => key >= 20 ? null : ({
    key: `new-state-${++key}`, needsEngineering: true, baseVersion: 'v1', reasons: ['error'],
    observation: { action: { state: 'running' }, reflexOwner: 'defending' },
  }));
  const agent = await f.open();
  try {
    const result = await agent.step({});
    assert.equal(result.modelCalls, 11);
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 10);
    assert.equal(f.events.filter(event => event.type === 'model_error').length, 0);
  } finally { await agent.close(); }
});

test('existing requests receive fresh evidence after a large tool round', async () => {
  let executions = 0;
  let feedback = null;
  const f = await fixture([
    fauxAssistantMessage(Array.from({ length: 11 }, (_, i) => fauxToolCall('inspect', {}, { id: `inspect-${i}` })), { stopReason: 'toolUse' }),
    answer('Finished this bounded inspection.'),
  ], [{
    name: 'inspect', description: 'Inspect one prerequisite.', parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions++;
      feedback = {
        key: `error-${executions}`, needsEngineering: true, baseVersion: 'v1', reasons: ['error'],
        observation: { action: { state: 'running' } },
      };
      return 'observed';
    },
  }], 131072, () => feedback);
  const agent = await f.open();
  try {
    const result = await agent.step({});
    assert.equal(executions, 11);
    assert.equal(result.toolCalls, 11);
    assert.equal(result.modelCalls, 2);
    assert.match(JSON.stringify(f.calls[1].context.messages.at(-1)), /error-11/);
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 0);
  } finally { await agent.close(); }
});

test('large sensor snapshots stay within their completed episode instead of accumulating across missions', async () => {
  const f = await fixture(Array.from({ length: 9 }, () => answer('Mission assessed.')), [], 50000);
  const agent = await f.open();
  try {
    for (let step = 0; step < 8; step++) {
      await agent.step({ step, terrain: ('episode-' + step + '-terrain ').repeat(2000) });
    }
    await agent.step({ health: 20, notes: { lesson: 'verified durable lesson' } });
    const requests = f.calls.map(call => JSON.stringify(call.context));
    assert.equal(requests.some(request => /context summarization assistant|history before this point was compacted/i.test(request)), false);
    for (let step = 0; step < 8; step++) {
      assert.match(requests[step], new RegExp('episode-' + step + '-terrain'));
      if (step) assert.doesNotMatch(requests[step], new RegExp('episode-' + (step - 1) + '-terrain'));
    }
    assert.doesNotMatch(requests.at(-1), /episode-\d-terrain/);
    assert.match(requests.at(-1), /verified durable lesson/);
  } finally { await agent.close(); }
});

test('mission tool rounds share current evidence, next mission starts fresh, and all episode archives remain stored', async () => {
  const documents = defineDoc({
    kind: 'minecraft.player-conversations', version: 1, scope: 'session',
    initial: () => ({ diary: null, strategy: null, controllerMode: 'mission-v1' }),
    checkpointWhen: () => true,
  });
  let episode = 1;
  const f = await fixture([
    call('observe', {}),
    call('mission', { code: 'first purposeful skill' }),
    answer('Diary continuity marker.'),
    call('mission', { code: 'next purposeful skill' }),
    answer('Another diary paragraph.'),
  ], [
    {
      name: 'observe', description: 'Inspect the current obstacle.', parameters: { type: 'object', properties: {} },
      execute: async () => ({ obstacle: 'episode-one-obstacle-detail' }),
    },
    {
      name: 'mission', description: 'Start a finite skill.', parameters: schema,
      execute: async ({ code }) => ({ accepted: code }),
    },
  ], 131072, () => ({
    key: 'episode-' + episode, needsEngineering: true,
    observation: {
      terrain: episode === 1 ? 'episode-one-large-sensor-marker' : 'episode-two-fresh-sensor-marker',
      notes: { lesson: 'authoritative-durable-lesson' },
    },
    images: [{ type: 'image', mimeType: 'image/png', data: 'fresh-frame-' + episode }],
  }));
  let agent = await f.open();
  try {
    const result = await agent.step({ terrain: 'duplicate-step-snapshot' }, {
      images: [{ type: 'image', mimeType: 'image/png', data: 'duplicate-step-frame' }],
      feedbackKey: 'episode-1',
    });
    assert.equal(result.modelCalls, 2);
    assert.match(JSON.stringify(f.calls[1].context), /episode-one-obstacle-detail/);
    assert.match(JSON.stringify(f.calls[1].context), /episode-one-large-sensor-marker/);
    for (const call of f.calls) {
      const serialized = JSON.stringify(call.context);
      assert.doesNotMatch(serialized, /duplicate-step-snapshot|duplicate-step-frame/);
      assert.equal(serialized.split('episode-one-large-sensor-marker').length - 1, 1);
      assert.equal(serialized.split('fresh-frame-1').length - 1, 1);
    }
    await agent.narrate({ event: 'persisted diary fact' });
  } finally { await agent.close(); }

  const database = path.join(f.stateDir, 'worlds/fresh-one/agent.sqlite');
  let harness = await Harness.open(await openNodeSqliteStorage(database), { models: f.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  let firstStrategy;
  let diaryId;
  try {
    const saved = await harness.snapshot(documents, BACKGROUND_CONTEXT);
    firstStrategy = saved.strategy;
    diaryId = saved.diary;
    assert.match(JSON.stringify(await (await harness.conversation(firstStrategy, BACKGROUND_CONTEXT)).context(BACKGROUND_CONTEXT)), /episode-one-obstacle-detail/);
  } finally { await harness.close(BACKGROUND_CONTEXT); }

  episode = 2;
  agent = await f.open();
  try {
    await agent.step({ terrain: 'another-duplicate-step-snapshot' }, { feedbackKey: 'episode-2' });
    const next = JSON.stringify(f.calls.at(-1).context);
    assert.match(next, /episode-two-fresh-sensor-marker|authoritative-durable-lesson/);
    assert.doesNotMatch(next, /episode-one-large-sensor-marker|episode-one-obstacle-detail|first purposeful skill/);
    await agent.narrate({ event: 'second diary fact' });
    assert.match(JSON.stringify(f.calls.at(-1).context), /persisted diary fact/);
  } finally { await agent.close(); }

  harness = await Harness.open(await openNodeSqliteStorage(database), { models: f.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const saved = await harness.snapshot(documents, BACKGROUND_CONTEXT);
    assert.notEqual(saved.strategy, firstStrategy);
    assert.equal(saved.diary, diaryId);
    const archived = await harness.conversation(firstStrategy, BACKGROUND_CONTEXT);
    assert.match(JSON.stringify(await archived.context(BACKGROUND_CONTEXT)), /episode-one-obstacle-detail|first purposeful skill/);
    const current = await harness.conversation(saved.strategy, BACKGROUND_CONTEXT);
    assert.match(JSON.stringify(await current.context(BACKGROUND_CONTEXT)), /next purposeful skill/);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});
