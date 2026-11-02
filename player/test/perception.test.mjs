import test from 'node:test';
import assert from 'node:assert/strict';
import { readEngineeringPerception } from '../perception.mjs';
import { VisionLoop } from '../vision-loop.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('death during audit loading cannot pair a prior-life image with current server observations', async () => {
  const audit = deferred();
  let life = 'before';
  const vision = new VisionLoop({ capture: assert.fail, contextKey: () => life, onFrame: assert.fail, onError: assert.fail });
  vision.frame = { at: Date.now(), contextKey: life, frame: { image: 'prior-life' } };
  let built = false;
  const pending = readEngineeringPerception(() => audit.promise, controllerAudit => {
    built = true;
    const visual = vision.peek();
    return { life, controllerAudit, imagePending: !visual, image: visual?.frame.image };
  });
  assert.equal(built, false);
  life = 'after-death';
  audit.resolve({ version: 'old-controller' });
  const result = await pending;
  assert.equal(result.life, 'after-death');
  assert.equal(result.imagePending, true);
  assert.equal(result.image, undefined);
});

test('dimension changes during audit loading use a newly available matching image', async () => {
  const audit = deferred();
  let dimension = 'overworld';
  const vision = new VisionLoop({ capture: assert.fail, contextKey: () => dimension, onFrame: assert.fail, onError: assert.fail });
  vision.frame = { at: Date.now(), contextKey: dimension, frame: { image: 'overworld-frame' } };
  const pending = readEngineeringPerception(() => audit.promise, controllerAudit => ({
    dimension, controllerAudit, image: vision.peek()?.frame.image,
  }));
  dimension = 'the_nether';
  vision.frame = { at: Date.now(), contextKey: dimension, frame: { image: 'actual-nether-frame' } };
  audit.resolve({ checked: true });
  assert.deepEqual(await pending, { dimension: 'the_nether', controllerAudit: { checked: true }, image: 'actual-nether-frame' });
});
