import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openPlayerAgent, playerModels, PLAYER_INSTRUCTIONS } from '../agent.mjs';

const answer = text => fauxAssistantMessage(text);
const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const schema = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false };

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
    assert.match(JSON.stringify(f.calls[2].context), /candidate-1/);
    assert.match(JSON.stringify(f.calls[2].context), /candidate-2/);
    assert.match(JSON.stringify(f.calls[2].context), /pending_validation/);
  } finally { await agent.close(); }
});

test('mixed remember and candidate rounds skip narration in either order, but failed admission permits correction', async () => {
  const mixed = order => fauxAssistantMessage(order.map(name => fauxToolCall(name, { code: name })), { stopReason: 'toolUse' });
  const executed = [];
  let failAdmission = false;
  const f = await fixture([
    mixed(['remember', 'controller_candidate']), mixed(['controller_candidate', 'remember']),
    mixed(['remember', 'controller_candidate']), answer('Correct the failed candidate.'),
    mixed(['controller_candidate', 'remember']), answer('Correct the failed candidate again.'),
  ], ['remember', 'controller_candidate'].map(name => ({
    name, description: 'A controller engineering tool.', parameters: schema,
    execute: async () => {
      executed.push(name);
      if (name === 'controller_candidate' && failAdmission) throw new Error('Controller state changed');
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
    assert.deepEqual(executed, ['remember', 'controller_candidate', 'controller_candidate', 'remember']);
    failAdmission = true;
    assert.equal((await agent.step({})).modelCalls, 2);
    assert.match(JSON.stringify(f.calls[3].context), /Controller state changed/);
    assert.equal((await agent.step({})).modelCalls, 2);
    assert.match(JSON.stringify(f.calls[5].context), /Controller state changed/);
    assert.deepEqual(executed.slice(4), ['remember', 'controller_candidate', 'controller_candidate', 'remember']);
  } finally { await agent.close(); }
});

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
      assert.match(JSON.stringify(f.calls[2].context), /corrected-candidate/);
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
  const harness = await Harness.open(await openNodeSqliteStorage(database), { models: f.models, registry: createRegistry() }, context);
  const root = await harness.root(context);
  await root.configure({
    model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' },
    instructions: controllerMode ? PLAYER_INSTRUCTIONS : 'Old turn-based player instructions.',
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
  await root.submit({ type: 'input', content: 'checkpointed-controller-turn-marker' }, context);
  return { harness, root, diary, documents, knowledge, database };
}

for (const controllerMode of [undefined, 'persistent-v1']) {
  test(`${controllerMode ? 'current controller restart resumes' : 'legacy architecture migration retires'} a checkpointed generation without losing history or documents`, async () => {
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
    ]);
    const seeded = await seedCheckpointedTurn(f, controllerMode);
    await entered.promise;
    await seeded.harness.close(BACKGROUND_CONTEXT);
    const inspectHarness = await Harness.open(await openNodeSqliteStorage(seeded.database), { models: f.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    const checkpoint = await inspectHarness.inspect(BACKGROUND_CONTEXT);
    assert.ok(checkpoint.tasks.some(({ state }) => state.kind !== 'terminal'), 'a real unfinished generation was persisted');
    await inspectHarness.close(BACKGROUND_CONTEXT);

    let agent = await f.open();
    try {
      const expectedMigrations = controllerMode ? [] : ['migration_started', 'migration_completed'];
      assert.deepEqual(f.events.filter(event => event.type.startsWith('migration_')).map(event => event.type), expectedMigrations);
      const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S8sAAAAASUVORK5CYII=' };
      await agent.step({ controller: 'fresh-controller-observation-marker' }, { images: [image] });
      const fresh = f.calls.at(-1).context;
      assert.match(JSON.stringify(fresh), /background Minecraft controller engineer/);
      assert.match(JSON.stringify(fresh), /preserved-root-landmark-marker/);
      assert.match(JSON.stringify(fresh), /Preserved root survival lesson/);
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
      assert.match(JSON.stringify(f.calls.at(-1).context), /fresh-controller-observation-marker/);
    } finally { await agent.close(); }

    const verifiedStorage = await openNodeSqliteStorage(seeded.database);
    const verified = await Harness.open(verifiedStorage, { models: f.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      assert.equal((await verified.root(BACKGROUND_CONTEXT)).id, seeded.root.id);
      assert.deepEqual(await verified.snapshot(seeded.documents, BACKGROUND_CONTEXT), {
        diary: seeded.diary.id, controllerMode: 'persistent-v1',
      });
      assert.deepEqual(await verified.snapshot(seeded.knowledge, BACKGROUND_CONTEXT), {
        skills: ['preserved-shelter-skill'], home: { x: 12, y: 64, z: 34 },
      });
      const tasks = await verifiedStorage.scanTasks({ status: 'terminal' }, 100, undefined, BACKGROUND_CONTEXT);
      const checkpointIds = new Set(checkpoint.tasks.map(({ record }) => record.id));
      assert.ok(tasks.items.some(record => checkpointIds.has(record.id) &&
        record.state.outcome.status === (controllerMode ? 'completed' : 'aborted')),
      'the checkpointed generation reaches the appropriate terminal outcome');
    } finally { await verified.close(BACKGROUND_CONTEXT); }
  });
}

test('conversation survives reopen, and another world cannot inherit observations or prior answers', async () => {
  const f = await fixture([answer('I remember the old oak tree.'), answer('Continue here.'), answer('A fresh start.')]);
  let agent = await f.open();
  try {
    await agent.step({ landmark: 'unique-oak-coordinate-marker' });
    await agent.close();
    agent = await f.open();
    await agent.step({ health: 19 });
    assert.match(JSON.stringify(f.calls[1].context), /unique-oak-coordinate-marker/);
    assert.match(JSON.stringify(f.calls[1].context), /I remember the old oak tree/);
    await agent.close();
    agent = await f.open('fresh-two');
    await agent.step({ health: 20 });
    assert.doesNotMatch(JSON.stringify(f.calls[2].context), /unique-oak-coordinate-marker|I remember the old oak tree/);
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
    assert.match(JSON.stringify(f.calls[2].context), /player-only-marker/);
    assert.doesNotMatch(JSON.stringify(f.calls[2].context), /diary-only-marker/);
    await agent.close();
    agent = await f.open();
    await agent.narrate({ events: ['a new factual event'] });
    assert.match(JSON.stringify(f.calls[3].context), /diary-only-marker/);
    assert.doesNotMatch(JSON.stringify(f.calls[3].context), /player-only-marker/);
  } finally { await agent.close(); }
});

test('bounded model runs stop a polling storm and a subsequent fresh observation can recover', async () => {
  let polls = 0;
  const f = await fixture([
    ...Array.from({ length: 8 }, () => call('action_status', {})), answer('Fresh observation received.'),
  ], [{
    name: 'action_status', description: 'Inspect current action once.', parameters: { type: 'object', properties: {} },
    replay: 'safe', execute: async () => { polls++; return { status: 'running' }; },
  }]);
  const agent = await f.open();
  try {
    await assert.rejects(agent.step({ status: 'running' }), /model run failed/);
    assert.equal(f.calls.length, 8);
    assert.equal(polls, 8);
    const next = await agent.step({ status: 'completed' });
    assert.equal(next.text, 'Fresh observation received.');
    assert.equal(next.modelCalls, 1);
  } finally { await agent.close(); }
});

test('oversized tool rounds never execute, and tool-returned errors remain genuine model-visible results', async () => {
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
    await assert.rejects(agent.step({}), /model run failed/);
    assert.equal(executions, 0);
    const result = await agent.step({});
    assert.equal(executions, 1);
    assert.match(JSON.stringify(f.calls[2].context), /Target is not reachable/);
    assert.equal(result.text, 'I need a different approach.');
  } finally { await agent.close(); }
});

test('unsafe world identifiers are rejected before storage opens', async () => {
  await assert.rejects(openPlayerAgent({ stateDir: '/tmp', worldId: '../old-world', tools: [] }), /worldId/);
});

test('player uses canonical broker models with Sol8192 and Terra2048 without fetching credentials at startup', async () => {
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
    assert.equal(models.getModel('openai-codex', 'gpt-6.1-sol').maxTokens, 8192);
    assert.equal(models.getModel('openai-codex', 'gpt-6.1-terra').maxTokens, 2048);
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

test('completion during model thinking continues the same native step with persisted fresh facts and real images', async () => {
  const waiting = deferred();
  const release = deferred();
  let feedback = null;
  let starts = 0;
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S8sAAAAASUVORK5CYII=' };
  const f = await fixture([
    call('begin_skill', { code: 'first useful local program' }),
    async () => { waiting.resolve(); await release.promise; return answer('The first program is still running.'); },
    call('begin_skill', { code: 'next useful local program' }),
    answer('The next program is working.'),
    answer('I remember the actual completion.'),
  ], [{
    name: 'begin_skill', description: 'Start useful asynchronous work without ending the turn.', parameters: schema,
    execute: async () => {
      const id = `action-${++starts}`;
      feedback = { key: `${id}:running`, needsAction: false, observation: { action: { id, state: 'running' }, reflexOwner: null } };
      return { actionId: id };
    },
  }], 131072, () => feedback);
  let agent = await f.open();
  try {
    const pending = agent.step({ action: null, life: 0 });
    await waiting.promise;
    feedback = {
      key: 'action-1:completed', needsAction: true,
      observation: { action: { id: 'action-1', state: 'completed' }, notes: { outcome: 'server-confirmed-completion-marker' }, reflexOwner: null },
      images: [image],
    };
    release.resolve();
    const result = await pending;
    assert.equal(starts, 2);
    assert.equal(result.modelCalls, 4);
    assert.equal(result.text, 'The next program is working.');
    const continuation = f.calls[2].context.messages.filter(message => message.role === 'user').at(-1);
    assert.deepEqual(continuation.content.find(block => block.type === 'image'), image);
    const input = JSON.parse(continuation.content.find(block => block.type === 'text').text);
    assert.equal(input.observation.action.state, 'completed');
    assert.equal(input.observation.notes.outcome, 'server-confirmed-completion-marker');
    assert.equal(input.feedback.key, 'action-1:completed');
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 1);
    await agent.close();
    agent = await f.open();
    await agent.step({ action: { id: 'action-2', state: 'running' } });
    assert.match(JSON.stringify(f.calls[4].context), /server-confirmed-completion-marker/);
  } finally { release.resolve(); await agent.close(); }
});

test('unchanged idle feedback is injected once per step, not an unbounded yield loop', async () => {
  const feedback = { key: 'same-completed-action', needsAction: true, observation: { action: { state: 'completed' }, reflexOwner: null } };
  const f = await fixture([
    answer('Initial answer.'), answer('No productive next action found.'),
    answer('Another initial answer.'), answer('No new change.'),
  ], [], 131072, () => feedback);
  const agent = await f.open();
  try {
    assert.equal((await agent.step({})).modelCalls, 2);
    assert.equal((await agent.step({})).modelCalls, 2);
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 2);
  } finally { await agent.close(); }
});

for (const [name, feedback] of [
  ['absent', null],
  ['not needed', { key: 'idle', needsAction: false, observation: { action: null } }],
  ['running authored action', { key: 'running', needsAction: true, observation: { action: { state: 'running' } } }],
  ['emergency reflex owner', { key: 'emergency', needsAction: true, observation: { action: null, reflexOwner: 'defending' } }],
]) {
  test(`yield finishes normally when feedback is ${name}`, async () => {
    const f = await fixture([answer('Finished thinking.')], [], 131072, () => feedback);
    const agent = await f.open();
    try {
      assert.equal((await agent.step({})).modelCalls, 1);
      assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 0);
    } finally { await agent.close(); }
  });
}

test('changing idle feedback stops continuing before the native model budget is exhausted', async () => {
  let key = 0;
  const f = await fixture(Array.from({ length: 7 }, () => answer('Still choosing.')), [], 131072, () => ({
    key: `new-state-${++key}`, needsAction: true, observation: { action: null, reflexOwner: null },
  }));
  const agent = await f.open();
  try {
    const result = await agent.step({});
    assert.equal(result.modelCalls, 7);
    assert.equal(f.events.filter(event => event.type === 'feedback_continue').length, 6);
    assert.equal(f.events.filter(event => event.type === 'model_error').length, 0);
  } finally { await agent.close(); }
});

test('feedback continuation preserves tool budget headroom instead of requesting another tool round', async () => {
  let executions = 0;
  let feedbackReads = 0;
  const f = await fixture([
    fauxAssistantMessage(Array.from({ length: 11 }, (_, i) => fauxToolCall('inspect', {}, { id: `inspect-${i}` })), { stopReason: 'toolUse' }),
    answer('Finished this bounded inspection.'),
  ], [{
    name: 'inspect', description: 'Inspect one prerequisite.', parameters: { type: 'object', properties: {} },
    execute: async () => { executions++; return 'observed'; },
  }], 131072, () => {
    feedbackReads++;
    return { key: 'completed', needsAction: true, observation: { action: null, reflexOwner: null } };
  });
  const agent = await f.open();
  try {
    const result = await agent.step({});
    assert.equal(executions, 11);
    assert.equal(result.toolCalls, 11);
    assert.equal(result.modelCalls, 2);
    assert.equal(feedbackReads, 0);
  } finally { await agent.close(); }
});

test('large-window player history compacts at a tactical working set instead of growing to the provider maximum', async () => {
  const f = await fixture(Array.from({ length: 20 }, () => answer('Persistent tactical summary: keep the tools and known home.')), [], 262144);
  const agent = await f.open();
  try {
    for (let step = 0; step < 8; step++) {
      await agent.step({ step, terrain: 'historical-block-data '.repeat(2000) });
    }
    await agent.step({ health: 20, inventory: ['pickaxe'] });
    const requests = f.calls.map(call => JSON.stringify(call.context));
    assert.ok(requests.some(request => /summari|compact/i.test(request)));
    assert.ok(requests.some((request, index) => index > 0 && request.length < requests[index - 1].length / 2), 'old block telemetry is replaced by a summary');
    assert.match(requests.at(-1), /known home/);
  } finally { await agent.close(); }
});

test('automatic compaction passes through the same bounded and sanitized model boundary', async () => {
  const secret = 'SYNTHETIC_COMPACTION_SECRET_MARKER';
  const f = await fixture(Array.from({ length: 20 }, () => context => (
    /summari|compact/i.test(JSON.stringify(context))
      ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: secret })
      : answer('I will remember the useful surroundings.')
  )), [], 50000);
  const agent = await f.open();
  try {
    // Multiple completed turns give compaction older entries to summarize;
    // a single oversized recent message is retained rather than compacted.
    await assert.rejects(async () => {
      for (let step = 0; step < 8; step++) {
        await agent.step({ step, terrain: 'historical-block-data '.repeat(2000) });
      }
    }, /model run failed/);
  } finally { await agent.close(); }
  assert.ok(f.calls.length > 1);
  assert.equal(f.events.filter(event => event.type === 'model_start').length, f.calls.length);
  assert.equal(f.events.filter(event => event.type === 'model_error' && event.category === 'provider_request_failed').length, 1);
  assert.match(JSON.stringify(f.calls.at(-1).context), /summari|compact/i);
  const database = await readFile(path.join(f.stateDir, 'worlds/fresh-one/agent.sqlite'));
  assert.equal(database.includes(Buffer.from(secret)), false);
});
