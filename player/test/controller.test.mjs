import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod } from 'node:fs/promises';
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
    { observation: { snapshot: 'x'.repeat(70_000) } },
    { observation: { snapshot: 'x'.repeat(70_000) } },
  ] }), /Controller fixtures.*131072/);
  const oversized = await controller.candidate({ name: 'Oversized individual input', code, fixtures: [
    { observation: { snapshot: 'x'.repeat(9000) }, state: { retained: 'x'.repeat(7000) }, lastResult: { text: 'x'.repeat(1000) } },
    fixtures[0],
  ] });
  const rejected = await controller.validate(oversized.version);
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error, /Decision input.*16384/);
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
  await assert.rejects(controller.decide({ worldId: 'inspect-world', snapshot: 'x'.repeat(17_000) }), /Decision input/);
  const reopened = await create('inspect-world').open();
  assert.match(reopened.inspect().error, /Decision input/);
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
    await assert.rejects(controller.decide({ worldId, snapshot: 'x'.repeat(17_000) }), /Decision input/);
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

test('decision output rejects unbounded state and non-explicit idle', () => {
  assert.throws(() => validateControllerResult({ state: { text: 'x'.repeat(9000) }, action: null, reason: 'x' }, 'world'), /8192/);
  assert.throws(() => validateControllerResult({ state: {} }, 'world'), /explicit null/);
  assert.throws(() => validateControllerResult({ state: {}, action: null, reason: 'x', wakeAfterMs: 0 }, 'world'), /100–60000/);
});
