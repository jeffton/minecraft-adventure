import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelQueue } from '../queue.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('mission passes queued repairs without preempting active inference; equal priorities remain FIFO', async () => {
  const queue = new ModelQueue({ intervalMs: 0 });
  const started = deferred();
  const release = deferred();
  const order = [];
  let active = 0;
  let peak = 0;
  const first = queue.run(async () => {
    active++;
    peak = Math.max(peak, active);
    order.push('active');
    started.resolve();
    await release.promise;
    order.push('active finished');
    active--;
  });
  await started.promise;
  const record = name => async () => {
    active++;
    peak = Math.max(peak, active);
    order.push(name);
    active--;
    return name;
  };
  const repairs = [1, 2, 3, 4].map(n => queue.run(record(`repair ${n}`)));
  const mission = queue.run(record('mission'), { priority: 10 });
  const mission2 = queue.run(record('mission 2'), { priority: 10 });
  assert.deepEqual(order, ['active']);
  release.resolve();
  await Promise.all([first, ...repairs, mission, mission2]);
  await queue.drain();
  assert.deepEqual(order, ['active', 'active finished', 'mission', 'mission 2', 'repair 1', 'repair 2', 'repair 3', 'repair 4']);
  assert.equal(peak, 1);
  assert.equal(queue.pending, 0);
});

test('priority also applies to jobs awaiting the next paced start', async () => {
  let now = 100;
  const pacing = deferred();
  const release = deferred();
  const waits = [];
  const queue = new ModelQueue({
    intervalMs: 20,
    now: () => now,
    wait: async duration => {
      waits.push(duration);
      pacing.resolve();
      await release.promise;
      now += duration;
    },
  });
  const starts = [];
  await queue.run(async () => { starts.push(['first', now]); });
  const repair = queue.run(async () => { starts.push(['repair', now]); });
  await pacing.promise;
  const mission = queue.run(async () => { starts.push(['mission', now]); }, { priority: 1 });
  release.resolve();
  await Promise.all([repair, mission]);
  await queue.drain();
  assert.deepEqual(starts, [['first', 100], ['mission', 120], ['repair', 140]]);
  assert.deepEqual(waits, [20, 20]);
});

test('queued cancellation frees capacity immediately and never executes canceled work', async () => {
  const queue = new ModelQueue({ intervalMs: 0, capacity: 2 });
  const started = deferred();
  const release = deferred();
  const active = queue.run(async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const controller = new AbortController();
  let canceledRan = false;
  const canceled = queue.run(async () => { canceledRan = true; }, { signal: controller.signal, priority: 10 });
  const rejected = assert.rejects(canceled, { name: 'AbortError' });
  assert.throws(() => queue.run(async () => {}), { status: 429 });
  controller.abort();
  assert.equal(queue.pending, 1);
  const replacement = queue.run(async () => 'replacement');
  await rejected;
  release.resolve();
  assert.equal(await replacement, 'replacement');
  await active;
  await queue.drain();
  assert.equal(canceledRan, false);
  assert.equal(queue.pending, 0);
});

test('active cancellation remains owned by inference and drain waits through failures', async () => {
  const queue = new ModelQueue({ intervalMs: 0 });
  const controller = new AbortController();
  const started = deferred();
  const release = deferred();
  const active = queue.run(async () => {
    started.resolve();
    await release.promise;
    throw new Error('inference failed');
  }, { signal: controller.signal });
  const rejected = assert.rejects(active, /inference failed/);
  await started.promise;
  controller.abort();
  assert.equal(queue.pending, 1);
  let nextRan = false;
  const next = queue.run(async () => { nextRan = true; });
  let drained = false;
  const draining = queue.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(nextRan, false);
  release.resolve();
  await Promise.all([rejected, next, draining]);
  assert.equal(nextRan, true);
  assert.equal(queue.pending, 0);
  assert.equal(await queue.run(async () => 'reused'), 'reused');
  await queue.drain();
});

test('an already aborted caller does not occupy queue capacity', async () => {
  const queue = new ModelQueue({ intervalMs: 0, capacity: 1 });
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => queue.run(async () => {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(queue.pending, 0);
  assert.equal(await queue.run(async () => 'ok'), 'ok');
  await queue.drain();
});
