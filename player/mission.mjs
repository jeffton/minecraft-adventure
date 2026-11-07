import { randomUUID } from 'node:crypto';

export const PLAYER_OBJECTIVE = 'Find a good place, obtain wool and wood, build a cave shelter for the night, and expand it into a beautiful house. Craft a usable bed from acquired wool and wood and sleep when appropriate.';

export function planningObservation(observation) {
  return {
    ...observation,
    objective: PLAYER_OBJECTIVE,
    decision: observation.controller?.active
      ? 'Evaluate the last mission against its expected outcome and actual evidence. Choose and submit the next finite mission with the current baseVersion, updating useful lessons. Do not finish at a planning boundary without a concrete next mission; repair reusable behavior only for a demonstrated defect.'
      : 'Choose and submit the first finite survival mission from these observations with baseVersion:null. State an observable expected outcome and use the mission tool; do not write a universal decision tree.',
  };
}

/** One strategic episode. Skills do the work; the model chooses the next approach. */
export function missionController({ objective, expectedOutcome, code, input = {} }) {
  if (!objective?.trim() || !expectedOutcome?.trim()) throw new Error('A mission requires an objective and observable expected outcome');
  const mission = { id: randomUUID(), objective, expectedOutcome };
  return `export async function decide(observation, state, lastResult) {
  const mission = ${JSON.stringify(mission)};
  const next = { ...state };
  if (next.mission?.id !== mission.id) {
    next.mission = { ...mission, session: observation.session, life: observation.life, startedAt: observation.at };
    return { state: next, action: { name: mission.objective, code: ${JSON.stringify(code)}, input: ${JSON.stringify(input)} } };
  }
  const interrupted = next.mission.session !== observation.session || next.mission.life !== observation.life;
  // Full returned query data already lives in action history and the current
  // action feedback. Keep an outcome receipt, not another copy of world sensors.
  const { value, ...receipt } = lastResult || {};
  next.mission.outcome = interrupted ? { interrupted: true, reason: 'Session or life changed; reassess the mission from fresh evidence.' } : receipt;
  return { state: next, action: null, replan: true, reason: interrupted ? 'Reassess interrupted mission' : 'Evaluate mission outcome and choose the next concrete approach' };
}
`;
}

export const MISSION_INSTRUCTIONS = `David's selected objective: ${PLAYER_OBJECTIVE}
This objective takes precedence over older goals in remembered notes or controller history. Choose the site, order of work, materials and design yourself from actual conditions. Clock, sunrise/sunset and weather are facts for your planning, not a host-enforced curfew or shelter policy.
You are Roy's Minecraft strategist and skill author, not a code maintenance bot. Choose the next achievable objective from current server facts, real POV images, compact outcome history and remembered lessons. Use mission to submit a purposeful skill script and an observable expected outcome. It runs ONCE (within the existing 120-second sandbox deadline); after completion, failure or interruption you receive fresh evidence and choose the next mission. Useful scripts may perform multiple related operations with fresh observations, actual postcondition checks and clear exits. They should do real work, not merely probe forever. Return a structured result explaining what was achieved, what blocked it and the useful new facts. The host verifies inventory, health and position independently; completed execution does not mean the objective was achieved.
Before every next mission compare the previous objective/expected outcome with actual results, identify why an approach failed, and change the approach rather than repeating an unsuccessful script or nearby waypoints. Navigation should use the pathfinder toward a coherent reachable destination, not a hand-coded three-block steering loop. Use terrain observations and received-world queries; never invent resource coordinates or inspect a world seed. If walking cannot reach a goal, inspect the actual obstruction and deliberately solve it (safe digging, stepping, alternate route) rather than doing the same short step back and forth. Do not dig footing or blindly open water/lava. Preserve survival reflex ownership, actual inventory and useful world structures. A missing log or tool is a concrete prerequisite, not a reason to freeze indefinitely. Plan survival, food and tools as prerequisites for the selected building objective; retain useful materials and expand the chosen base rather than mistaking repeated emergency shelters for a growing home.
Keep remember notes current: current objective, verified discoveries, failed approaches with reasons, and the next useful opportunity. Old notes and generated controller state are historical claims; fresh observations take precedence. Full action_inspect and read_events evidence remains available on demand. Do not reload all old history or repeat successful skills' source in notes. The existing controller_candidate/edit tools remain available for a genuinely reusable local behavior, but do not rebuild a universal Minecraft decision tree: prefer finite missions so intelligence keeps choosing what happens next. Never treat movement, waits, scans or returned success text as material progress. Ordinary action completion triggers planning, not another speculative code patch. Use the current baseVersion and ship a mission rather than narrating a plan.`;
