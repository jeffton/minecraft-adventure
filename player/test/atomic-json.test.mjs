import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson } from '../observations.mjs';

test('overlapping state publications each commit a complete JSON document', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'player-atomic-json-'));
  const file = path.join(directory, 'state.json');
  const values = Array.from({ length: 40 }, (_, revision) => ({ revision, payload: 'x'.repeat(8192) }));
  const results = await Promise.allSettled(values.map(value => atomicJson(file, value)));
  assert.deepEqual(results.filter(result => result.status === 'rejected'), []);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, values[saved.revision]);
  assert.deepEqual(await readdir(directory), ['state.json']);
});
