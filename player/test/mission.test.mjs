import test from 'node:test';
import assert from 'node:assert/strict';
import { missionController, planningObservation } from '../mission.mjs';
import { validateControllerResult } from '../controller.mjs';
import { ControllerLoop } from '../controller-loop.mjs';

test('the actual strategic payload requests a next mission and retains prior expected/actual evidence', () => {
  const prior = { controller: { active: { version: 'previous' }, state: { mission: { expectedOutcome: 'logs', outcome: { error: 'No path' } } } }, baseVersion: 'previous' };
  const payload = planningObservation(prior);
  assert.deepEqual(payload.controller.state.mission, prior.controller.state.mission);
  assert.equal(payload.baseVersion, 'previous');
  assert.match(payload.decision, /next finite mission/);
  assert.doesNotMatch(payload.decision, /otherwise finish|without further model requests/);
  assert.match(planningObservation({ controller: { active: null } }).decision, /first finite survival mission/);
});

const observation = { worldId: 'test-world', session: 'first', life: 0, at: '2026-11-07T08:00:00Z' };
const makeMission = async () => import(`data:text/javascript,${encodeURIComponent(missionController({
  objective: 'Collect reachable timber', expectedOutcome: 'Inventory contains oak_log',
  code: 'return await mc.call("harvest", input.tree);', input: { tree: { x: 1, y: 64, z: 2 } },
}))}`);

test('a strategic mission executes once then returns actual failure to planning instead of repeating', async () => {
  const { decide } = await makeMission();
  const first = await decide(observation, { discoveries: ['observed tree'] }, null);
  const failure = { id: 'action-id', state: 'failed', error: 'No path to tree', effects: { inventoryDelta: {} }, value: { blocks: Array(100).fill({ name: 'stone' }) } };
  const second = validateControllerResult(await decide(observation, first.state, failure), 'test-world');
  assert.equal(first.action.name, 'Collect reachable timber');
  assert.equal(second.action, null);
  assert.equal(second.replan, true);
  const { value, ...receipt } = failure;
  assert.deepEqual(second.state.mission.outcome, receipt);
  assert.deepEqual(second.state.discoveries, ['observed tree']);
  assert.equal((await decide(observation, second.state, failure)).action, null);
});

test('a life/session interruption reassesses instead of resuming an old mission with stale assumptions', async () => {
  const { decide } = await makeMission();
  const first = await decide(observation, {}, null);
  const resumed = await decide({ ...observation, session: 'reconnected' }, first.state, null);
  assert.equal(resumed.action, null);
  assert.equal(resumed.replan, true);
  assert.equal(resumed.state.mission.outcome.interrupted, true);
});

test('a planning boundary wakes the strategist once and parks until a new mission arrives', async () => {
  const events = [];
  let decisions = 0;
  const loop = new ControllerLoop({
    controller: {
      current: () => ({ version: 'mission-one' }),
      decide: async () => { decisions++; return { action: null, reason: 'No path', replan: true }; },
    },
    pipeline: { current: () => null },
    context: () => ({ ...observation, health: 20 }),
    observe: () => ({ inventory: [], blocks: [], entities: [] }),
    onEvent: (...event) => events.push(event),
  });
  await loop.tick();
  await loop.tick(Date.now() + 60000);
  assert.equal(decisions, 1);
  assert.equal(events[0][0], 'controller_replan');
  loop.stage({ version: 'next-mission' });
  assert.equal(loop.nextAt, 0);
});
