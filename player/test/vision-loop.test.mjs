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
