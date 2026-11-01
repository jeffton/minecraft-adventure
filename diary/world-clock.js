export function worldClock(state) {
  if (!state) return { phase: 'unavailable', label: 'World time', time: '—', description: 'Waiting for live world time' };
  if (state.dimension !== 'overworld') {
    const label = state.dimension === 'the_nether' ? 'Nether' : 'The End';
    return { phase: 'no-cycle', label, time: 'No cycle', description: `${label} has no day/night cycle` };
  }
  const minutes = Math.floor(((state.time.timeOfDay + 6000) % 24000) * 60 / 1000);
  const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const label = state.time.isDay ? 'Day' : 'Night';
  return { phase: state.time.isDay ? 'day' : 'night', label, time, description: `Minecraft time · ${label.toLowerCase()} · ${time}` };
}

export function renderWorldClock(element, state) {
  const clock = worldClock(state);
  element.dataset.phase = clock.phase;
  element.title = clock.description;
  element.setAttribute('aria-label', clock.description);
  element.querySelector('.world-clock-label').textContent = clock.label;
  element.querySelector('.world-clock-time').textContent = clock.time;
}
