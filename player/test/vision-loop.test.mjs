import test from 'node:test';
import assert from 'node:assert/strict';
import { VisionLoop } from '../vision-loop.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('fresh actual image remains available during asynchronous prefetch without waiting for Chromium', async () => {
  let now = 0;
  let capture = deferred();
  let count = 0;
  const frames = [];
  const loop = new VisionLoop({ capture: () => { count++; return capture.promise; }, contextKey: () => 'same-life', onFrame: frame => frames.push(frame), onError: assert.fail, now: () => now });
  const first = loop.current();
  capture.resolve({ at: 0, frame: { image: { type: 'image', data: 'actual-first-frame' } } });
  await first;
  now = 50000;
  capture = deferred();
  const background = loop.refresh();
  const visual = await loop.current();
  assert.equal(visual.frame.image.data, 'actual-first-frame');
  assert.equal(count, 2);
  capture.resolve({ at: now, frame: { image: { type: 'image', data: 'actual-next-frame' } } });
  await background;
  assert.equal((await loop.current()).frame.image.data, 'actual-next-frame');
  assert.equal(frames.length, 2);
});

test('stale or different-life images are never used and one render is shared by concurrent consumers', async () => {
  let key = 'first-life';
  const capture = deferred();
  let count = 0;
  const loop = new VisionLoop({ capture: () => { count++; return capture.promise; }, contextKey: () => key, onFrame: () => {}, onError: assert.fail });
  const a = loop.current();
  const b = loop.current();
  key = 'new-life';
  capture.resolve({ at: Date.now(), frame: {} });
  await assert.rejects(a, /context changed/);
  await assert.rejects(b, /context changed/);
  assert.equal(count, 1);
  assert.equal(loop.frame, null);
});

test('an expired image waits for a real replacement instead of silently sending stale vision', async () => {
  let now = 100000;
  const capture = deferred();
  const loop = new VisionLoop({ capture: () => capture.promise, contextKey: () => 'life', onFrame: () => {}, onError: assert.fail, now: () => now });
  loop.frame = { at: 0, contextKey: 'life', frame: { image: 'expired' } };
  let resolved = false;
  const current = loop.current().then(value => { resolved = true; return value; });
  await Promise.resolve();
  assert.equal(resolved, false);
  capture.resolve({ at: now, frame: { image: 'new' } });
  assert.equal((await current).frame.image, 'new');
});

test('reactive analysis requests a newer image than the ordinary cache and shares its capture', async () => {
  const capture = deferred();
  let count = 0;
  const loop = new VisionLoop({ capture: () => { count++; return capture.promise; }, contextKey: () => 'life', onFrame: () => {}, onError: assert.fail, now: () => 45000 });
  loop.frame = { at: 0, contextKey: 'life', frame: { image: 'old-but-valid-for-passive-view' } };
  assert.equal((await loop.current()).frame.image, 'old-but-valid-for-passive-view');
  const engineer = loop.current({ maxAgeMs: 5000 });
  const sameEvidence = loop.current({ maxAgeMs: 5000 });
  assert.equal(count, 1);
  capture.resolve({ at: 45000, frame: { image: 'new-evidence' } });
  assert.equal((await engineer).frame.image, 'new-evidence');
  assert.equal((await sameEvidence).frame.image, 'new-evidence');
});

test('pending camera work never blocks independent analysis and never supplies a stale image', async () => {
  const capture = deferred();
  let count = 0;
  const loop = new VisionLoop({ capture: () => { count++; return capture.promise; }, contextKey: () => 'current-life', onFrame: () => {}, onError: assert.fail });
  loop.frame = { at: Date.now(), contextKey: 'previous-life', frame: { image: 'stale' } };
  loop.request();
  loop.request();
  const observed = { imagePending: loop.peek({ maxAgeMs: 5000 }) === null, health: 20 };
  let analysisStarted = false;
  await Promise.resolve().then(() => { analysisStarted = true; });
  assert.equal(analysisStarted, true);
  assert.equal(observed.imagePending, true);
  assert.equal(count, 1);
  capture.resolve({ at: Date.now(), frame: { image: 'actual-current' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loop.peek().frame.image, 'actual-current');
  loop.close();
});

test('death during an asynchronous render requests the new-life frame without waiting for a timer', async () => {
  const captures = [deferred(), deferred()];
  const errors = [];
  const frames = [];
  let key = 'life-one';
  let count = 0;
  const loop = new VisionLoop({ capture: () => captures[count++].promise, contextKey: () => key,
    onFrame: frame => frames.push(frame), onError: error => errors.push(error.message), intervalMs: 50000 });
  loop.request();
  key = 'life-two';
  captures[0].resolve({ at: Date.now(), frame: { image: 'invalidated-old-life' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 2);
  assert.equal(loop.peek(), null);
  assert.equal(frames.length, 0);
  assert.match(errors[0], /context changed/);
  captures[1].resolve({ at: Date.now(), frame: { image: 'actual-new-life' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loop.peek().frame.image, 'actual-new-life');
  assert.equal(frames.length, 1);
  loop.close();
});

test('closing an invalidated pending render cannot schedule another capture', async () => {
  const capture = deferred();
  let key = 'before';
  let count = 0;
  const loop = new VisionLoop({ capture: () => { count++; return capture.promise; }, contextKey: () => key, onFrame: () => {}, onError: () => {} });
  loop.request();
  loop.close();
  key = 'after';
  capture.resolve({ at: Date.now(), frame: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1);
  assert.equal(loop.peek(), null);
});
