import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { RepairScheduler, canExecuteRepair, canStartRepairAction, patchRepairCommands, repairIsCurrent, runRepair } from '../repair.mjs';
import { withSafetyAction } from '../survival.mjs';
import { ActionManager } from '/opt/minecraft-mindcraft/src/agent/action_manager.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let mission = 'mission-1';
  let time = 0;
  let cancellations = 0;
  const agent = {
    bot: { health: 20, modes: { pause() {}, unpause() {} }, interrupt_code: false, output: '' },
    isIdle() { return !this.actions.executing; },
    clearBotLogs() { this.bot.output = ''; this.bot.interrupt_code = false; },
  };
  agent.actions = new ActionManager(agent);
  agent.bot.emit = () => {};
  const scheduler = new RepairScheduler({ agent, session: 'session-1', missionId: () => mission,
    cancel: () => { cancellations++; }, now: () => time });
  return { agent, scheduler, setMission: value => { mission = value; },
    setTime: value => { time = value; }, cancellations: () => cancellations };
}

// Exercise the deployed upstream dispatcher with the actual loader patch,
// including commands such as !stop that do not call ActionManager at all.
const commandSource = readFileSync('/opt/minecraft-mindcraft/src/agent/commands/index.js', 'utf8');
const patched = patchRepairCommands(commandSource, '../repair.mjs');
const dispatchSource = patched.slice(patched.indexOf('export async function executeCommand('),
  patched.indexOf('export function getCommandDocs(')).replace('export ', '');
function dispatcher(perform) {
  return vm.runInNewContext(`(${dispatchSource})`, {
    canExecuteRepair,
    parseCommandMessage: () => ({ commandName: '!stop', args: [] }),
    getCommand: () => ({ perform }), numParams: () => 0, console: { log() {} },
  });
}

// Use the actual bootstrap hook around upstream ActionManager, without starting
// a Mineflayer connection or importing its model credentials/settings.
const bootstrap = readFileSync(new URL('../bootstrap.mjs', import.meta.url), 'utf8');
const hook = bootstrap.slice(bootstrap.indexOf('ActionManager.prototype.runAction = function'),
  bootstrap.indexOf("const { Prompter }"));
class GuardedActionManager extends ActionManager {}
vm.runInNewContext(hook, { ActionManager: GuardedActionManager,
  originalRunAction: ActionManager.prototype.runAction, canExecuteRepair, canStartRepairAction, withSafetyAction, Promise });

test('new failures are immediate; identical failures back off and changed prerequisites can repair', () => {
  const f = fixture();
  const first = f.scheduler.begin('mission-1', 'no wood');
  assert.ok(first);
  assert.equal(f.scheduler.begin('mission-1', 'no wood'), null);
  f.scheduler.finish(first);
  for (let tick = 0; tick < 45; tick++) {
    f.setTime(tick * 1000);
    assert.equal(f.scheduler.begin('mission-1', 'no wood'), null);
  }
  f.setTime(45000);
  const repeated = f.scheduler.begin('mission-1', 'no wood');
  assert.ok(repeated);
  f.scheduler.finish(repeated);
  assert.ok(f.scheduler.begin('mission-1', 'no cobblestone'));
});

test('repair requires idle and survival-safe state', () => {
  const f = fixture();
  f.agent.actions.executing = true;
  assert.equal(f.scheduler.begin('mission-1', 'failure'), null);
  f.agent.actions.executing = false;
  f.agent.bot.adventureSafetyActions = 1;
  assert.equal(f.scheduler.begin('mission-1', 'failure'), null);
  f.agent.bot.adventureSafetyActions = 0;
  assert.ok(f.scheduler.begin('mission-1', 'failure'));
});

for (const change of ['mission', 'death', 'respawn']) {
  test(`late model command cannot execute after ${change}, even after its HTTP response arrived`, async () => {
    const f = fixture();
    const token = f.scheduler.begin('mission-1', 'failure');
    const responseSaved = deferred();
    let commands = 0;
    const dispatch = dispatcher(async () => { commands++; });
    const reply = runRepair(token, async () => {
      // The inference finished, but async history/log writing has not.
      await responseSaved.promise;
      await dispatch(f.agent, '!stop');
    });
    if (change === 'mission') f.setMission('mission-2'); // No timer has noticed yet.
    else { f.scheduler.invalidate(); if (change === 'death') f.agent.bot.health = 0; }
    responseSaved.resolve();
    await reply;
    assert.equal(commands, 0);
  });
}

test('old repair finally cannot clear ownership of its replacement', () => {
  const f = fixture();
  const old = f.scheduler.begin('mission-1', 'old failure');
  f.scheduler.invalidate();
  f.setMission('mission-2');
  const current = f.scheduler.begin('mission-2', 'new failure');
  assert.equal(f.scheduler.finish(old), false);
  assert.equal(f.scheduler.active, current);
  assert.equal(current.isCurrent(), true);
  assert.equal(f.cancellations(), 1);
});

test('local reflexes execute during slow Terra inference; its reply cannot interrupt them', async () => {
  const f = fixture();
  f.agent.actions = new GuardedActionManager(f.agent);
  const token = f.scheduler.begin('mission-1', 'failure');
  const model = deferred();
  const safety = deferred();
  let commands = 0;
  const inference = runRepair(token, async () => {
    await model.promise;
    await dispatcher(async () => { commands++; })(f.agent, '!stop');
    const result = await f.agent.actions.runAction('action:collectBlocks', async () => { commands++; });
    assert.equal(result.interrupted, true);
  });
  const fleeing = f.agent.actions.runAction('mode:cowardice', async () => { await safety.promise; });
  await settle();
  assert.equal(f.agent.bot.adventureSafetyActions, 1);
  model.resolve();
  await inference;
  assert.equal(commands, 0);
  assert.equal(f.agent.actions.currentActionLabel, 'mode:cowardice');
  safety.resolve();
  await fleeing;
  assert.equal(f.agent.bot.adventureSafetyActions, 0);
});

test('slow global planning does not interfere with an existing local program', async () => {
  const f = fixture();
  f.agent.actions = new GuardedActionManager(f.agent);
  const model = deferred();
  const work = deferred();
  let gathered = 0;
  const planning = model.promise.then(() => { f.setMission('mission-2'); });
  const program = f.agent.actions.runAction('adventure:runProgram', async () => {
    await work.promise;
    gathered++;
  });
  await settle();
  assert.equal(f.agent.actions.currentActionLabel, 'adventure:runProgram');
  assert.equal(f.scheduler.begin('mission-1', 'failure'), null);
  model.resolve();
  await planning;
  assert.equal(f.agent.actions.currentActionLabel, 'adventure:runProgram');
  work.resolve();
  await program;
  assert.equal(gathered, 1);
});

test('action setup cannot bypass the guard if a new action began since command dispatch', async () => {
  const f = fixture();
  f.agent.actions = new GuardedActionManager(f.agent);
  const token = f.scheduler.begin('mission-1', 'failure');
  let executed = 0;
  await runRepair(token, async () => {
    assert.equal(canExecuteRepair(f.agent), true);
    f.agent.actions.executing = true;
    f.agent.actions.currentActionLabel = 'adventure:runProgram';
    const result = await f.agent.actions.runAction('action:collectBlocks', async () => { executed++; });
    assert.equal(result.interrupted, true);
    assert.equal(f.agent.actions.currentActionLabel, 'adventure:runProgram');
  });
  assert.equal(executed, 0);
});

for (const label of ['action:collectBlocks', 'adventure:runProgram']) {
  test(`invalidation during upstream stop await prevents ${label} from starting`, async () => {
    const f = fixture();
    f.agent.actions = new GuardedActionManager(f.agent);
    const token = f.scheduler.begin('mission-1', 'failure');
    let executed = 0;
    const action = runRepair(token, () => f.agent.actions.runAction(label, async () => { executed++; }));
    f.scheduler.invalidate();
    await action;
    assert.equal(executed, 0);
  });
}

test('a valid repair still starts after ActionManager has marked it executing', async () => {
  const f = fixture();
  f.agent.actions = new GuardedActionManager(f.agent);
  const token = f.scheduler.begin('mission-1', 'failure');
  let executed = 0;
  await runRepair(token, () => f.agent.actions.runAction('action:collectBlocks', async () => { executed++; }));
  assert.equal(executed, 1);
});

test('ownership stays scoped to the exact repair across awaits', async () => {
  const f = fixture();
  const token = f.scheduler.begin('mission-1', 'failure');
  await runRepair(token, async () => {
    await settle();
    assert.equal(repairIsCurrent(), true);
    f.scheduler.invalidate();
    assert.equal(repairIsCurrent(), false);
  });
  assert.equal(canExecuteRepair(f.agent), true, 'unrelated local work is not blocked');
});
