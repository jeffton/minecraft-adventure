import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Vec3 } = require('vec3');
const root = mkdtempSync(join(tmpdir(), 'survival-scheduling-'));
process.env.ADVENTURE_ROOT = root;
const { createObserver } = await import('../runtime.mjs');
mkdirSync(join(root, 'control'));
writeFileSync(join(root, 'control/mission.json'), JSON.stringify({
  id: 'mission-1', phase: 'recovery', objective: 'Earn and equip tools',
  bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, {
    task: 'Prepare tools', program: [{ action: 'ensure_item', item: 'wooden_sword', count: 1 }]
  }]))
}));
const settle = () => new Promise(resolve => setImmediate(resolve));

test('observer retries survival cancellation without model repair; genuine failures keep repair scheduling', async () => {
  for (const kind of ['interrupted', 'navigation', 'precondition', 'execution']) {
    const bot = new EventEmitter();
    bot._client = new EventEmitter();
    bot._client.state = 'play';
    bot.entity = { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0) };
    bot.health = 20; bot.food = 20;
    bot.entities = {};
    bot.game = { dimension: 'overworld' };
    bot.autoEat = { options: { eatingTimeout: 3000 } };
    bot.registry = { blocksByName: {}, biomes: [{ name: 'plains' }] };
    bot.inventory = { items: () => [], slots: [] };
    bot.world = { getBiome: () => 0 };
    bot.findBlocks = () => [];
    bot.blockAt = () => null;
    bot.pathfinder = { isMoving: () => false, isMining: () => false, isBuilding: () => false };
    bot.getControlState = () => false;
    let runs = 0;
    let repairs = 0;
    let observer;
    const agent = { name: 'Roy', bot, isIdle: () => true,
      self_prompter: { isStopped: () => true, isActive: () => false },
      actions: { currentActionLabel: '' },
      handleMessage: async () => { repairs++; } };
    const intervals = new Map();
    const originalInterval = globalThis.setInterval;
    const originalNow = Date.now;
    try {
      globalThis.setInterval = (fn, delay) => { intervals.set(delay, fn); return 999999; };
      observer = createObserver(agent, {
        programMode() {}, cancelChat() {},
        runProgram: async () => {
          runs++;
          await settle();
          observer.emit('attempt_failed', 'Observed failure', { kind });
          observer.emit('error', 'Program: Observed failure');
          return 'Observed failure';
        }
      });
      globalThis.setInterval = originalInterval;
      await settle(); await settle();
      assert.equal(runs, 1);
      if (kind === 'interrupted') {
        bot.entities = { 2: { name: 'zombie', type: 'hostile', position: new Vec3(1, 64, 0) } };
        bot.adventureSafetyActions = 1;
        intervals.get(15000)();
        assert.equal(runs, 1);
        bot.entities = {};
        bot.adventureSafetyActions = 0;
        intervals.get(15000)();
        await settle(); await settle();
        assert.equal(runs, 2);
        assert.equal(repairs, 0);
      } else {
        intervals.get(15000)();
        assert.equal(runs, 1);
        assert.equal(repairs, 0);
        const later = Date.now() + 46000;
        Date.now = () => later;
        intervals.get(15000)();
        await settle();
        assert.equal(repairs, 1);
      }
    } finally {
      globalThis.setInterval = originalInterval;
      Date.now = originalNow;
      bot.emit('end', 'test complete');
    }
  }
});
