import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerLoop } from '../controller-loop.mjs';
import { BackgroundAgent } from '../background-agent.mjs';
import { ControlDrain } from '../control-drain.mjs';

function fixture() {
  const calls = [];
  let current = null;
  let active = { version: 'first' };
  const context = { worldId: 'fresh', session: 'session', life: 1, health: 20 };
  const pipeline = { current: () => current, start: program => { calls.push(['start', program]); current = { id: 'action', name: program.name, state: 'running', settled: false, calls: [] }; } };
  const controller = {
    current: () => active,
    inspect: version => version ? { status: 'admitted' } : { state: {} },
    activate: async version => { calls.push(['activate', version]); active = { version }; },
    resetState: async reason => calls.push(['reset', reason]),
    decide: async observation => { calls.push(['decide', observation]); return { state: {}, action: { name: 'Acquire useful supplies', code: 'return await mc.observe();' } }; },
  };
  const loop = new ControllerLoop({ controller, pipeline, context: () => context,
    observe: () => ({ position: { x: 1, y: 64, z: 2 }, blocks: [], entities: [], inventory: [] }),
    onEvent: (...event) => calls.push(['event', ...event]),
  });
  return { loop, controller, calls, context, setCurrent: value => { current = value; } };
}

test('local control keeps selecting after actions without any model or queued successor', async () => {
  const f = fixture();
  for (let n = 0; n < 4; n++) {
    await f.loop.tick();
    f.setCurrent({ id: 'action', name: 'Acquire useful supplies', state: 'completed', settled: true, calls: [] });
  }
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 4);
  assert.ok(f.calls.filter(call => call[0] === 'decide').every(([, obs]) => obs.session === 'session' && obs.worldId === 'fresh'));
});

test('admitted source cannot activate until action and cancellation drain', async () => {
  const f = fixture();
  f.loop.stage({ version: 'second' });
  f.setCurrent({ state: 'running', settled: false });
  await f.loop.tick();
  f.setCurrent({ state: 'cancelled', settled: false });
  await f.loop.tick();
  assert.equal(f.calls.length, 0);
  f.setCurrent(null);
  await f.loop.tick();
  assert.deepEqual(f.calls[0], ['activate', 'second']);
});

test('death during a decision discards its action and preserves goals with fresh life', async () => {
  const f = fixture();
  let resolve;
  f.controller.decide = () => new Promise(done => { resolve = done; });
  const inFlight = f.loop.tick();
  await Promise.resolve();
  f.context.life++;
  f.loop.invalidate('death');
  resolve({ state: {}, action: { name: 'Stale action', code: 'return 1;' } });
  await inFlight;
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 0);
  f.controller.decide = async observation => {
    assert.equal(observation.life, 2);
    assert.equal(observation.interruption.reason, 'death');
    return { state: {}, action: null, reason: 'Recovering with fresh state', wakeAfterMs: 1000 };
  };
  await f.loop.tick();
  assert.equal(f.calls.some(call => call[0] === 'reset'), false);
});

test('failed candidate leaves working controller in charge and idle deadlines do not spin', async () => {
  const f = fixture();
  f.controller.inspect = version => version ? { status: 'failed', error: 'Syntax rejected' } : { state: {} };
  f.controller.decide = async () => ({ state: {}, action: null, reason: 'Explicit bounded idle', wakeAfterMs: 5000 });
  f.loop.stage({ version: 'broken' });
  await f.loop.tick();
  assert.equal(f.calls.some(call => call[0] === 'activate'), false);
  assert.ok(f.calls.some(call => call[1] === 'controller_error'));
  const count = f.calls.length;
  await f.loop.tick();
  assert.equal(f.calls.length, count);
});

test('safety interruption before activation defers promotion; invalidated decision never starts', async () => {
  const f = fixture();
  f.controller.inspect = () => {
    f.context.reflexOwner = 'surfacing';
    f.loop.invalidate('surfacing');
    return { status: 'admitted' };
  };
  f.loop.stage({ version: 'second' });
  await f.loop.tick();
  assert.deepEqual(f.loop.inspect().pending, ['second']);
  assert.equal(f.calls.some(call => call[0] === 'activate' || call[0] === 'start'), false);
});

test('large query results reach the controller intact rather than disappearing at 16 KiB', async () => {
  const f = fixture();
  f.setCurrent({ id: 'oversized', name: 'Query too broadly', state: 'completed', settled: true, calls: [], value: 'x'.repeat(17000) });
  f.controller.decide = async (observation, result) => {
    assert.equal(result.value, 'x'.repeat(17000));
    return { state: {}, action: { name: 'Recover with bounded query', code: 'return await mc.call("registryInfo","biomes",{limit:4});' } };
  };
  await f.loop.tick();
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
});

test('local controller receives all non-air sensors including a target beyond the old slice', () => {
  const f = fixture();
  const blocks = Array.from({ length: 60 }, (_, i) => ({ name: i === 59 ? 'furnace' : 'stone' }));
  const entities = Array.from({ length: 32 }, (_, id) => ({ id, name: 'sheep' }));
  f.loop.observe = () => ({ inventory: [{ name: 'stone_pickaxe', count: 1 }], blocks, entities });
  const snapshot = f.loop.snapshot();
  assert.deepEqual(snapshot.blocks, blocks);
  assert.deepEqual(snapshot.entities, entities);
  assert.equal(snapshot.blocks.at(-1).name, 'furnace');
  assert.equal(snapshot.sensorWindow.blocks, 60);
});

test('recovering or blocked background engineer cannot block an already active local controller', async () => {
  const f = fixture();
  const failures = [];
  let recover;
  const engineer = new BackgroundAgent({ open: signal => new Promise((resolve, reject) => {
    recover = resolve;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), onError: error => failures.push(error) });
  await Promise.resolve();
  await f.loop.tick();
  assert.equal(engineer.agent, undefined);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  let closed = false;
  recover({ close: async () => { closed = true; } });
  await engineer.opening;
  await engineer.close();
  assert.equal(closed, true);
  assert.deepEqual(failures, []);
});

test('background recovery failure is visible and closing stalled recovery aborts it', async () => {
  const failures = [];
  const failed = new BackgroundAgent({ open: async () => { throw new Error('Parked generation'); }, onError: error => failures.push(error.message) });
  await failed.opening;
  assert.deepEqual(failures, ['Parked generation']);
  await failed.close();
  const stalled = new BackgroundAgent({ open: signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), onError: error => failures.push(error.message) });
  await Promise.resolve();
  await stalled.close();
  assert.equal(failures.length, 1);
});

test('oversized thrown error remains a failure but cannot prevent local recovery', async () => {
  const f = fixture();
  f.setCurrent({ id: 'failed', name: 'Failed query', state: 'failed', settled: true, calls: [], error: 'x'.repeat(17000) });
  f.controller.decide = async (observation, result) => {
    assert.equal(result.state, 'failed');
    assert.equal(result.error, 'x'.repeat(17000));
    return { state: {}, action: { name: 'Recover after error', code: 'return await mc.observe();' } };
  };
  await f.loop.tick();
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
});

test('admitted source activates directly without offline decision execution', async () => {
  const f = fixture();
  f.controller.validate = () => { throw new Error('Offline validation is not part of hot reload'); };
  f.loop.stage({ version: 'parsed-source' });
  await f.loop.tick();
  assert.deepEqual(f.calls[0], ['activate', 'parsed-source']);
});

test('a newly staged patch wakes a locally idle controller immediately', async () => {
  const f = fixture();
  f.loop.nextAt = Date.now() + 60000;
  f.loop.stage({ version: 'urgent-repair' });
  await f.loop.tick();
  assert.deepEqual(f.calls[0], ['activate', 'urgent-repair']);
});

test('a failed background open can retry once while local play continues, without concurrent openers', async () => {
  const f = fixture();
  let opens = 0;
  let closed = 0;
  const failures = [];
  const engineer = new BackgroundAgent({ open: async () => {
    opens++;
    if (opens === 1) throw new Error('Transient broker failure');
    return { close: async () => { closed++; } };
  }, onError: error => failures.push(error.message) });
  await engineer.opening;
  await f.loop.tick();
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  const retry = engineer.retry();
  assert.equal(engineer.retry(), retry);
  await retry;
  assert.equal(opens, 2);
  assert.deepEqual(failures, ['Transient broker failure']);
  assert.equal(engineer.error, null);
  await engineer.close();
  await engineer.retry();
  assert.equal(opens, 2);
  assert.equal(closed, 1);
});

test('a settled sandbox cannot admit a patch or successor while host RPC and trailing controls drain', async () => {
  const f = fixture();
  const drain = new ControlDrain();
  let releaseHost;
  const hostIdle = new Promise(resolve => { releaseHost = resolve; });
  const context = f.loop.context;
  f.loop.context = () => ({ ...context(), draining: drain.active });
  f.setCurrent(null);
  f.loop.stage({ version: 'after-full-drain' });
  let cleaned = false;
  const interruption = drain.run(async () => {
    // Sandbox settlement is already complete, but the host RPC still owns control.
    await hostIdle;
    cleaned = true;
  });
  await f.loop.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(drain.active, true);
  releaseHost();
  await interruption;
  await f.loop.tick();
  assert.equal(cleaned, true);
  assert.deepEqual(f.calls[0], ['activate', 'after-full-drain']);
  assert.equal(drain.active, false);
});

test('hot reload interrupts a running action and waits for host control drain, not its deadline', async () => {
  const f = fixture();
  const drain = new ControlDrain();
  const context = f.loop.context;
  f.loop.context = () => ({ ...context(), draining: drain.active });
  const records = { replacement: { status: 'admitted' } };
  f.controller.inspect = version => version ? records[version] : { state: {} };
  const activate = f.controller.activate;
  f.controller.activate = async version => {
    assert.equal(drain.active, false);
    assert.equal(f.loop.pipeline.current()?.settled, true);
    await activate(version);
    records[version].status = 'active';
  };
  f.setCurrent({ id: 'long-action', state: 'running', settled: false });
  let releaseRpc;
  const rpcIdle = new Promise(resolve => { releaseRpc = resolve; });
  const reloading = f.loop.hotReload({ version: 'replacement' }, async reason => {
    assert.equal(reason, 'Controller hot reload');
    await drain.run(async () => {
      f.loop.invalidate(reason);
      f.setCurrent({ id: 'long-action', state: 'cancelled', settled: true, calls: [] });
      await rpcIdle;
    });
  });
  await f.loop.tick();
  assert.deepEqual(f.calls, []);
  assert.equal(drain.active, true);
  releaseRpc();
  const result = await reloading;
  assert.deepEqual(result, { version: 'replacement', status: 'active' });
  assert.deepEqual(f.calls[0], ['activate', 'replacement']);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(f.loop.inspect().epoch, 1);
});

test('hot reload wakes idle code immediately and reports failed admission without replacing it', async () => {
  const f = fixture();
  f.loop.nextAt = Date.now() + 120000;
  const rejected = { status: 'failed', error: 'Invalid module export' };
  f.controller.inspect = version => version ? rejected : { state: {} };
  const result = await f.loop.hotReload({ version: 'broken' }, async reason => f.loop.invalidate(reason));
  assert.deepEqual(result, { version: 'broken', ...rejected });
  assert.equal(f.controller.current().version, 'first');
  assert.equal(f.calls.some(call => call[0] === 'activate'), false);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  assert.ok(f.calls.some(call => call[0] === 'event' && call[1] === 'controller_error'));
});

test('hot reload during an in-flight decision discards its stale action before the new code runs', async () => {
  const f = fixture();
  let finishDecision;
  f.controller.decide = () => new Promise(resolve => { finishDecision = resolve; });
  const deciding = f.loop.tick();
  await Promise.resolve();
  let status = 'admitted';
  f.controller.inspect = version => version ? { status } : { state: {} };
  const result = await f.loop.hotReload({ version: 'replacement' }, async reason => f.loop.invalidate(reason));
  assert.deepEqual(result, { version: 'replacement', status: 'admitted' });
  finishDecision({ action: { name: 'Obsolete action', code: 'return 1;' } });
  await deciding;
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 0);
  const activate = f.controller.activate;
  f.controller.activate = async version => { await activate(version); status = 'active'; };
  f.controller.decide = async () => ({ action: { name: 'Fresh action', code: 'return 2;' } });
  await f.loop.tick();
  assert.equal(status, 'active');
  assert.deepEqual(f.calls.filter(call => call[0] === 'start').map(call => call[1].name), ['Fresh action']);
});

test('failed or overlapping interruption cleanup releases only its own drain lease', async () => {
  const drain = new ControlDrain();
  let release;
  const pending = drain.run(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(drain.run(async () => { throw new Error('Cleanup failed'); }), /Cleanup failed/);
  assert.equal(drain.active, true);
  release();
  await pending;
  assert.equal(drain.active, false);
});
