import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDiary } from './capture.mjs';
import { startCaptureServer } from './vision-capture.mjs';

test('diary submits minimal current POV observations and decodes the shared helper frame', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roycraft-diary-capture-'));
  const statePath = join(directory, 'state.json');
  const output = join(directory, 'frame.webp');
  const bytes = Buffer.from('real frame bytes');
  const bot = { name: 'Roy', status: 'online', session: 'fresh-session', dimension: 'overworld', position: { x: 3, y: 64, z: 5 } };
  const updatedAt = new Date().toISOString();
  let observed;
  const server = await startCaptureServer({ port: 0, capture: async state => {
    observed = state;
    return { frames: [{ image: { type: 'image', mimeType: 'image/webp', data: bytes.toString('base64') } }] };
  } });
  try {
    await writeFile(statePath, JSON.stringify({
      updatedAt, worldId: 'fresh-world', home: { x: 1, y: 2, z: 3 },
      bots: [{ ...bot, inventory: [{ name: 'oak_log', count: 4 }], task: 'Find shelter' }],
      events: [{ message: 'x'.repeat(20000) }],
    }));
    await captureDiary(output, { statePath, url: `http://127.0.0.1:${server.address().port}/capture` });
    assert.deepEqual(observed, { updatedAt, bots: [bot], povBot: 'Roy', includeBase: false });
    assert.deepEqual(await readFile(output), bytes);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  }
});

test('diary helper errors fail visibly without writing a stale frame', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roycraft-diary-capture-error-'));
  const statePath = join(directory, 'state.json');
  const output = join(directory, 'frame.webp');
  const server = await startCaptureServer({ port: 0, capture: async () => { throw new Error('Renderer failed'); } });
  try {
    await writeFile(statePath, JSON.stringify({ updatedAt: new Date().toISOString(), bots: [] }));
    await assert.rejects(captureDiary(output, { statePath, url: `http://127.0.0.1:${server.address().port}/capture` }), /502.*Renderer failed/);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  }
});
