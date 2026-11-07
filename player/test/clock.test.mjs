import test from 'node:test';
import assert from 'node:assert/strict';
import { worldClock } from '../clock.mjs';

test('Minecraft clock and next solar events cross midnight and the day boundary correctly', () => {
  for (const [tick, clock, phase, sunriseSeconds, sunsetSeconds, nightSeconds] of [
    [0, '06:00', 'day', 1150, 600, 650],
    [6000, '12:00', 'day', 850, 300, 350],
    [11600, '17:36', 'day', 570, 20, 70],
    [12000, '18:00', 'sunset', 550, 0, 50],
    [13000, '19:00', 'night', 500, 1150, 0],
    [18000, '00:00', 'night', 250, 900, 950],
    [23000, '05:00', 'sunrise', 0, 650, 700],
    [23980, '05:58', 'sunrise', 1151, 601, 651],
  ]) {
    const time = worldClock({ day: 42, timeOfDay: tick, isDay: tick < 13000, doDaylightCycle: true }, 'overworld');
    assert.equal(time.day, 42);
    assert.equal(time.minecraftTime, clock);
    assert.equal(time.phase, phase);
    assert.equal(time.secondsUntilNextSunriseAt20Tps, sunriseSeconds);
    assert.equal(time.secondsUntilNextSunsetAt20Tps, sunsetSeconds);
    assert.equal(time.secondsUntilNextNightAt20Tps, nightSeconds);
  }
});

test('unknown clock, stopped cycle and dimensions without sunrise remain explicit', () => {
  assert.equal(worldClock(null, 'overworld'), null);
  assert.equal(worldClock({ timeOfDay: null }, 'overworld'), null);
  const stopped = worldClock({ timeOfDay: 12000, doDaylightCycle: false }, 'overworld');
  assert.equal(stopped.daylightCycleRunning, false);
  assert.equal(stopped.sunset.startsAt, '18:00');
  assert.equal(stopped.sunrise.startsAt, '05:00');
  const nether = worldClock({ timeOfDay: 12000, doDaylightCycle: true }, 'the_nether');
  assert.equal(nether.minecraftTime, '18:00');
  assert.equal(nether.sunrise, undefined);
  assert.equal(nether.secondsUntilNextSunsetAt20Tps, undefined);
});
