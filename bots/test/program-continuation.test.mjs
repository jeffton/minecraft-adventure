import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { executeProgram } from '../program.mjs';
import { canStartRepairAction } from '../repair.mjs';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Vec3 } = require('vec3');
const root = mkdtempSync(join(tmpdir(), 'program-continuation-'));
process.env.ADVENTURE_ROOT = root;
const { createObserver } = await import('../runtime.mjs');
mkdirSync(join(root, 'control'));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture({ fail = false, hold = false } = {}) {
    const mission = {
        id: 'mission-1', phase: 'equipment', objective: 'Prepare useful earned equipment',
        bots: Object.fromEntries(['Roy', 'Spruce', 'Flint', 'Moss'].map(name => [name, {
            task: 'Equip tool, then weapon', program: [{ action: 'equip', item: 'stone_pickaxe' }],
            nextProgram: [{ action: 'equip', item: 'stone_sword' }]
        }]))
    };
    const save = () => writeFileSync(join(root, 'control/mission.json'), JSON.stringify(mission));
    save();
    const bot = new EventEmitter();
    bot._client = new EventEmitter();
    bot._client.state = 'play';
    bot.entity = { position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0) };
    bot.username = 'Roy';
    bot.health = 20; bot.food = 20; bot.entities = {};
    bot.game = { dimension: 'overworld', gameMode: 'survival' };
    bot.modes = { isOn: () => false };
    bot.autoEat = { options: { eatingTimeout: 3000 } };
    const items = ['stone_pickaxe', 'stone_sword'].map((name, id) => ({ name, id, count: 1 }));
    bot.registry = { blocksByName: {}, biomes: [{ name: 'plains' }], itemsByName: Object.fromEntries(items.map(item => [item.name, item])) };
    bot.inventory = { items: () => items, slots: items };
    bot.world = { getBiome: () => 0 };
    bot.findBlocks = () => [];
    bot.blockAt = () => null;
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    let held = false;
    bot._syncWindow = async () => {
        if (hold && !held) {
            held = true;
            await new Promise(resolve => { release = resolve; readyResolve(); });
        }
    };
    bot.pathfinder = { isMoving: () => false, isMining: () => false, isBuilding: () => false, setGoal() {} };
    bot.clearControlStates = () => {};
    bot.getControlState = () => false;
    const runs = [], equips = [], repairPrompts = [];
    let release;
    let repairRelease;
    let repairAllowed;
    let observer;
    const agent = {
        name: 'Roy', bot, isIdle: () => true,
        self_prompter: { isStopped: () => true, isActive: () => false },
        actions: { currentActionLabel: '' },
        handleMessage: async (_, prompt) => {
            repairPrompts.push(prompt);
            await new Promise(resolve => { repairRelease = resolve; });
            repairAllowed = canStartRepairAction(agent);
            return true;
        }
    };
    const intervals = new Map();
    const originalInterval = globalThis.setInterval;
    globalThis.setInterval = (fn, delay) => { intervals.set(delay, fn); return 999999; };
    try {
        observer = createObserver(agent, {
            programMode() {}, cancelChat() {},
            runProgram: async () => {
                runs.push([mission.id, agent.adventureProgram.stage]);
                return executeProgram(agent, {
                    log() {}, equip: async (_, item) => {
                        if (fail === true || (fail === 'continuation' && agent.adventureProgram.stage === 1)) throw new Error('Equipment failed');
                        equips.push(item); bot.heldItem = items.find(owned => owned.name === item);
                    }
                }, { getMission: () => JSON.parse(readFileSync(join(root, 'control/mission.json'))), getHome: () => null,
                    emit: (_, type, message, data) => observer.emit(type, message, data) });
            }
        });
    } finally { globalThis.setInterval = originalInterval; }
    return {
        bot, agent, observer, runs, equips, repairPrompts, mission, save, ready,
        tick: () => intervals.get(1000)(), release: () => release(),
        releaseRepair: () => repairRelease(), repairAllowed: () => repairAllowed,
        observation: () => { observer.publish(); return JSON.parse(readFileSync(join(root, 'observations/Roy.json'))); },
        close: () => bot.emit('end')
    };
}

test('successful runtime work starts one queued program on next tick without a new mission or model response', async () => {
    const t = fixture();
    let reviewFinished = false;
    const review = new Promise(resolve => { t.finishReview = () => { reviewFinished = true; resolve(); }; });
    try {
        await settle();
        assert.deepEqual(t.equips, ['stone_pickaxe']);
        assert.equal(t.agent.adventureProgram.stage, 1);
        t.tick();
        await settle();
        assert.deepEqual(t.runs, [['mission-1', 0], ['mission-1', 1]]);
        assert.deepEqual(t.equips, ['stone_pickaxe', 'stone_sword']);
        assert.equal(reviewFinished, false);
        assert.equal(t.observation().programStage, 1);
        const attempts = t.observation().events.filter(event => event.type === 'attempt_completed');
        assert.deepEqual(attempts.map(event => [event.data.missionId, event.data.stage]), [['mission-1', 0], ['mission-1', 1]]);
        for (let i = 0; i < 3; i++) { t.tick(); await settle(); }
        assert.equal(t.runs.length, 2, 'continuation never loops');
    } finally { t.finishReview(); await review; t.close(); }
});

test('failed work does not advance; repair tokens expire on stage changes', async () => {
    const t = fixture({ fail: true });
    try {
        await settle();
        assert.equal(t.agent.adventureProgram.stage, 0);
        t.tick();
        await settle();
        t.agent.adventureProgram.stage = 1;
        t.releaseRepair();
        await settle();
        assert.equal(t.repairAllowed(), false);
        assert.equal(t.runs.length, 1);
    } finally { t.close(); }
});

test('continuation failure repairs its actual error, not the previous completed stage', async () => {
    const t = fixture({ fail: 'continuation' });
    try {
        await settle();
        t.tick();
        await settle();
        t.tick();
        await settle();
        assert.match(t.repairPrompts[0], /Shared program is blocked: Equipment failed/);
        assert.doesNotMatch(t.repairPrompts[0], /completed .* observed steps/);
        t.releaseRepair();
        await settle();
        assert.equal(t.runs.length, 2);
    } finally { t.close(); }
});

test('stage freshness fences pending operations before the next stage can act', async () => {
    const t = fixture({ hold: true });
    try {
        await t.ready;
        t.agent.adventureProgram.stage = 1;
        t.release();
        await settle();
        assert.deepEqual(t.equips, []);
        assert.equal(t.runs.length, 1);
    } finally { t.close(); }
});

test('death discards queued progress, and an old-life completion cannot advance', async () => {
    const t = fixture({ hold: true });
    try {
        await t.ready;
        t.bot.emit('death');
        assert.equal(t.agent.adventureProgram.stage, 0);
        t.release();
        await settle();
        assert.equal(t.agent.adventureProgram.stage, 0);
        assert.equal(t.runs.length, 1);
        assert.deepEqual(t.equips, [], 'old life cannot act after its inventory await');
        t.bot.emit('respawn');
        assert.equal(t.agent.adventureProgram.stage, 0);
    } finally { t.close(); }
});

test('a new mission discards continuation and fences old asynchronous results', async () => {
    const t = fixture({ hold: true });
    try {
        await t.ready;
        t.mission.id = 'mission-2';
        t.save();
        t.tick();
        t.release();
        await settle();
        assert.equal(t.agent.adventureProgram.stage, 0);
        assert.deepEqual(t.equips, [], 'replaced mission cannot equip after its inventory await');
        t.tick();
        assert.deepEqual(t.runs, [['mission-1', 0], ['mission-2', 0]]);
        t.release();
        await settle();
    } finally { t.close(); }
});
