import { skillEvidence } from './observations.mjs';
import { rpcFailureKey } from './sandbox.mjs';

/** Only repeated identical RPC failures in THIS stationary attempt justify patch interruption. */
export function shouldDrainForRepair({ analysis, action, observed, worldEffect, reflexOwner }) {
  if (!analysis || action?.state !== 'running' || reflexOwner || worldEffect !== analysis.worldEffect || !action.before) return false;
  const demonstratedFailure = analysis.reasons.some(reason => reason.kind === 'rpc_failure' &&
    reason.details.actionId === action.id && action.failureStreak?.key === rpcFailureKey(reason.details.method, reason.details.args) &&
    action.failureStreak.count >= 4);
  if (!demonstratedFailure) return false;
  const effects = skillEvidence(action.before, observed);
  const displacement = Math.hypot(...['x', 'y', 'z'].map(axis => observed.position[axis] - action.before.position[axis]));
  return action.before.dimension === observed.dimension && !Object.keys(effects.inventoryDelta).length &&
    effects.foodDelta <= 0 && effects.healthDelta === 0 && displacement < 2;
}

/** Ownership survives sandbox exit until every host RPC and control cleanup has settled. */
export class ControlDrain {
  count = 0;

  get active() { return this.count > 0; }

  async run(work) {
    this.count++;
    try { return await work(); }
    finally { this.count--; }
  }
}
