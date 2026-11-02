import { skillEvidence } from './observations.mjs';

/** Small host-owned history, independent of noisy RPC events and model notes. */
export class ProgressHistory {
  constructor(saved = { actions: [], deaths: 0, placedBlocks: 0, lastMaterialProgressAt: null }) {
    this.state = saved;
  }

  died(at = new Date().toISOString()) {
    this.state.deaths++;
    this.state.lastDeathAt = at;
  }

  placed(at = new Date().toISOString()) {
    this.state.placedBlocks++;
    this.state.lastMaterialProgressAt = at;
  }

  completed(action) {
    const effects = action.before && action.after ? skillEvidence(action.before, action.after) : null;
    const travel = action.before && action.after && action.before.dimension === action.after.dimension
      ? Math.hypot(...['x', 'y', 'z'].map(axis => action.after.position[axis] - action.before.position[axis]))
      : 0;
    const gainedItems = effects && Object.values(effects.inventoryDelta).some(count => count > 0);
    if (gainedItems || effects?.foodDelta > 0) this.state.lastMaterialProgressAt = action.completedAt;
    this.state.actions.push({
      name: action.name, state: action.state, at: action.completedAt,
      durationMs: Date.parse(action.completedAt) - Date.parse(action.startedAt),
      error: action.error?.split('\n')[0], effects, displacement: Math.round(travel),
      // A running wait is not productive work. Keep its identity distinct from idle latency.
      waitingOnly: action.callCount > 0 && action.waitingOnly,
    });
  }

  observation(now = Date.now()) {
    return {
      ...structuredClone(this.state),
      secondsSinceMaterialProgress: this.state.lastMaterialProgressAt
        ? Math.round((now - Date.parse(this.state.lastMaterialProgressAt)) / 1000) : null,
      interpretation: 'Host-observed recent outcomes, not model claims. Displacement/scans/waiting are not construction or acquired supplies. A placed block alone does not prove a functional shelter. Review repeated failures and resource-free travel; change the approach instead of repeating it.',
    };
  }
}
