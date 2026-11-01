import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBaseCamera, startCaptureServer } from './vision-capture.mjs';

const home = { x: 0, y: 64, z: 0, dimension: 'overworld' };
const state = () => ({ updatedAt: new Date().toISOString(), home, bots: [
  { name: 'Roy', status: 'online', dimension: 'overworld', position: { x: 10, y: 64, z: 0 } },
  { name: 'Moss', status: 'online', dimension: 'overworld', position: { x: 2, y: 64, z: 0 } },
] });

test('capture selects only a live source in the current base dimension and loaded vicinity', () => {
  assert.equal(selectBaseCamera(state()).bot, 'Moss');
  assert.throws(() => selectBaseCamera({ ...state(), updatedAt: '2000-01-01' }), /stale/);
  assert.throws(() => selectBaseCamera({ ...state(), bots: state().bots.map(bot => ({ ...bot, dimension: 'nether' })) }), /No online bot/);
  assert.throws(() => selectBaseCamera({ ...state(), bots: state().bots.map(bot => ({ ...bot, position: { x: 100, y: 64, z: 0 } })) }), /No online bot/);
});

test('two accepted requests serialize captures, overflow is visible and failure releases the queue', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let active = 0;
  let calls = 0;
  const server = await startCaptureServer({ port: 0, capture: async () => {
    active++;
    assert.equal(active, 1, 'Capture browsers must never overlap');
    calls++;
    try {
      if (calls === 1) {
        entered();
        await pending;
        throw new Error('Renderer failed');
      }
      return { frames: [{ image: { data: 'frame' } }] };
    } finally {
      active--;
    }
  } });
  try {
    const url = `http://127.0.0.1:${server.address().port}/capture`;
    const options = { method: 'POST', body: JSON.stringify(state()) };
    const first = fetch(url, options);
    await started;
    const accepted = new Promise(resolve => server.once('request', resolve));
    const second = fetch(url, options);
    await accepted;
    const overflow = await fetch(url, options);
    assert.equal(overflow.status, 409);
    assert.deepEqual(await overflow.json(), { error: 'Capture queue is full' });
    assert.equal(calls, 1, 'Second capture must wait for the first browser to close');
    release();
    const failed = await first;
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: 'Renderer failed' });
    assert.equal((await second).status, 200);
    assert.equal((await fetch(url, options)).status, 200);
    assert.equal(calls, 3);
    assert.equal(active, 0);
  } finally {
    release();
    await new Promise(resolve => server.close(resolve));
  }
});

test('invalid queued JSON releases its slot without bypassing the active capture', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const server = await startCaptureServer({ port: 0, capture: async () => {
    calls++;
    if (calls === 1) {
      entered();
      await pending;
    }
    return { frames: [] };
  } });
  try {
    const url = `http://127.0.0.1:${server.address().port}/capture`;
    const options = { method: 'POST', body: JSON.stringify(state()) };
    const first = fetch(url, options);
    await started;
    const invalid = await fetch(url, { method: 'POST', body: '{' });
    assert.equal(invalid.status, 502);
    assert.equal((await fetch(url, options)).status, 409);
    assert.equal(calls, 1);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await fetch(url, options)).status, 200);
    assert.equal(calls, 2);
  } finally {
    release();
    await new Promise(resolve => server.close(resolve));
  }
});
