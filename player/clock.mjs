// Overworld celestial boundaries. Minecraft normally advances 20 ticks/second;
// server lag or a stopped daylight cycle changes the wall-clock duration.
export function worldClock(time, dimension) {
  if (!time || time.timeOfDay == null) return null;
  const tick = time.timeOfDay;
  const clock = {
    day: time.day,
    timeOfDay: tick,
    isDay: time.isDay,
    daylightCycleRunning: time.doDaylightCycle,
    minecraftTime: `${String(Math.floor((tick / 1000 + 6) % 24)).padStart(2, '0')}:${String(Math.floor((tick % 1000) * 60 / 1000)).padStart(2, '0')}`,
  };
  if (dimension !== 'overworld') return clock;
  const secondsUntil = target => ((target - tick + 24000) % 24000) / 20;
  return {
    ...clock,
    phase: tick < 12000 ? 'day' : tick < 13000 ? 'sunset' : tick < 23000 ? 'night' : 'sunrise',
    sunrise: { startsAt: '05:00', endsAt: '06:00', startTick: 23000, endTick: 0 },
    sunset: { startsAt: '18:00', endsAt: '19:00', startTick: 12000, endTick: 13000 },
    secondsUntilNextSunriseAt20Tps: secondsUntil(23000),
    secondsUntilNextSunsetAt20Tps: secondsUntil(12000),
    secondsUntilNextNightAt20Tps: secondsUntil(13000),
  };
}
