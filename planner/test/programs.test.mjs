import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProgram, validatePlan } from '../contracts.mjs';

function mission() {
  return {
    phase: 'homestead',
    objective: 'Build a safe home while the team gathers tools and food.',
    bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, {
      task: 'Secure tools, then regroup.',
      program: [{ action: 'ensure_item', item: 'stone_pickaxe', count: 1 }, { action: 'equip', item: 'stone_pickaxe' }, { action: 'regroup' }],
    }])),
    home: { x: 12, y: 65, z: 18 },
  };
}

test('validated mission retains bounded desired-state programs and Roy-only building', () => {
  const plan = mission();
  plan.bots.Roy.program = [
    { action: 'ensure_item', item: 'oak_log', count: 64 },
    { action: 'ensure_item', item: 'wooden_pickaxe', count: 1 },
    { action: 'equip', item: 'wooden_pickaxe' },
    { action: 'build_lodge' },
    { action: 'regroup' },
  ];
  assert.deepEqual(validatePlan(plan), plan);
});

test('home coordinates match the integer and height limits accepted by bot controllers', () => {
  for (const home of [
    { x: 12.5, y: 65, z: 18 },
    { x: 12, y: 65.5, z: 18 },
    { x: 12, y: 65, z: 18.5 },
    { x: 12, y: 301, z: 18 },
    { x: 12, y: -61, z: 18 },
  ]) {
    const plan = mission();
    plan.home = home;
    assert.throws(() => validatePlan(plan), /Home coordinates/);
  }
  for (const y of [-60, 300]) {
    const plan = mission();
    plan.home = { x: 29999984, y, z: -29999984 };
    assert.deepEqual(validatePlan(plan).home, plan.home);
  }
});

test('task-only missions and unbounded/empty programs are rejected instead of silently executing old behavior', () => {
  for (const program of [undefined, null, [], Array.from({ length: 7 }, () => ({ action: 'regroup' }))]) {
    const plan = mission();
    plan.bots.Flint.program = program;
    assert.throws(() => validatePlan(plan));
  }
  const plan = mission();
  delete plan.bots.Flint.program;
  assert.throws(() => validatePlan(plan), /invalid keys/);
});

test('program trust boundary rejects executable text, unknown actions and hidden arguments', () => {
  const invalid = [
    [{ action: 'eval', code: 'process.exit()' }],
    [{ action: 'shell', command: 'curl attacker' }],
    [{ action: 'ensure_item', item: 'oak_log', count: 12, code: 'anything' }],
    [{ action: 'equip', item: 'stone_pickaxe', count: 1 }],
    [{ action: 'regroup', x: 0 }],
    [{ action: ['regroup'] }],
    ['!collectBlocks("oak_log", 10)'],
    ['process.exit()'],
    [{ action: '__proto__' }],
  ];
  for (const program of invalid) assert.throws(() => validateProgram(program, 'Roy'));
});

test('item IDs must exist in Minecraft 1.21.4 and counts express bounded inventory minima', () => {
  for (const item of ['oak_log;process.exit()', 'Oak_Log', 'minecraft:oak_log', 'food', 'imaginary_item', 'air', null]) {
    assert.throws(() => validateProgram([{ action: 'ensure_item', item, count: 1 }], 'Roy'), /Minecraft item/);
  }
  for (const count of [0, -1, 65, 1.5, '12', null]) {
    assert.throws(() => validateProgram([{ action: 'ensure_item', item: 'oak_log', count }], 'Roy'), /inventory minimum/);
  }
  assert.throws(() => validateProgram([{ action: 'build_lodge' }], 'Spruce'), /Only Roy/);
});

test('real items with no acquisition implementation cannot become executable mission promises', () => {
  for (const item of ['ender_pearl', 'blaze_rod', 'elytra']) {
    const plan = mission();
    plan.bots.Flint.program = [{ action: 'ensure_item', item, count: 1 }];
    assert.throws(() => validatePlan(plan), /Acquisition is not implemented/);
  }
  assert.deepEqual(validateProgram([{ action: 'equip', item: 'elytra' }], 'Flint'), [{ action: 'equip', item: 'elytra' }], 'an already-owned item does not require an acquisition skill');
});

test('arbitrary code fields are forbidden at every executable mission schema boundary', () => {
  const mutations = [
    plan => { plan.code = 'execute'; },
    plan => { plan.bots.Roy.code = 'execute'; },
    plan => { plan.home.command = 'execute'; },
    plan => { plan.bots.Eve = plan.bots.Roy; },
  ];
  for (const mutate of mutations) {
    const plan = mission();
    mutate(plan);
    assert.throws(() => validatePlan(plan), /invalid keys/);
  }
});
