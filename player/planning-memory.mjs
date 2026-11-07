import { atomicJson, optionalJson } from './observations.mjs';

/** The selected home lives only in world-scoped notes, never in a mission thread. */
export async function openPlanningMemory(file, onHomeSelected = () => {}) {
  let notes = await optionalJson(file, {});
  async function save(next) {
    await atomicJson(file, next);
    notes = next;
    return notes;
  }
  return {
    get notes() { return notes; },
    get home() { return notes.home ?? null; },
    async remember(next) {
      // General lesson updates cannot accidentally forget or relocate the base.
      const { home: ignored, ...lessons } = next;
      return save({ ...lessons, ...(notes.home === undefined ? {} : { home: notes.home }) });
    },
    async selectHome(home) {
      const previous = notes.home ?? null;
      await save({ ...notes, home });
      onHomeSelected({ previous, home });
      return home;
    },
  };
}

export function planningMemoryTools(memory) {
  return [{
    name: 'remember',
    description: 'Store current-world planning notes, discoveries and lessons. Replaces general notes, but preserves the selected home automatically. Use select_home, not remember, to choose or deliberately relocate the permanent base. Notes are not proof of completion.',
    parameters: { type: 'object', properties: { notes: { type: 'object' } }, required: ['notes'], additionalProperties: false },
    execute: ({ notes }) => memory.remember(notes),
  }, {
    name: 'select_home',
    description: 'Explicitly choose the permanent home or deliberately relocate it using an observed dimension and coordinates. home in every observation is the durable selected base, retained across missions, death and restart. Keep improving and returning to that same home; do not choose a fresh base for each mission or respawn. If home already describes a chest/shelter, retain that chosen site unless deliberately relocating for a concrete reason. This records a choice, not construction, bed spawn or verified safety. Explain the selection/relocation; it is recorded in event history.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        dimension: { type: 'string' },
        position: {
          type: 'object', additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          required: ['x', 'y', 'z'],
        },
        reason: { type: 'string' },
      },
      required: ['dimension', 'position', 'reason'],
    },
    execute: home => memory.selectHome(home),
  }];
}
