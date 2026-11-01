/** One ahead-planning attempt per action; physical work never awaits the model. */
export class DecisionGate {
  plannedActionId = null;

  claim({ action, next, health, reflexOwner, stopping }) {
    if (stopping || health <= 0 || reflexOwner) return null;
    if (action?.state !== 'running') return 'act';
    if (next || this.plannedActionId === action.id) return null;
    this.plannedActionId = action.id;
    return 'plan_ahead';
  }
}
