import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTitles, writeDiary } from '../diary-writer.mjs';

function modelsFor(value, stopReason = 'stop') {
  let calls = 0;
  return {
    get calls() { return calls; },
    getModel: () => ({ id: 'gpt-6.1-terra' }),
    completeSimple: async () => {
      calls++;
      return { stopReason, content: [{ type: 'text', text: JSON.stringify(value) }] };
    },
  };
}

test('one Terra call generates the paragraph and its unique title together', async () => {
  const models = modelsFor({ title: 'Terracotta After the Fall', text: 'I recovered my pickaxe and sealed a small room.' });
  const result = await writeDiary({ mode: 'entry', worldId: 'fresh', observedAt: 'now', usedTitles: ['An Empty Pocket'] }, models);
  assert.equal(models.calls, 1);
  assert.equal(result.title, 'Terracotta After the Fall');
  assert.equal(result.text, 'I recovered my pickaxe and sealed a small room.');
  assert.equal(result.worldId, 'fresh');
  assert.equal(result.model, 'gpt-6.1-terra');
});

test('title batches match timestamps rather than model ordering', async () => {
  const models = modelsFor([{ at: 'b', title: 'A Sealed Room' }, { at: 'a', title: 'Pickaxe Recovered' }]);
  assert.deepEqual(await writeDiary({ mode: 'titles', entries: [{ at: 'a' }, { at: 'b' }], usedTitles: [] }, models), [
    { at: 'a', title: 'Pickaxe Recovered' }, { at: 'b', title: 'A Sealed Room' },
  ]);
  assert.equal(models.calls, 1);
});

test('duplicates, unknown identities and incomplete batches fail instead of substituting a title', () => {
  assert.throws(() => validateTitles([{ at: 'a' }], [{ at: 'a', title: 'a sealed room' }], ['A Sealed Room']), /repeated/);
  assert.throws(() => validateTitles([{ at: 'a' }], [{ at: 'other', title: 'A Sealed Room' }]), /identities/);
  assert.throws(() => validateTitles([{ at: 'a' }], []), /incomplete/);
  assert.throws(() => validateTitles([{ at: 'a' }, { at: 'b' }], [{ at: 'a', title: 'A Sealed Room' }, { at: 'b', title: 'A Sealed Room' }]), /repeated/);
});

test('invalid output and failed inference are surfaced with no retry or fallback', async () => {
  for (const models of [modelsFor({ title: 'A New Room', text: '' }), modelsFor(null, 'error'), modelsFor({ title: 'A New Room', text: 'One paragraph.' }, 'length')]) {
    await assert.rejects(writeDiary({ mode: 'entry', observedAt: 'now', usedTitles: [] }, models));
    assert.equal(models.calls, 1);
  }
});
