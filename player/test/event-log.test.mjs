import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPlayerEvents } from '../event-log.mjs';

test('persisted evidence retains full messages and supports semantic selection without truncation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roy-event-log-'));
  const file = path.join(directory, 'events.jsonl');
  const events = Array.from({ length: 150 }, (_, index) => ({ session: index < 10 ? 'previous' : 'current', sequence: index + 1, type: index % 2 ? 'rpc' : 'error', message: 'x'.repeat(4000) + '\nreal detail' }));
  await writeFile(file, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  assert.deepEqual(await readPlayerEvents(file), events);
  assert.deepEqual(await readPlayerEvents(file, { session: 'current', afterSequence: 100, types: ['error'] }), events.filter(event => event.session === 'current' && event.sequence > 100 && event.type === 'error'));
  await assert.rejects(readPlayerEvents(path.join(directory, 'missing.jsonl')), /ENOENT/);
});
