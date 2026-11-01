import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBaseCamera, selectPovCamera, capturePlanning, startCaptureServer } from './vision-capture.mjs';

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

test('one read-only capture at a time; errors are returned, not replaced with old images', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const server = await startCaptureServer({ port: 0, capture: async () => { entered(); await pending; throw new Error('Renderer failed'); } });
  try {
    const url = `http://127.0.0.1:${server.address().port}/capture`;
    const options = { method: 'POST', body: JSON.stringify(state()) };
    const first = fetch(url, options);
    await started;
    assert.equal((await fetch(url, options)).status, 409);
    release();
    const failed = await first;
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: 'Renderer failed' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
