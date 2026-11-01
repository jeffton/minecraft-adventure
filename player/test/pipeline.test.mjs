import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionPipeline } from '../pipeline.mjs';

function fixture() {
  const actions = new Map();
  let sequence = 0;
  const sandbox = {
    activeId: null,
    start(code, { name }) {
      assert.equal(this.activeId, null, 'only one physical action may own the player');
      const id = String(++sequence);
      actions.set(id, { id, name, state: 'running', settled: false, startedAt: new Date().toISOString() });
      this.activeId = id;
      return id;
    },
    status(id) { return structuredClone(actions.get(id)); },
  };
  const context = { session: 'session', life: 1, health: 20, stopping: false, reflexOwner: null };
  const events = [];
  const pipeline = new ActionPipeline({ sandbox, worldId: 'world', context: () => context, onEvent: (...args) => events.push(args) });
  const program = (name = 'Gather useful materials') => ({ name, code: 'return await mc.observe();', input: {}, session: 'session', life: 1 });
  const finish = (state = 'completed') => {
    const action = actions.get(sandbox.activeId);
    Object.assign(action, { state, settled: true, completedAt: new Date().toISOString() });
    sandbox.activeId = null;
    return action;
  };
  return { sandbox, actions, context, events, pipeline, program, finish };
}

test('an already-prepared continuation starts synchronously when predecessor cleanup completes', () => {
  const f = fixture();
  const first = f.pipeline.start(f.program('Mine stone'));
  f.pipeline.queue({ ...f.program('Craft stone pickaxe'), afterAction: first.actionId });
  assert.equal(f.actions.size, 1);
  f.pipeline.completed(f.finish());
  assert.equal(f.pipeline.current().name, 'Craft stone pickaxe');
  assert.equal(f.actions.size, 2);
  assert.equal(f.pipeline.next, null);
  assert.equal(f.events.find(event => event[0] === 'pipeline')[2].lateContinuation, false);
});

test('execute can install two agent-written stages atomically and hand off without another model request', () => {
  const f = fixture();
  const first = f.pipeline.start({ ...f.program('Gather wood'), next: f.program('Craft tools') });
  assert.equal(first.nextSkill, 'Craft tools');
  assert.equal(f.actions.size, 1);
  f.pipeline.completed(f.finish());
  assert.equal(f.pipeline.current().name, 'Craft tools');
  assert.equal(f.pipeline.next, null);
  assert.equal(f.events.at(-1)[2].afterAction, first.actionId);
});

test('invalid continuation is rejected before physical work starts, and failure discards an admitted pair', () => {
  const f = fixture();
  assert.throws(() => f.pipeline.start({ ...f.program(), next: { ...f.program(), name: '' } }), /Skill name/);
  assert.equal(f.actions.size, 0);
  f.pipeline.start({ ...f.program(), next: f.program('Build') });
  f.pipeline.completed(f.finish('failed'));
  assert.equal(f.actions.size, 1);
  assert.equal(f.pipeline.next, null);
});

test('a continuation arriving after successful completion starts directly without an error/replan round', () => {
  const f = fixture();
  const first = f.pipeline.start(f.program('Gather wood'));
  f.pipeline.completed(f.finish());
  const second = f.pipeline.queue({ ...f.program('Craft tools'), afterAction: first.actionId });
  assert.equal(second.started, true);
  assert.equal(second.queued, false);
  assert.equal(f.pipeline.current().name, 'Craft tools');
  assert.equal(f.events.find(event => event[0] === 'pipeline')[2].lateContinuation, true);
});

test('a predecessor that completed but is still draining keeps successor queued until settled', () => {
  const f = fixture();
  const first = f.pipeline.start(f.program());
  f.actions.get(first.actionId).state = 'completed';
  assert.equal(f.pipeline.queue({ ...f.program('Next task'), afterAction: first.actionId }).queued, true);
  assert.equal(f.actions.size, 1);
  f.pipeline.completed(f.finish());
  assert.equal(f.actions.size, 2);
});

test('failed and interrupted programs cannot launch a speculative continuation', () => {
  for (const state of ['failed', 'cancelled']) {
    const f = fixture();
    const first = f.pipeline.start(f.program());
    f.pipeline.queue({ ...f.program('Build shelter'), afterAction: first.actionId });
    f.pipeline.completed(f.finish(state));
    assert.equal(f.actions.size, 1);
    assert.equal(f.pipeline.next, null);
    assert.throws(() => f.pipeline.queue({ ...f.program(), afterAction: first.actionId }), /failed or was interrupted/);
  }
});

test('death or reflex ownership blocks a queued action even after successful predecessor completion', () => {
  for (const change of [{ life: 2 }, { reflexOwner: 'eating' }]) {
    const f = fixture();
    const first = f.pipeline.start(f.program());
    f.pipeline.queue({ ...f.program('Next useful task'), afterAction: first.actionId });
    Object.assign(f.context, change);
    f.pipeline.completed(f.finish());
    assert.equal(f.actions.size, 1);
    assert.equal(f.events.at(-1)[0], 'error');
  }
});

test('a completed predecessor cannot admit a late continuation across a safety interruption', () => {
  const f = fixture();
  const first = f.pipeline.start(f.program('Mine stone'));
  f.pipeline.completed(f.finish());
  f.pipeline.clear();
  f.context.reflexOwner = 'eating';
  f.context.reflexOwner = null;
  assert.throws(() => f.pipeline.queue({ ...f.program('Craft pickaxe'), afterAction: first.actionId }), /obsolete/);
  assert.equal(f.actions.size, 1);
  assert.equal(f.pipeline.current().id, first.actionId, 'interruption does not erase completed action evidence');
});

test('stale identity and oversized requests fail before queue admission', () => {
  const f = fixture();
  const first = f.pipeline.start(f.program());
  assert.throws(() => f.pipeline.queue({ ...f.program(), afterAction: 'stale' }), /latest uninterrupted action/);
  assert.throws(() => f.pipeline.queue({ ...f.program(), input: 'x'.repeat(17000), afterAction: first.actionId }), /16 KiB/);
  assert.equal(f.pipeline.next, null);
});
