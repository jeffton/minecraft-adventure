import { skillEvidence } from './observations.mjs';

const distance = (from, to) => Math.hypot(...['x', 'y', 'z'].map(axis => to[axis] - from[axis]));
const counts = inventory => inventory.reduce((result, { name, count }) => {
  result[name] = (result[name] ?? 0) + count;
  return result;
}, {});
const material = action => action.effects && (
  Object.values(action.effects.inventoryDelta).some(count => count > 0) || action.effects.foodDelta > 0
);
const endpoint = (position, dimension) => position ? { position, dimension: dimension ?? null } : null;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);

function summarize(actions) {
  const inventoryDelta = {};
  const destinations = new Map();
  let grossTravel = 0;
  let knownTravelActions = 0;
  let failed = 0;
  let waiting = 0;
  for (const action of actions) {
    failed += action.state === 'failed' ? 1 : 0;
    waiting += action.waitingOnly ? 1 : 0;
    for (const [name, count] of Object.entries(action.effects?.inventoryDelta ?? {})) {
      inventoryDelta[name] = (inventoryDelta[name] ?? 0) + count;
    }
    if (action.from && action.to && action.fromDimension != null && action.fromDimension === action.toDimension) {
      grossTravel += distance(action.from, action.to);
      knownTravelActions++;
      // Count arrivals, not idle observations, as repeated destinations.
      if (distance(action.from, action.to) > 0) {
        const position = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.floor(action.to[axis])]));
        const key = JSON.stringify([action.toDimension, position]);
        const visit = destinations.get(key) ?? { position, dimension: action.toDimension, arrivals: 0 };
        visit.arrivals++;
        destinations.set(key, visit);
      }
    }
  }
  const first = actions[0];
  const last = actions.at(-1);
  const completeTrajectory = actions.length > 0 && knownTravelActions === actions.length && actions.every((action, index) => (
    index === 0 || action.fromDimension === actions[index - 1].toDimension
      && distance(actions[index - 1].to, action.from) < 0.001
  ));
  const repeats = [...destinations.values()].filter(visit => visit.arrivals > 1);
  const inventoryKnown = Boolean(first?.inventoryBefore && last?.inventoryAfter);
  const retainedSupplyChanges = inventoryKnown
    ? Object.fromEntries([...new Set([...Object.keys(first.inventoryBefore), ...Object.keys(last.inventoryAfter)])]
      .map(name => [name, (last.inventoryAfter[name] ?? 0) - (first.inventoryBefore[name] ?? 0)])
      .filter(([, count]) => count !== 0))
    : null;
  return {
    actions: actions.length,
    failed,
    waiting,
    fromAt: first?.at ?? null,
    throughAt: last?.at ?? null,
    observedInventoryDelta: Object.fromEntries(Object.entries(inventoryDelta).filter(([, count]) => count !== 0)),
    retainedSupplyChanges,
    latestAction: last ?? null,
    trajectory: {
      from: endpoint(first?.from, first?.fromDimension),
      to: endpoint(last?.to, last?.toDimension),
      knownTravelActions,
      unknownTravelActions: actions.length - knownTravelActions,
      complete: completeTrajectory,
      // Endpoint displacement is not a path length; gaps/teleports/dimension changes invalidate net travel.
      netTravel: completeTrajectory ? distance(first.from, last.to) : null,
      grossTravel: knownTravelActions > 0 ? grossTravel : null,
      repeatedDestinations: repeats.length,
      mostRepeatedDestination: repeats.sort((a, b) => b.arrivals - a.arrivals)[0] ?? null,
    },
  };
}

/** Full durable evidence stays here; model observations are factual projections, not history dumps. */
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
    const sameDimension = action.before?.dimension != null && action.before.dimension === action.after?.dimension;
    const travel = sameDimension && action.before.position && action.after.position
      ? distance(action.before.position, action.after.position) : null;
    if (effects && material({ effects })) this.state.lastMaterialProgressAt = action.completedAt;
    this.state.actions.push({
      name: action.name, state: action.state, at: action.completedAt,
      session: action.session ?? action.after?.session ?? action.before?.session ?? null,
      from: structuredClone(action.before?.position ?? null),
      to: structuredClone(action.after?.position ?? null),
      fromDimension: action.before?.dimension ?? null,
      toDimension: action.after?.dimension ?? null,
      inventoryBefore: action.before?.inventory ? counts(action.before.inventory) : null,
      inventoryAfter: action.after?.inventory ? counts(action.after.inventory) : null,
      durationMs: Date.parse(action.completedAt) - Date.parse(action.startedAt),
      error: action.error?.split('\n')[0], effects, displacement: travel == null ? null : Math.round(travel),
      // A running wait is not productive work. Keep its identity distinct from idle latency.
      waitingOnly: action.callCount > 0 && action.waitingOnly,
    });
  }

  observation({ session, since, now = Date.now() } = {}) {
    const actions = this.state.actions;
    const current = session == null ? actions : actions.filter(action => action.session === session);
    const latestMaterialProgress = actions.findLast(material) ?? null;
    const currentMaterialProgress = current.findLast(material);
    const boundary = since ?? currentMaterialProgress?.at ?? null;
    const recent = boundary == null ? current : current.filter(action => timestamp(action.at) >= timestamp(boundary));
    const overall = summarize(actions);
    // Keep historical aggregates without projecting historical trajectories, inventories or action records.
    return structuredClone({
      totalActions: actions.length,
      deaths: this.state.deaths,
      placedBlocks: this.state.placedBlocks,
      lastDeathAt: this.state.lastDeathAt ?? null,
      lastMaterialProgressAt: this.state.lastMaterialProgressAt,
      secondsSinceMaterialProgress: this.state.lastMaterialProgressAt
        ? Math.round((now - Date.parse(this.state.lastMaterialProgressAt)) / 1000) : null,
      overall: {
        failed: overall.failed,
        waiting: overall.waiting,
        observedInventoryDelta: overall.observedInventoryDelta,
        grossTravel: overall.trajectory.grossTravel,
        unknownTravelActions: overall.trajectory.unknownTravelActions,
      },
      latestMaterialProgress,
      currentRun: { session: session ?? null, ...summarize(current) },
      recent: { since: boundary, ...summarize(recent) },
      interpretation: 'Host-observed outcomes, not model claims. Travel is between action endpoints, not the full path inside an action. Net travel is unknown if endpoints are missing or discontinuous; historical displacement alone cannot recover trajectories. Repeated destinations count arrivals in the same block, excluding stationary actions. Retained supply changes compare segment inventory endpoints; observed deltas sum only recorded actions. Full actions remain in durable history; use action history/events tools for details. Displacement/scans/waiting are not construction or acquired supplies. A placed block alone does not prove a functional shelter. Review repeated failures and resource-free travel; change the approach instead of repeating it.',
    });
  }
}
