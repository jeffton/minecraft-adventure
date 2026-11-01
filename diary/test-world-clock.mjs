import test from 'node:test';
import assert from 'node:assert/strict';
import { worldClock } from './world-clock.js';

const overworld = (timeOfDay, isDay) => ({ dimension: 'overworld', time: { timeOfDay, isDay } });

test('Minecraft tick zero is 06:00; midnight and tick rollover are continuous', () => {
  for (const [ticks, expected] of [[0, '06:00'], [6000, '12:00'], [17999, '23:59'], [18000, '00:00'], [23999, '05:59'], [24000, '06:00']]) {
    assert.equal(worldClock(overworld(ticks, true)).time, expected);
  }
});

test('phase follows authoritative server day flag, not the host clock or an independent simulation', () => {
  assert.equal(worldClock(overworld(12999, true)).phase, 'day');
  assert.equal(worldClock(overworld(13000, false)).phase, 'night');
  assert.equal(worldClock(overworld(23000, false)).phase, 'night');
  assert.equal(worldClock(overworld(23001, true)).phase, 'day');
});

test('disconnected telemetry never leaves a live-looking clock; other dimensions have no cycle', () => {
  assert.equal(worldClock(null).phase, 'unavailable');
  assert.equal(worldClock(null).time, '—');
  for (const [dimension, label] of [['the_nether', 'Nether'], ['the_end', 'The End']]) {
    const clock = worldClock({ dimension, time: { timeOfDay: 18000, isDay: false } });
    assert.equal(clock.label, label);
    assert.equal(clock.phase, 'no-cycle');
    assert.equal(clock.time, 'No cycle');
  }
});
