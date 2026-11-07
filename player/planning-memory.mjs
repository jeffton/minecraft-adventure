import { atomicJson, optionalJson } from './observations.mjs';

/** The selected home lives only in world-scoped notes, never in a mission thread. */
export async function openPlanningMemory(file, onHomeSelected = () => {}) {
  let notes = await optionalJson(file, {});
  let writes = Promise.resolve();
  function update(change) {
    const result = writes.then(async () => {
      const next = change(notes);
      await atomicJson(file, next);
      notes = next;
      return notes;
    });
    // Each caller receives its error; a rejected write must not disable future updates.
    writes = result.catch(() => {});
    return result;
  }
  return {
    get notes() { return notes; },
    get home() { return notes.home ?? null; },
    get homeState() { return notes.homeState ?? null; },
    async rememberHome(knowledge) {
      await update(current => {
        if (!current.home) throw new Error('Select a home before recording its facilities and supplies');
        return { ...current, homeState: {
          home: current.home, recordedAt: new Date().toISOString(), knowledge,
          provenance: 'Agent-maintained observations; not automatically synchronized with the world',
        } };
      });
      return notes.homeState;
    },
    async remember(next) {
      // General lesson updates cannot accidentally forget or relocate the base.
      const { home: ignored, homeState: ignoredState, ...lessons } = next;
      return update(current => ({ ...lessons,
        ...(Object.hasOwn(lessons, 'plan') || current.plan === undefined ? {} : { plan: current.plan }),
        ...(current.home === undefined ? {} : { home: current.home }),
        ...(current.homeState === undefined ? {} : { homeState: current.homeState }),
      }));
    },
    async selectHome(home) {
      const previous = notes.home ?? null;
      await update(current => ({ ...current, home }));
      onHomeSelected({ previous, home });
      return home;
    },
  };
}

export function planningMemoryTools(memory) {
  return [{
    name: 'remember_home',
    description: 'Replace the selected home’s structured knowledge: facilities (chests, furnaces, crafting tables, beds and other construction), observed positions/dimensions, last-known contents and unresolved checks. Use real observations and action results, not intended outcomes. Player-reported changes are also useful: explicitly retain their unverified source, sender, message ID and receivedAt, separate from directly observed stock; reconcile instead of double-counting. Preserve useful existing knowledge when updating. Record per-fact observation times and uncertainty where useful; recordedAt is the note-writing time, not proof all facts were just checked. Other players may change stock or structures. After relocation the previous homeState remains labelled with its old home until explicitly replaced; do not transfer its facilities or stock to the new site. Home coordinates are changed only by select_home.',
    parameters: { type: 'object', properties: { knowledge: { type: 'object' } }, required: ['knowledge'], additionalProperties: false },
    execute: ({ knowledge }) => memory.rememberHome(knowledge),
  }, {
    name: 'remember',
    description: 'Store current-world planning notes, discoveries and lessons. Put your flexible long-term plan and progress in notes.plan: approaches, dependencies, verified achievements with evidence, unresolved checks and next opportunities. Update it explicitly when useful; omitted plan is preserved across short-term note replacements. Distinguish intentions, player reports and observed achievements; historical supplies are not current inventory. Replaces other general notes, but preserves the selected home and homeState automatically. Use remember_home for home facilities and stock. Use select_home, not remember, to choose or deliberately relocate the permanent base. Notes are not proof of completion.',
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
