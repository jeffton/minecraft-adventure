import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PersistentController, validateControllerResult } from '../controller.mjs';
import { createSandboxBroker } from '../sandbox-broker.mjs';
import { prepareSandboxRoot } from '../sandbox-install.mjs';

const canRun = process.getuid?.() === 0;
const isolated = { skip: !canRun };
let directory;
let socketPath;
let broker;
before(async () => {
  if (!canRun) return;
  directory = await mkdtemp('/var/lib/minecraft-controller-test-');
  await chmod(directory, 0o755);
  prepareSandboxRoot(path.join(directory, 'root'));
  socketPath = path.join(directory, 'broker.sock');
  broker = createSandboxBroker({ root: path.join(directory, 'root'), timeoutMs: 4000 });
  await new Promise(resolve => broker.listen(socketPath, resolve));
});
after(async () => {
  try {
    if (broker) await new Promise(resolve => broker.close(resolve));
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const code = `export async function decide(observation, state, lastResult) {
  const count = (state.count ?? 0) + 1;
  if (!observation.hasWood) return {state:{count},action:null,reason:'Wood unavailable',wakeAfterMs:500};
  return {state:{count,last:lastResult?.state ?? null},action:{name:'Craft planks',code:'return await mc.call("craft", input.item);',input:{item:'oak_planks'}}};
}`;
const create = worldId => new PersistentController({ directory, worldId, socketPath, timeoutMs: 3500 });

async function activate(controller, source = code) {
  const candidate = await controller.candidate({ name: 'Live controller', code: source });
  assert.equal(candidate.status, 'admitted');
  await controller.activate(candidate.version);
  return candidate;
}

test('source admission parses real exports/imports without executing generated code or fixtures', isolated, async () => {
  const controller = await create('admission').open();
  for (const source of [
    'export async function decide() {',
    '// export async function decide() {}\nasync function decide() {}',
    'const signature = "export async function decide() {}"; async function decide() {}',
    'export async function* decide() {}',
    'import fs from "node:fs"; export async function decide() {}',
    'export async function decide() { return await import("node:fs"); }',
  ]) await assert.rejects(controller.candidate({ name: 'Invalid entrypoint', code: source }));
  const candidate = await controller.candidate({ name: 'Runtime experiment', code: `throw new Error('real live defect');\n${code}` });
  assert.equal(candidate.status, 'admitted');
  assert.equal(controller.sandbox.actions.size, 0, 'No offline execution or fixture gate');
  await controller.activate(candidate.version);
  await assert.rejects(controller.decide({ worldId: 'admission' }), /real live defect/);
  assert.equal(controller.current().version, candidate.version, 'Runtime failure does not roll source back');
  const repair = await controller.candidate({ name: 'Remove defective initialization', baseVersion: candidate.version, edits: [{ oldText: "throw new Error('real live defect');\n", newText: '' }] });
  await controller.activate(repair.version);
  assert.equal((await controller.decide({ worldId: 'admission' })).state.count, 1);
});

test('real isolated decisions persist state and scope worlds without model approval', isolated, async () => {
  const controller = await create('world-one').open();
  const saved = await activate(controller);
  const result = await controller.decide({ worldId: 'world-one', session: 'one', life: 0, hasWood: true }, { state: 'completed' });
  assert.equal(result.action.name, 'Craft planks');
  assert.deepEqual(result.state, { count: 1, last: 'completed' });
  const reopened = await create('world-one').open();
  assert.equal(reopened.current().version, saved.version);
  assert.equal((await reopened.decide({ worldId: 'world-one', hasWood: false })).state.count, 2);
  assert.equal((await create('world-two').open()).current(), null);
  await assert.rejects(reopened.decide({ worldId: 'world-two' }), /world mismatch/);
});

test('exact edits use original source, preserve state and reject overlaps/stale provenance', isolated, async () => {
  const controller = await create('exact-edits').open();
  const initial = await activate(controller);
  await controller.decide({ worldId: 'exact-edits' });
  const edits = [{ oldText: '(state.count ?? 0) + 1', newText: '(state.count ?? 0) + 2' }, { oldText: 'Wood unavailable', newText: 'Find timber' }];
  const candidate = await controller.candidate({ name: 'Small correction', baseVersion: initial.version, edits });
  assert.equal(controller.current().version, initial.version);
  assert.deepEqual(candidate.edits, edits);
  await controller.activate(candidate.version);
  const result = await controller.decide({ worldId: 'exact-edits' });
  assert.equal(result.state.count, 3);
  assert.equal(result.reason, 'Find timber');
  await assert.rejects(controller.candidate({ name: 'Stale repair', baseVersion: initial.version, edits }), { code: 'CONTROLLER_STALE_VERSION' });
  for (const invalid of [
    [{ oldText: 'missing', newText: 'x' }],
    [{ oldText: 'state', newText: 'x' }],
    [{ oldText: '(state.count ?? 0)', newText: 'x' }, { oldText: 'state.count ?? 0', newText: 'y' }],
    [{ oldText: 'Find timber', newText: 'Find timber' }],
  ]) await assert.rejects(controller.candidate({ name: 'Invalid edit', baseVersion: candidate.version, edits: invalid }), /exactly once|overlap|must change/);
});

test('runtime contract failures stay active until an explicit edit repairs them', isolated, async () => {
  const controller = await create('live-contract').open();
  const candidate = await activate(controller, 'export async function decide(){ return {action:null,reason:"missing state"}; }');
  await assert.rejects(controller.decide({ worldId: 'live-contract' }), /state/);
  assert.equal(controller.current().version, candidate.version);
  const repair = await controller.candidate({ name: 'Return state', baseVersion: candidate.version, edits: [{ oldText: 'return {action:null', newText: 'return {state:{},action:null' }] });
  await controller.activate(repair.version);
  assert.deepEqual((await controller.decide({ worldId: 'live-contract' })).state, {});
});

test('larger source/state/query results cross the actual OS sandbox intact', isolated, async () => {
  const controller = await create('larger-source').open();
  const route = 'route '.repeat(4000);
  await activate(controller, `/*${'module knowledge '.repeat(3000)}*/\nexport async function decide(observation,state,lastResult){return {state:{route:observation.route,query:lastResult.value},action:null,reason:'Inspect route'};}`);
  const result = await controller.decide({ worldId: 'larger-source', route }, { value: 'x'.repeat(80_000) });
  assert.equal(result.state.route, route);
  assert.equal(result.state.query.length, 80_000);
  assert.equal((await create('larger-source').open()).inspect().state.route, route);
});

test('near-frame state cannot poison later decisions; oversized feedback remains retained and deduplicated', isolated, async () => {
  const controller = await create('transport-recovery').open();
  await activate(controller, `export async function decide(observation,state,lastResult){
    if(observation.makeLarge)return {state:{memory:'x'.repeat(1040000)},action:null,reason:'Too much state'};
    return {state:{recovered:lastResult?.errorCode??null},action:null,reason:'Choose smaller query'};
  }`);
  const observation = { worldId: 'transport-recovery', nearby: 'y'.repeat(10_000) };
  await assert.rejects(controller.decide({ ...observation, makeLarge: true }), /frame limit/);
  assert.deepEqual(controller.inspect().state, {});
  const original = { id: 'actual-action', name: 'Broad query', state: 'completed', value: 'x'.repeat(1_040_000) };
  assert.equal((await controller.decide(observation, original)).state.recovered, 'CONTROLLER_FEEDBACK_TOO_LARGE');
  const failure = controller.inspect().feedbackFailure;
  assert.deepEqual(await controller.inspectFeedback(failure.feedbackId), original);
  const reopened = await create('transport-recovery').open();
  await reopened.decide(observation, original);
  assert.equal(reopened.inspect().feedbackFailure.feedbackId, failure.feedbackId);
  assert.equal((await readdir(path.join(path.dirname(controller.file), 'feedback'))).length, 1);
  assert.equal((await reopened.decide(observation)).state.recovered, null);
});

test('VM watchdog terminates runaway code and a later explicit edit can continue', isolated, async () => {
  const controller = await create('watchdog').open();
  const stuck = await activate(controller, 'export async function decide(){while(true){}}');
  await assert.rejects(controller.decide({ worldId: 'watchdog' }), /timed out|deadline/);
  assert.equal(controller.current().version, stuck.version);
  await activate(controller);
  assert.equal((await controller.decide({ worldId: 'watchdog' })).state.count, 1);
});

test('activation holds the boundary until persistence completes and cannot overwrite newer provenance', isolated, async () => {
  const controller = await create('boundary').open();
  const first = await activate(controller);
  const a = await controller.candidate({ name: 'A', code });
  const b = await controller.candidate({ name: 'B', code });
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const save = controller.save.bind(controller);
  controller.save = async () => { entered(); await gate; await save(); };
  const activation = controller.activate(a.version);
  await waiting;
  await assert.rejects(controller.decide({ worldId: 'boundary' }), /boundary/);
  release();
  await activation;
  controller.save = save;
  await assert.rejects(controller.activate(b.version), { code: 'CONTROLLER_STALE_VERSION' });
  assert.equal(controller.current().version, a.version);
  assert.equal(controller.inspect(first.version).status, 'retired');
});

test('interrupted decision cannot commit planning state after its epoch expires', isolated, async () => {
  for (const delay of ['run', 'save']) {
    const controller = await create(`invalidated-${delay}`).open();
    await activate(controller);
    await controller.decide({ worldId: `invalidated-${delay}`, session: 'old' });
    const previous = controller.inspect();
    let current = true;
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { entered = resolve; });
    if (delay === 'run') controller.run = async () => { entered(); await gate; return { state: { count: 999 }, action: null, reason: 'Obsolete' }; };
    else {
      const save = controller.save.bind(controller);
      controller.save = async () => { entered(); await gate; await save(); };
    }
    const decision = controller.decide({ worldId: `invalidated-${delay}`, session: 'interrupted' }, null, { isCurrent: () => current });
    await waiting;
    current = false;
    release();
    assert.deepEqual(await decision, { discarded: true });
    assert.deepEqual(controller.inspect().state, previous.state);
    assert.deepEqual(controller.inspect().lastDecision, previous.lastDecision);
  }
});

test('restart preserves active source and supersedes obsolete fixture-gated pending records', isolated, async () => {
  const controller = await create('legacy-pending').open();
  const active = await activate(controller);
  const pending = await controller.candidate({ name: 'Old pending', code });
  const data = JSON.parse(await readFile(controller.file, 'utf8'));
  data.versions.find(record => record.version === pending.version).status = 'validated';
  await writeFile(controller.file, JSON.stringify(data));
  const reopened = await create('legacy-pending').open();
  assert.equal(reopened.current().version, active.version);
  assert.equal(reopened.inspect(pending.version).status, 'superseded');
  await assert.rejects(reopened.activate(pending.version), { code: 'CONTROLLER_STALE_VERSION' });
});

test('output transport and explicit idle contract remain enforced without arbitrary text quotas', () => {
  assert.equal(validateControllerResult({ state: { text: 'x'.repeat(9000) }, action: null, reason: 'x'.repeat(9000), wakeAfterMs: 0 }, 'world').state.text.length, 9000);
  assert.throws(() => validateControllerResult({ state: { text: 'x'.repeat(1_048_576) }, action: null, reason: 'x' }, 'world'), /1048576/);
  assert.throws(() => validateControllerResult({ state: {} }, 'world'), /explicit null/);
  assert.throws(() => validateControllerResult({ state: {}, action: null, reason: 'x', wakeAfterMs: -1 }, 'world'), /nonnegative/);
});
