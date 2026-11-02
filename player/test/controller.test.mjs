import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PersistentController, validateControllerResult } from '../controller.mjs';
import { createSandboxBroker } from '../sandbox-broker.mjs';
import { prepareSandboxRoot } from '../sandbox-install.mjs';

const canRun = process.getuid?.() === 0;
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
after(async () => { if (broker) await new Promise(resolve => broker.close(resolve)); });

const code = `export async function decide(observation, state, lastResult) {
  const count = (state.count ?? 0) + 1;
  if (!observation.hasWood) return {state:{count},action:null,reason:'Wood unavailable',wakeAfterMs:500};
  return {state:{count,last:lastResult?.state ?? null},action:{name:'Craft planks',code:'return await mc.call("craft", input.item);',input:{item:'oak_planks'}}};
}`;
const fixtures = [{ observation: { hasWood: true } }, { observation: { hasWood: false } }];
const create = worldId => new PersistentController({ directory, worldId, socketPath, timeoutMs: 3500 });

test('real sandbox validates offline, activates, persists state and scopes worlds', { skip: !canRun }, async () => {
  const controller = await create('world-one').open();
  const saved = await controller.candidate({ name: 'Useful crafting', code, fixtures });
  assert.equal(controller.current(), null);
  await assert.rejects(controller.activate(saved.version), /validated/);
  const validated = await controller.validate(saved.version);
  assert.equal(validated.status, 'validated', validated.error);
  assert.deepEqual(validated.validation.results.map(result => result.action), ['Craft planks', null]);
  await controller.activate(saved.version);
  const result = await controller.decide({ worldId: 'world-one', session: 'one', life: 0, hasWood: true }, { state: 'completed' });
  assert.equal(result.action.name, 'Craft planks');
  assert.deepEqual(result.state, { count: 1, last: 'completed' });
  const reopened = await create('world-one').open();
  assert.equal(reopened.current().version, saved.version);
  assert.equal((await reopened.decide({ worldId: 'world-one', hasWood: false })).state.count, 2);
  const update = await reopened.candidate({ name: 'Updated crafting', code, fixtures });
  assert.equal((await reopened.validate(update.version)).status, 'validated');
  await reopened.activate(update.version);
  assert.equal(reopened.inspect().state.count, 2, 'Hotpatch activation preserves persistent controller state');
  assert.equal((await reopened.decide({ worldId: 'world-one', hasWood: false })).state.count, 3);
  await reopened.resetState('death');
  assert.deepEqual(reopened.inspect().state, {});
  assert.equal((await create('world-two').open()).current(), null);
  await assert.rejects(reopened.decide({ worldId: 'world-two' }), /world mismatch/);
});

test('larger source, durable planning state and query feedback cross the real sandbox intact', { skip: !canRun }, async () => {
  const controller = await create('larger-controller-world').open();
  const route = 'route '.repeat(4000);
  const largerCode = `/*${'module knowledge '.repeat(3000)}*/\nexport async function decide(observation, state, lastResult) {
    return {state:{route:observation.route ?? state.route, query:lastResult?.value},action:null,reason:'Inspect known route'};
  }`;
  const candidate = await controller.candidate({ name: 'Larger planning controller', code: largerCode, fixtures: [
    { observation: { route } }, { observation: { route }, lastResult: { value: 'x'.repeat(80_000) } },
  ] });
  const validated = await controller.validate(candidate.version);
  assert.equal(validated.status, 'validated', validated.error);
  await controller.activate(candidate.version);
  const result = await controller.decide({ worldId: 'larger-controller-world', route }, { value: 'x'.repeat(80_000) });
  assert.equal(result.state.route, route);
  assert.equal(result.state.query.length, 80_000);
  const reopened = await create('larger-controller-world').open();
  assert.equal(reopened.inspect().state.route, route);
});

test('near-frame state cannot poison planning and rejected large feedback remains inspectable', { skip: !canRun }, async () => {
  const controller = await create('transport-recovery-world').open();
  const source = `export async function decide(observation,state,lastResult) {
    if (observation.makeLarge) return {state:{memory:'x'.repeat(1040000)},action:null,reason:'Too much state'};
    return {state:{recovered:lastResult?.errorCode ?? null},action:null,reason:'Choose a smaller query'};
  }`;
  const candidate = await controller.candidate({ name: 'Transport recovery', code: source, fixtures: [
    { observation: {} }, { observation: {}, lastResult: { state: 'failed' } },
  ] });
  assert.equal((await controller.validate(candidate.version)).status, 'validated');
  await controller.activate(candidate.version);
  const observation = { worldId: 'transport-recovery-world', nearby: 'y'.repeat(10_000) };
  await assert.rejects(controller.decide({ ...observation, makeLarge: true }), /frame limit/);
  assert.deepEqual(controller.inspect().state, {}, 'Rejected state is not persisted');
  const original = { id: 'actual-action', name: 'Broad query', state: 'completed', value: 'x'.repeat(1_040_000) };
  const decision = await controller.decide(observation, original);
  assert.equal(decision.state.recovered, 'CONTROLLER_FEEDBACK_TOO_LARGE');
  const failure = controller.inspect().feedbackFailure;
  assert.equal(failure.state, 'failed');
  assert.equal(failure.id, original.id);
  assert.deepEqual(await controller.inspectFeedback(failure.feedbackId), original);
  const reopened = await create('transport-recovery-world').open();
  assert.deepEqual(await reopened.inspectFeedback(failure.feedbackId), original);
  await reopened.decide(observation, original);
  assert.equal(reopened.inspect().feedbackFailure.feedbackId, failure.feedbackId);
  assert.equal((await readdir(path.join(path.dirname(controller.file), 'feedback'))).length, 1, 'Repeated feedback reuses one retained payload after restart');
  assert.equal((await reopened.decide(observation)).state.recovered, null, 'Subsequent local decisions continue normally');
});

test('controller accepts helpers and comments before the named exported decision', { skip: !canRun }, async () => {
  const controller = await create('helper-world').open();
  const helperCode = `// Example signature: export async function decide(observation, state, lastResult)
/* Ordinary module helpers may precede the actual export. */
const action = { name: 'Craft planks', code: 'return await mc.call("craft", input.item);', input: { item: 'oak_planks' } };
const hasWood = observation => observation.hasWood;
export async function decide(observation, state, lastResult) {
  return hasWood(observation)
    ? {state:{count:(state.count ?? 0) + 1},action}
    : {state:{},action:null,reason:'Wood unavailable'};
}`;
  const candidate = await controller.candidate({ name: 'Module helpers', code: helperCode, fixtures });
  const validated = await controller.validate(candidate.version);
  assert.equal(validated.status, 'validated', validated.error);
  await controller.activate(candidate.version);
  const result = await controller.decide({ worldId: 'helper-world', hasWood: true });
  assert.equal(result.action.name, 'Craft planks');
  assert.equal(result.state.count, 1);
  for (const prefix of [
    '// export async function decide() {}',
    'const example = "export async function decide() {}";',
  ]) {
    const hidden = await controller.candidate({ name: 'Not exported', code: `${prefix}\nasync function decide() {return {state:{},action:null,reason:'hidden'};}`, fixtures });
    assert.equal((await controller.validate(hidden.version)).status, 'failed', 'A signature in a comment/string is not an exported entrypoint');
  }
});

test('real fixture validation rejects imports, game access, invalid action syntax and missing state', { skip: !canRun }, async () => {
  const controller = await create('invalid-world').open();
  for (const body of [
    'await import("node:fs"); return {state:{},action:null,reason:"x"};',
    'await mc.call("dig"); return {state:{},action:null,reason:"x"};',
    'return {state:{},action:{name:"Broken",code:"await (",input:{}}};',
    'return {state:{},action:{name:"Strict syntax",code:"with ({}) {}",input:{}}};',
    'return {action:null,reason:"missing"};',
    'return {state:{},action:null};',
    'return {state:{},action:{name:"Read host",code:"return 1"},escaped:process.env};',
  ]) {
    const saved = await controller.candidate({ name: 'Bad candidate', code: `export async function decide() {${body}}`, fixtures });
    const validation = await controller.validate(saved.version);
    assert.equal(validation.status, 'failed', body);
    assert.ok(validation.error);
    await assert.rejects(controller.activate(saved.version), /validated/);
  }
});

test('real controller timeout drains its sandbox and permits a subsequent decision', { skip: !canRun }, async () => {
  const controller = await create('timeout-world').open();
  const bad = await controller.candidate({ name: 'Infinite', code: 'export async function decide() { while(true) {} }', fixtures });
  assert.equal((await controller.validate(bad.version)).status, 'failed');
  const good = await controller.candidate({ name: 'Recovered', code, fixtures });
  assert.equal((await controller.validate(good.version)).status, 'validated');
});

test('controller operations reject action overlap, but candidate storage remains available', { skip: !canRun }, async () => {
  let active = true;
  const controller = await new PersistentController({ directory, worldId: 'boundary-world', socketPath, isActionActive: () => active }).open();
  const saved = await controller.candidate({ name: 'Deferred', code, fixtures });
  await assert.rejects(controller.validate(saved.version), /boundary/);
  active = false;
  assert.equal((await controller.validate(saved.version)).status, 'validated');
  active = true;
  await assert.rejects(controller.activate(saved.version), /boundary/);
});

test('activation and reset hold the boundary lock until durable save completes', { skip: !canRun }, async () => {
  const controller = await create('lock-world').open();
  const saved = await controller.candidate({ name: 'Locked activation', code, fixtures });
  assert.equal((await controller.validate(saved.version)).status, 'validated');
  const originalSave = controller.save.bind(controller);
  let release;
  controller.save = async () => {
    await new Promise(resolve => { release = resolve; });
    await originalSave();
  };
  for (const operation of [() => controller.activate(saved.version), () => controller.resetState('death')]) {
    const pending = operation();
    assert.equal(controller.inspect().busy, true);
    await assert.rejects(controller.decide({ worldId: 'lock-world' }), /boundary/);
    await assert.rejects(controller.resetState('concurrent reset'), /boundary/);
    release();
    await pending;
    assert.equal(controller.inspect().busy, false);
  }
});

test('fixture collection budget is independent from each decision input budget', { skip: !canRun }, async () => {
  const controller = await create('fixture-budget-world').open();
  const snapshots = Array.from({ length: 4 }, () => ({
    observation: { hasWood: false, snapshot: 'x'.repeat(7000) },
    state: { retained: 'x'.repeat(7000) },
  }));
  const candidate = await controller.candidate({ name: 'Live snapshots', code, fixtures: snapshots });
  assert.equal((await controller.validate(candidate.version)).status, 'validated');
  await assert.rejects(controller.candidate({ name: 'Too much stored input', code, fixtures: [
    { observation: { snapshot: 'x'.repeat(700_000) } },
    { observation: { snapshot: 'x'.repeat(700_000) } },
  ] }), /Controller fixtures.*1048576/);
  const oversized = await controller.candidate({ name: 'Oversized individual input', code, fixtures: [
    { observation: { snapshot: 'x'.repeat(9000) }, state: { retained: 'x'.repeat(7000) }, lastResult: { text: 'x'.repeat(1000) } },
    fixtures[0],
  ] });
  assert.equal((await controller.validate(oversized.version)).status, 'validated');
});

test('inspect exposes persisted decision metadata and errors without mutable references', { skip: !canRun }, async () => {
  const controller = await create('inspect-world').open();
  const candidate = await controller.candidate({ name: 'Inspectable', code, fixtures });
  await controller.validate(candidate.version);
  await controller.activate(candidate.version);
  await controller.decide({ worldId: 'inspect-world', session: 'session-one', life: 2, hasWood: false });
  const inspection = controller.inspect();
  assert.equal(inspection.error, null);
  assert.equal(inspection.lastDecision.session, 'session-one');
  assert.equal(inspection.lastDecision.life, 2);
  inspection.lastDecision.session = 'mutated';
  assert.equal(controller.inspect().lastDecision.session, 'session-one');
  await assert.rejects(controller.decide({ worldId: 'inspect-world', snapshot: 'x'.repeat(1_048_576) }), /frame limit/);
  const reopened = await create('inspect-world').open();
  assert.match(reopened.inspect().error, /frame limit/);
  assert.equal(reopened.inspect().lastDecision.session, 'session-one');
  await reopened.decide({ worldId: 'inspect-world', session: 'recovered', life: 2, hasWood: false });
  assert.equal(reopened.inspect().error, null);
});

test('invalidated decisions restore controller state and metadata after run or save delays', { skip: !canRun }, async () => {
  for (const delay of ['run', 'run-error', 'save']) {
    const worldId = `invalidated-${delay}`;
    const controller = await create(worldId).open();
    const candidate = await controller.candidate({ name: 'Interruptible', code, fixtures });
    await controller.validate(candidate.version);
    await controller.activate(candidate.version);
    await controller.decide({ worldId, session: 'original', life: 0, hasWood: false });
    await assert.rejects(controller.decide({ worldId, snapshot: 'x'.repeat(1_048_576) }), /frame limit/);
    const previous = controller.inspect();
    let current = true;
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const originalSave = controller.save.bind(controller);
    if (delay.startsWith('run')) {
      controller.run = async () => {
        entered();
        await gate;
        if (delay === 'run-error') throw new Error('Interrupted sandbox failure');
        return { state: { phase: 'stale' }, action: null, reason: 'stale' };
      };
    } else {
      let first = true;
      controller.save = async () => {
        await originalSave();
        if (first) {
          first = false;
          entered();
          await gate;
        }
      };
    }
    const pending = controller.decide({ worldId, session: 'stale', life: 0, hasWood: false }, null, { isCurrent: () => current });
    await waiting;
    current = false;
    assert.equal(controller.inspect().busy, true);
    await assert.rejects(controller.resetState('overlap'), /boundary/);
    const staged = await controller.candidate({ name: 'Concurrent candidate', code, fixtures });
    release();
    assert.deepEqual(await pending, { discarded: true });
    assert.equal(controller.inspect().busy, false);
    const persisted = (await create(worldId).open()).inspect();
    assert.deepEqual(persisted.state, previous.state);
    assert.deepEqual(persisted.lastDecision, previous.lastDecision);
    assert.equal(persisted.error, previous.error);
    assert.ok(persisted.versions.some(version => version.version === staged.version), 'Rollback preserves concurrently staged candidates');
  }
});

test('candidate provenance persists and obsolete same-base patches cannot overwrite a newer controller', { skip: !canRun }, async () => {
  const controller = await create('provenance-world').open();
  const initial = await controller.candidate({ name: 'Bootstrap', code, fixtures, baseVersion: null });
  assert.equal(initial.baseVersion, null);
  await controller.validate(initial.version);
  await controller.activate(initial.version);
  await controller.decide({ worldId: 'provenance-world', hasWood: false });
  await assert.rejects(controller.candidate({ name: 'Stale bootstrap', code, fixtures, baseVersion: null }), { code: 'CONTROLLER_STALE_VERSION' });
  const analysis = { reasonIds: ['navigation-failed'], analysisId: 'analysis-one' };
  const first = await controller.candidate({ name: 'First patch', code, fixtures, baseVersion: initial.version, analysis });
  const second = await controller.candidate({ name: 'Concurrent patch', code, fixtures, baseVersion: initial.version });
  analysis.reasonIds.push('outside mutation');
  await controller.validate(first.version);
  await controller.validate(second.version);
  await controller.activate(first.version);
  await assert.rejects(controller.activate(second.version), { code: 'CONTROLLER_STALE_VERSION' });
  assert.equal(controller.current().version, first.version);
  assert.equal(controller.inspect().state.count, 1);
  assert.equal(controller.inspect(second.version).status, 'superseded');
  const reopened = await create('provenance-world').open();
  assert.equal(reopened.inspect(first.version).baseVersion, initial.version);
  assert.deepEqual(reopened.inspect(first.version).analysis, { reasonIds: ['navigation-failed'], analysisId: 'analysis-one' });
  assert.equal(reopened.inspect(second.version).errorCode, 'CONTROLLER_STALE_VERSION');
  await assert.rejects(reopened.candidate({ name: 'Stale previous base', code, fixtures, baseVersion: initial.version }), { code: 'CONTROLLER_STALE_VERSION' });
});

test('restart rejects pending legacy provenance without altering the legacy active version', { skip: !canRun }, async () => {
  const controller = await create('legacy-provenance-world').open();
  const active = await controller.candidate({ name: 'Active', code, fixtures });
  await controller.validate(active.version);
  await controller.activate(active.version);
  const pending = await controller.candidate({ name: 'Pending legacy', code, fixtures });
  await controller.validate(pending.version);
  const data = JSON.parse(await readFile(controller.file, 'utf8'));
  for (const version of data.versions) delete version.baseVersion;
  await writeFile(controller.file, JSON.stringify(data));
  const reopened = await create('legacy-provenance-world').open();
  assert.equal(reopened.current().version, active.version);
  assert.equal(reopened.current().status, 'active');
  assert.equal(reopened.inspect(pending.version).status, 'superseded');
  assert.match(reopened.inspect(pending.version).error, /no recorded base/);
  await assert.rejects(reopened.activate(pending.version), { code: 'CONTROLLER_STALE_VERSION' });
  await assert.rejects(reopened.validate(pending.version), { code: 'CONTROLLER_STALE_VERSION' });
});

test('decision output rejects unbounded state and non-explicit idle', () => {
  assert.equal(validateControllerResult({ state: { text: 'x'.repeat(9000) }, action: null, reason: 'x' }, 'world').state.text.length, 9000);
  assert.throws(() => validateControllerResult({ state: { text: 'x'.repeat(1_048_576) }, action: null, reason: 'x' }, 'world'), /1048576/);
  assert.throws(() => validateControllerResult({ state: {} }, 'world'), /explicit null/);
  assert.throws(() => validateControllerResult({ state: {}, action: null, reason: 'x', wakeAfterMs: 0 }, 'world'), /100–60000/);
});
