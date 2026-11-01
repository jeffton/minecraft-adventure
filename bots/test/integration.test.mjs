import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { viewerAllowed } from '../viewer-policy.mjs';

process.env.ADVENTURE_ROOT = mkdtempSync(join(tmpdir(), 'roy-minecraft-integration-'));
const { setProgramMode } = await import('../bootstrap.mjs');
const { Prompter } = await import('/opt/minecraft-mindcraft/src/models/prompter.js');
const { createObserver, CONTROL, atomicJson } = await import('../runtime.mjs');
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Vec3 } = require('vec3');

test('model response already received cannot execute after a program takes ownership during log save', async () => {
  let logStarted;
  const entered = new Promise(resolve => { logStarted = resolve; });
  let releaseLog;
  const logGate = new Promise(resolve => { releaseLog = resolve; });
  const prompter = Object.assign(Object.create(Prompter.prototype), {
    agent: { name: 'Roy' }, profile: { conversing: 'Return one command.' }, cooldown: 0,
    chat_model: { sendRequest: async () => '!collectBlocks("oak_log", 1)' },
    _saveLog: async () => { logStarted(); await logGate; }
  });
  setProgramMode('Roy', false);
  const pending = prompter.promptConvo([]);
  await entered;
  setProgramMode('Roy', true);
  releaseLog();
  assert.equal(await pending, '', 'the stale command is withheld at the final handoff');
  setProgramMode('Roy', false);
});

test('a published program starts locally and rechecks dropped prerequisites after respawn', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  mkdirSync(CONTROL, { recursive: true });
  atomicJson(join(CONTROL, 'mission.json'), { id: 'observed-program-1', phase: 'survival', objective: 'Earn supplies', home: null,
    bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, { task: 'Gather supplies', program: [{ action: 'ensure_item', item: 'oak_log', count: 1 }] }])) });
  let localRuns = 0;
  let chatStarts = 0;
  const bot = Object.assign(new EventEmitter(), {
    _client: { state: 'play' }, entity: { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true },
    pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false }, getControlState: () => false, game: { dimension: 'overworld' }, health: 20, food: 20,
    inventory: { items: () => [] }, entities: {}, registry: { blocksByName: {}, biomes: { 0: { name: 'plains' } } },
    world: { getBiome: () => 0 }, findBlocks: () => [], blockAt: () => null
  });
  const agent = { name: 'Roy', bot, isIdle: () => true, actions: { currentActionLabel: '' },
    self_prompter: { prompt: '', isStopped: () => true, isActive: () => false, start: () => chatStarts++ } };
  const observer = createObserver(agent, { programMode() {}, cancelChat() {}, runProgram: async () => { localRuns++; return 'Program completed'; } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(localRuns, 1);
    assert.equal(chatStarts, 0);
    bot.food = 0;
    for (let index = 0; index < 5; index++) bot.emit('autoeat_error', new Error('No food found.'));
    observer.publish();
    const observed = JSON.parse(readFileSync(join(process.env.ADVENTURE_ROOT, 'observations', 'Roy.json'), 'utf8'));
    assert.equal(observed.error, null, 'missing food must not invalidate a successful preparation action');
    assert.equal(observed.events.filter(event => event.type === 'food').length, 1);
    bot.food = 2;
    bot.emit('autoeat_finished', { name: 'mutton' });
    bot.emit('autoeat_error', new Error('No food found.'));
    observer.publish();
    const afterMeal = JSON.parse(readFileSync(join(process.env.ADVENTURE_ROOT, 'observations', 'Roy.json'), 'utf8'));
    assert.equal(afterMeal.events.filter(event => event.type === 'food').length, 2, 'a meal resets missing-food reporting');
    const errors = t.mock.method(console, 'error', () => {});
    bot.emit('autoeat_error', new Error('Consume rejected'));
    observer.publish();
    const failedEating = JSON.parse(readFileSync(join(process.env.ADVENTURE_ROOT, 'observations', 'Roy.json'), 'utf8'));
    assert.equal(failedEating.error, 'Consume rejected');
    assert.equal(errors.mock.calls.length, 1);
    errors.mock.restore();
    bot.emit('death');
    bot.emit('respawn');
    t.mock.timers.tick(15000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(localRuns, 2, 'the same mission must reacquire prerequisites lost at death');
    assert.equal(chatStarts, 0);
  } finally { bot.emit('end', 'test finished'); }
});

test('eight public viewers cannot consume the reserved local diary capture slot', () => {
  const fullPublic = Array(8).fill(true);
  assert.equal(viewerAllowed(true, fullPublic), false);
  assert.equal(viewerAllowed(false, fullPublic), true);
  assert.equal(viewerAllowed(false, [...fullPublic, false]), false);
  assert.equal(viewerAllowed(true, [false, ...Array(7).fill(true)]), true);
});
