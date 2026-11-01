import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPovCamera, capturePlanning } from './vision-capture.mjs';

const state = () => ({ povBot: 'Spruce', includeBase: true, updatedAt: new Date().toISOString(), home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, bots: [
  { name: 'Spruce', status: 'online', session: 'spruce-session', dimension: 'overworld', position: { x: 100, y: 64, z: 0 } },
  { name: 'Roy', status: 'online', session: 'roy-session', dimension: 'overworld', position: { x: 2, y: 64, z: 0 } },
] });

test('POV follows the requested actor away from home and works without a known base', () => {
  const selected = selectPovCamera({ ...state(), home: null });
  assert.equal(selected.bot, 'Spruce');
  assert.equal(selected.kind, 'pov');
  assert.equal(selected.viewpoint, undefined, 'POV camera is never replaced with an observer pose');
  assert.equal(selected.sourceSession, 'spruce-session');
});

test('POV and optional building view use strictly sequential captures', async () => {
  let active = 0;
  const order = [];
  const result = await capturePlanning(state(), async selected => {
    active++;
    assert.equal(active, 1);
    order.push([selected.kind, selected.bot]);
    await Promise.resolve();
    active--;
    return selected;
  });
  assert.deepEqual(order, [['pov', 'Spruce'], ['base', 'Roy']]);
  assert.equal(result.frames.length, 2);
  assert.equal(result.baseView.status, 'included');
});

test('a base outside loaded terrain is reported explicitly; a failed real capture fails the batch', async () => {
  const input = state();
  input.bots = input.bots.filter(bot => bot.name === 'Spruce');
  const result = await capturePlanning(input, async selected => selected);
  assert.deepEqual(result.frames.map(frame => frame.kind), ['pov']);
  assert.equal(result.baseView.status, 'unavailable');
  assert.match(result.baseView.reason, /vicinity/);
  await assert.rejects(capturePlanning(state(), async selected => {
    if (selected.kind === 'base') throw new Error('Actual renderer failure');
    return selected;
  }), /Actual renderer failure/);
});
