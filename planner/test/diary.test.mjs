import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPlanner } from '../server.mjs';
import { ModelQueue } from '../queue.mjs';
import { validateDiaryParagraph } from '../diary.mjs';
import { fakeEngine } from './helpers/strategy-fixtures.mjs';

const paragraph = 'I had pictured a roof by now, but the hillside clearly had other ideas. Flint found stone while I kept arguing with the route home. Having a sword in my pack feels reassuring, even if it has not made me any better at getting anywhere. We are still a long way from our woodland home, and today I am counting stubbornness as a useful supply.';

test('diary uses the shared Terra queue without injecting missions; failures remain errors', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-diary-test-'));
  const calls = [];
  let answer = paragraph;
  const engine = fakeEngine({
    complete: async (...args) => {
      calls.push(args);
      return { text: answer, answerEntryId: 'durable-answer' };
    },
    close: async () => {},
  });
  const token = 'test-only-diary-relay-credential';
  const planner = await startPlanner({
    engine, token, stateDir, missionFile: path.join(stateDir, 'mission.json'),
    port: 0, queue: new ModelQueue({ intervalMs: 0 }),
  });
  const url = `http://127.0.0.1:${planner.server.address().port}/diary`;
  const input = { observedAt: new Date().toISOString(), objective: 'Build a home', bots: [], facts: ['Flint mined stone; pickup not confirmed.'] };
  const post = (data, authenticated = true) => fetch(url, {
    method: 'POST', headers: authenticated ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(data),
  });
  try {
    assert.equal((await post(input, false)).status, 401);
    assert.equal((await post({ ...input, observedAt: '2020-01-01T00:00:00Z' })).status, 400);
    assert.equal(calls.length, 0);
    const response = await post(input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: paragraph, model: 'gpt-6.1-terra', answerEntryId: 'durable-answer' });
    assert.equal(calls[0][0].length, 2);
    assert.deepEqual(JSON.parse(calls[0][0][1].content), input);
    assert.equal(calls[0][2].role, 'repair');
    answer = '- Mined stone.\n- Built a house.';
    assert.equal((await post(input)).status, 502);
  } finally {
    await planner.close();
  }
});

test('prose validation rejects telemetry lists, multiple paragraphs and oversized output', () => {
  assert.equal(validateDiaryParagraph(paragraph), paragraph);
  for (const text of ['', 'Done.', `${paragraph}\n${paragraph}`, 'word '.repeat(121)]) {
    assert.throws(() => validateDiaryParagraph(text), /one short prose paragraph/);
  }
});
