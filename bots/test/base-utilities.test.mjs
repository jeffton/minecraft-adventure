import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createBaseUtilities } from '../base-utilities.mjs';
import { executeProgram, createBaseContext, validateProgram } from '../program.mjs';
import { validateProgram as validatePlannerProgram } from '../../planner/contracts.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Vec3 } = require('vec3');
const home = { x: 0, y: 64, z: 0, dimension: 'overworld' };
const site = { x: 1, y: 64, z: 7 };
const id = p => `${p.x},${p.y},${p.z}`;

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'base-utility-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const utilities = createBaseUtilities({ lockDirectory: directory });
    const blocks = new Map();
    function put(p, name, properties = {}) {
        const block = { name, type: name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => properties };
        blocks.set(id(p), block);
        return block;
    }
    const bot = new EventEmitter();
    let items = [{ name: 'chest', count: 2 }, { name: 'white_bed', count: 1 }, { name: 'oak_planks', count: 20 }];
    let containerItems = [{ name: 'oak_planks', count: 5 }];
    const calls = [];
    const context = { check() {}, async run(operation) { this.check(); const result = await operation(); this.check(); return result; } };
    Object.assign(bot, {
        username: 'Roy', game: { dimension: 'overworld', gameMode: 'survival' }, health: 20, food: 20,
        clearControlStates() {},
        end(reason) { calls.push(['disconnect', reason]); },
        registry: require('minecraft-data')('1.21.4'),
        entity: { position: new Vec3(1, 64, 5) },
        inventory: { items: () => items, get slots() { return [...Array(9).fill(null), ...items, ...Array(34).fill(null)]; }, selectedItem: null },
        blockAt: p => blocks.get(id(p)) ?? { name: 'air', type: 'air', position: p, boundingBox: 'empty', getProperties: () => ({}) },
        canSeeBlock: () => true,
        pathfinder: {
            setGoal() {},
            setMovements(movements) { assert.equal(movements.canDig, false); assert.deepEqual(movements.scafoldingBlocks, []); },
            async goto(goal) { bot.entity.position = new Vec3(goal.x, goal.y, goal.z - 1); }
        },
        async _syncWindow(window) { calls.push('sync'); assert.equal(window, bot.currentWindow || bot.inventory); },
        async equip(item) { bot.heldItem = item; },
        async look(yaw) { calls.push(['yaw', yaw]); },
        async placeBlock(reference, face) {
            const p = reference.position.plus(face);
            put(p, bot.heldItem.name, bot.heldItem.name === 'chest' ? { type: 'single' } : {});
            bot.heldItem.count--;
        },
        async _placeBlockWithOptions(reference, face, options) {
            assert.equal(options.forceLook, 'ignore');
            const p = reference.position.plus(face);
            put(p, 'white_bed', { part: 'foot', facing: 'north' });
            put(p.offset(0, 0, -1), 'white_bed', { part: 'head', facing: 'north' });
            bot.heldItem.count--;
        },
        async activateBlock() {},
        async openChest() {
            calls.push('open');
            const window = {
                inventoryStart: 27, inventoryEnd: 63, selectedItem: null,
                get slots() { return [...Array(27).fill(null), ...items, ...Array(33).fill(null)]; },
                containerItems: () => containerItems,
                async deposit(type, metadata, amount) {
                    assert.equal(type, bot.registry.itemsByName.oak_planks.id); assert.equal(metadata, null);
                    calls.push('deposit');
                    items.find(i => i.name === 'oak_planks').count -= amount;
                    containerItems[0].count += amount;
                },
                async withdraw(type, metadata, amount) {
                    calls.push('withdraw');
                    items.find(i => i.name === 'oak_planks').count += amount;
                    containerItems[0].count -= amount;
                },
                async close() { calls.push('close'); bot.currentWindow = null; }
            };
            bot.currentWindow = window;
            return window;
        }
    });
    put({ x: 1, y: 63, z: 7 }, 'oak_planks');
    put({ x: 1, y: 63, z: 6 }, 'oak_planks');
    return { utilities, bot, context, put, items, calls, directory };
}

test('earned chest placement and exact authoritative deposit/withdraw observations', async t => {
    const f = await fixture(t);
    const placed = await f.utilities.ensureChest(f.bot, home, site, f.context);
    assert.deepEqual([placed.before, placed.after], [2, 1]);
    const deposit = await f.utilities.transferChest(f.bot, home, site, { direction: 'deposit', item: 'oak_planks', count: 7 }, f.context);
    assert.deepEqual([deposit.before.inventory, deposit.after.inventory, deposit.before.container, deposit.after.container], [20, 13, 5, 12]);
    assert.deepEqual(deposit.after.containerItems, [{ name: 'oak_planks', count: 12 }]);
    const withdrawn = await f.utilities.transferChest(f.bot, home, site, { direction: 'withdraw', item: 'oak_planks', count: 3 }, f.context);
    assert.equal(withdrawn.after.inventory, 16);
    assert.equal(withdrawn.after.container, 9);
    assert.deepEqual(f.calls.filter(c => typeof c === 'string').slice(-5), ['open', 'sync', 'withdraw', 'sync', 'close']);
});

test('program stages have distinct transfer receipts while retries within each stage are idempotent', async t => {
    const f = await fixture(t);
    f.put(site, 'chest', { type: 'single' });
    const previousRoot = process.env.ADVENTURE_ROOT;
    process.env.ADVENTURE_ROOT = f.directory;
    const step = { action: 'deposit', ...site, item: 'oak_planks', count: 3 };
    const mission = { id: 'stage-transfer', bots: { Roy: { program: [step], nextProgram: [step] } } };
    const agent = { name: 'Roy', bot: f.bot, adventureProgram: { missionId: mission.id, stage: 0, life: 0 } };
    const run = () => executeProgram(agent, { log() {} }, {
        getMission: () => mission, getHome: () => home,
        navigateHome: async () => { f.bot.entity.position = new Vec3(home.x, home.y, home.z); }
    });
    try {
        // Simulate a confirmed stage-0 transfer from the runtime before this feature.
        // A deploy/restart of that same mission must still recognize its receipt.
        const canonical = createBaseUtilities({ lockDirectory: join(f.directory, 'control', 'base-utilities') });
        await canonical.transferChest(f.bot, home, site, {
            direction: 'deposit', item: 'oak_planks', count: 3,
            receiptKey: JSON.stringify([mission.id, agent.name, 0, step])
        }, f.context);
        await run();
        await run();
        assert.equal(f.items.find(item => item.name === 'oak_planks').count, 17);
        agent.adventureProgram.stage = 1;
        await run();
        await run();
        assert.equal(f.items.find(item => item.name === 'oak_planks').count, 14);
        assert.equal(f.calls.filter(call => call === 'deposit').length, 2);
    } finally {
        if (previousRoot === undefined) delete process.env.ADVENTURE_ROOT;
        else process.env.ADVENTURE_ROOT = previousRoot;
    }
});

test('same-chest lock excludes another bot/process until window closes', async t => {
    const f = await fixture(t);
    f.put(site, 'chest', { type: 'single' });
    let release;
    const open = f.bot.openChest;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.bot.openChest = async () => { entered(); await new Promise(resolve => { release = resolve; }); return open(); };
    const pending = f.utilities.transferChest(f.bot, home, site, { direction: 'deposit', item: 'oak_planks', count: 1 }, f.context);
    await started;
    const second = createBaseUtilities({ lockDirectory: f.directory });
    await assert.rejects(second.ensureChest(f.bot, home, site, f.context), /busy/);
    release();
    await pending;
    assert.equal((await second.ensureChest(f.bot, home, site, f.context)).placed, false);
});

test('overlapping chest placement footprints cannot race into a double chest', async t => {
    const f = await fixture(t);
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const goto = f.bot.pathfinder.goto;
    f.bot.pathfinder.goto = async goal => { entered(); await new Promise(resolve => { release = resolve; }); await goto(goal); };
    const pending = f.utilities.ensureChest(f.bot, home, site, f.context);
    await started;
    const second = createBaseUtilities({ lockDirectory: f.directory });
    await assert.rejects(second.ensureChest(f.bot, home, { ...site, x: site.x + 1 }, f.context), /busy/);
    release();
    await pending;
    assert.equal(f.items.find(i => i.name === 'chest').count, 1);
    await assert.rejects(second.ensureChest(f.bot, home, { ...site, x: site.x + 1 }, f.context), /non-chest neighbors/);
});

test('cancellation immediately after server window-open still closes before releasing the lock', async t => {
    const f = await fixture(t);
    f.put(site, 'chest', { type: 'single' });
    let cancelled = false;
    const open = f.bot.openChest;
    f.bot.openChest = async () => { const window = await open(); cancelled = true; return window; };
    f.context.check = () => { if (cancelled) throw new Error('Mission changed after opening'); };
    await assert.rejects(f.utilities.transferChest(f.bot, home, site, { direction: 'deposit', item: 'oak_planks', count: 2 }, f.context), /Mission changed/);
    assert.equal(f.bot.currentWindow, null);
    assert.equal(f.calls.at(-1), 'close');
    cancelled = false;
    await f.utilities.ensureChest(f.bot, home, site, f.context);
});

test('a no-op transfer cannot be reported as resource preservation and closes the window', async t => {
    const f = await fixture(t);
    f.put(site, 'chest', { type: 'single' });
    const open = f.bot.openChest;
    f.bot.openChest = async () => { const window = await open(); window.deposit = async () => {}; return window; };
    await assert.rejects(f.utilities.transferChest(f.bot, home, site, { direction: 'deposit', item: 'oak_planks', count: 2 }, f.context), /counts do not confirm/);
    assert.equal(f.bot.currentWindow, null);
    await f.utilities.ensureChest(f.bot, home, site, f.context);
});

test('refuses double containers, foreign obstruction, missing items, and unloaded target', async t => {
    const f = await fixture(t);
    f.put(site, 'chest', { type: 'left' });
    await assert.rejects(f.utilities.ensureChest(f.bot, home, site, f.context), /single/);
    f.put(site, 'furnace');
    await assert.rejects(f.utilities.ensureChest(f.bot, home, site, f.context), /obstructed/);
    f.put(site, 'air');
    f.items.find(i => i.name === 'chest').count = 0;
    await assert.rejects(f.utilities.ensureChest(f.bot, home, site, f.context), /earned chest/);
    f.bot.blockAt = () => null;
    await assert.rejects(f.utilities.ensureChest(f.bot, home, site, f.context), /not loaded/);
});

test('mission cancellation during navigation prevents opening or placing', async t => {
    const f = await fixture(t);
    let cancelled = false;
    f.context.check = () => { if (cancelled) throw new Error('Mission changed'); };
    f.bot.pathfinder.goto = async () => { cancelled = true; };
    await assert.rejects(f.utilities.ensureChest(f.bot, home, site, f.context), /Mission changed/);
    assert.equal(f.items.find(i => i.name === 'chest').count, 2);
    assert.ok(!f.calls.includes('open'));
});

test('owned bed placement needs both real halves and a matching owner before use', async t => {
    const f = await fixture(t);
    const result = await f.utilities.placeBed(f.bot, home, site, 'white_bed', 'north', f.context);
    assert.equal(result.spawnConfirmed, false);
    assert.deepEqual(result.head, { x: 1, y: 64, z: 6 });
    f.bot.username = 'Spruce';
    await assert.rejects(f.utilities.useBed(f.bot, home, site, f.context), /owned bed/);
    f.bot.username = 'Roy';
    f.put({ x: 1, y: 64, z: 6 }, 'air');
    await assert.rejects(f.utilities.useBed(f.bot, home, site, f.context), /no longer matches/);
});

test('private vanilla translation ACK confirms personal spawn; sleeping alone does not', async t => {
    const f = await fixture(t);
    await f.utilities.placeBed(f.bot, home, site, 'white_bed', 'north', f.context);
    f.bot.activateBlock = async () => {
        f.bot.emit('message', { translate: 'block.minecraft.set_spawn' }, 'system', null);
        f.bot.emit('sleep');
        f.bot.isSleeping = true;
    };
    const confirmed = await f.utilities.useBed(f.bot, home, site, f.context);
    assert.equal(confirmed.spawnConfirmed, true);
    assert.equal(confirmed.slept, true);
    f.bot.activateBlock = async () => {
        f.bot.emit('message', { translate: 'block.minecraft.set_spawn' }, 'chat', 'player-uuid');
        f.bot.emit('sleep');
        f.bot.spawnPoint = new Vec3(1, 64, 7);
    };
    const unconfirmed = await f.utilities.useBed(f.bot, home, site, f.context);
    assert.equal(unconfirmed.spawnConfirmed, false);
    assert.equal(unconfirmed.slept, true);
    assert.equal(f.bot.listenerCount('message'), 0);
    assert.equal(f.bot.listenerCount('sleep'), 0);
});

test('wrong dimensions and invalid counts fail before any interaction', async t => {
    const f = await fixture(t);
    await assert.rejects(f.utilities.transferChest(f.bot, home, site, { direction: 'deposit', item: 'oak_planks', count: 0 }, f.context), /1..64/);
    f.bot.game.dimension = 'the_nether';
    await assert.rejects(f.utilities.useBed(f.bot, { ...home, dimension: 'the_nether' }, site, f.context), /Overworld/);
    assert.deepEqual(f.calls, []);
});

test('planner and bot validators agree on the complete base utility schema', async t => {
    const f = await fixture(t);
    const valid = [
        { action: 'place_chest', ...site },
        { action: 'deposit', ...site, item: 'oak_planks', count: 8 },
        { action: 'withdraw', ...site, item: 'oak_planks', count: 4 },
        { action: 'place_bed', ...site, item: 'white_bed', facing: 'north' },
        { action: 'use_bed', ...site }
    ];
    assert.deepEqual(validatePlannerProgram(valid, 'Moss'), valid);
    assert.equal(validateProgram(valid, f.bot, 'Moss'), valid);
    for (const malformed of [
        { action: 'place_chest', x: 1, y: 64 },
        { action: 'use_bed', ...site, run: 'code' },
        { action: 'deposit', ...site, item: 'oak_planks', count: 0 },
        { action: 'withdraw', ...site, item: 'not_an_item', count: 1 },
        { action: 'place_bed', ...site, item: 'chest', facing: 'north' },
        { action: 'place_bed', ...site, item: 'white_bed', facing: 'up' },
        { action: 'use_bed', ...site, x: 1.5 }
    ]) {
        assert.throws(() => validatePlannerProgram([malformed], 'Roy'));
        assert.throws(() => validateProgram([malformed], f.bot, 'Roy'));
    }
});

async function programFixture(t, program) {
    const f = await fixture(t);
    const previousRoot = process.env.ADVENTURE_ROOT;
    process.env.ADVENTURE_ROOT = f.directory;
    t.after(() => {
        if (previousRoot === undefined) delete process.env.ADVENTURE_ROOT;
        else process.env.ADVENTURE_ROOT = previousRoot;
    });
    let mission = { id: 'utility-mission', bots: { Roy: { program } } };
    const events = [];
    const agent = { name: 'Roy', bot: f.bot };
    const helpers = {
        getMission: () => mission, getHome: () => home, controllerRevision: 'test-base-program',
        navigateHome: async bot => { f.calls.push('regroup'); bot.entity.position = new Vec3(home.x, home.y, home.z); },
        emit: (_, type, message, data) => events.push({ type, message, data })
    };
    return { ...f, agent, helpers, events, setMission: value => { mission = value; },
        run: () => executeProgram(agent, { log() {} }, helpers) };
}

test('declarative program regroups, places and transfers real items with structured results', async t => {
    const f = await programFixture(t, [
        { action: 'place_chest', ...site },
        { action: 'deposit', ...site, item: 'oak_planks', count: 7 },
        { action: 'withdraw', ...site, item: 'oak_planks', count: 2 }
    ]);
    await f.run();
    const observations = f.events.filter(event => event.type === 'base_utility').map(event => event.data);
    assert.deepEqual(observations.map(o => o.action), ['place_chest', 'deposit', 'withdraw']);
    assert.equal(observations[0].placed, true);
    assert.equal(observations[1].after.container, 12);
    assert.equal(observations[2].after.inventory, 15);
    assert.equal(f.agent.adventureBaseUtilities['overworld:1,64,7'].action, 'withdraw');
    assert.ok(f.calls.includes('regroup'));
    assert.equal(f.events.filter(event => event.type === 'attempt_completed').length, 1);
    const sameRoot = createBaseUtilities({ lockDirectory: join(f.directory, 'control', 'base-utilities') });
    assert.equal((await sameRoot.ensureChest(f.bot, home, site, f.context)).placed, false);
});

test('same mission retry reuses its recorded bed without spending a second item', async t => {
    const f = await programFixture(t, [{ action: 'place_bed', ...site, item: 'white_bed', facing: 'north' }]);
    await f.run();
    await f.run();
    assert.equal(f.items.find(item => item.name === 'white_bed').count, 0);
    assert.deepEqual(f.events.filter(event => event.type === 'base_utility').map(event => event.data.placed), [true, false]);
});

test('complete ensure/place/use bed chain reuses consumed bed after acknowledgement failure', async t => {
    const f = await programFixture(t, [
        { action: 'ensure_item', item: 'white_bed', count: 1 },
        { action: 'place_bed', ...site, item: 'white_bed', facing: 'north' },
        { action: 'use_bed', ...site }
    ]);
    await assert.rejects(f.run(), /personal-spawn acknowledgement/);
    assert.equal(f.items.find(item => item.name === 'white_bed').count, 0);
    // This fake protocol has no wool and no crafting API: a replacement-bed
    // acquisition would fail before reaching this genuine second interaction.
    let interactions = 0;
    f.bot.activateBlock = async () => { interactions++; };
    await assert.rejects(f.run(), /personal-spawn acknowledgement/);
    assert.equal(interactions, 1);
    assert.deepEqual(f.events.filter(event => event.type === 'base_utility' && event.data.action === 'place_bed').map(event => event.data.placed), [true, false]);
});

test('paired chest prerequisite is not reacquired after placement and later ambiguous transfer', async t => {
    const f = await programFixture(t, [
        { action: 'ensure_item', item: 'chest', count: 1 },
        { action: 'place_chest', ...site },
        { action: 'deposit', ...site, item: 'oak_planks', count: 7 }
    ]);
    f.items.find(item => item.name === 'chest').count = 1;
    const open = f.bot.openChest;
    f.bot.openChest = async () => {
        const window = await open();
        window.deposit = async () => { throw new Error('Transfer result unavailable'); };
        return window;
    };
    await assert.rejects(f.run(), /Transfer result unavailable/);
    assert.equal(f.items.find(item => item.name === 'chest').count, 0);
    await assert.rejects(f.run(), /intent is unresolved/);
    assert.equal(f.items.find(item => item.name === 'chest').count, 0);
});

test('unconfirmed bed acknowledgement is observed but cannot complete a spawn-protection program', async t => {
    const f = await programFixture(t, [
        { action: 'place_bed', ...site, item: 'white_bed', facing: 'north' },
        { action: 'use_bed', ...site }
    ]);
    f.bot.activateBlock = async () => { f.bot.isSleeping = true; f.bot.emit('sleep'); };
    await assert.rejects(f.run(), /personal-spawn acknowledgement/);
    assert.equal(f.events.some(event => event.type === 'attempt_completed'), false);
    const observation = f.events.filter(event => event.type === 'base_utility').at(-1).data;
    assert.equal(observation.slept, true);
    assert.equal(observation.spawnConfirmed, false);
});

test('confirmed exact transfers do not repeat after later failure or a fresh utility instance', async t => {
    const f = await programFixture(t, [
        { action: 'place_chest', ...site },
        { action: 'deposit', ...site, item: 'oak_planks', count: 7 },
        { action: 'withdraw', ...site, item: 'oak_planks', count: 2 },
        { action: 'equip', item: 'diamond_sword' }
    ]);
    await assert.rejects(f.run(), /missing earned diamond_sword/);
    const first = f.events.filter(event => event.type === 'base_utility' && event.data.action === 'deposit')[0].data;
    delete f.agent.adventureBaseUtilities;
    await assert.rejects(f.run(), /missing earned diamond_sword/);
    assert.equal(f.calls.filter(call => call === 'deposit').length, 1);
    assert.equal(f.calls.filter(call => call === 'withdraw').length, 1);
    assert.equal(f.items.find(item => item.name === 'oak_planks').count, 15);
    const replay = f.events.filter(event => event.type === 'base_utility' && event.data.action === 'deposit').at(-1).data;
    assert.equal(replay.replayed, true);
    assert.equal(replay.at, first.at);
});

test('pending transfer intent prevents a blind replay after uncertain mutation', async t => {
    const f = await programFixture(t, [
        { action: 'place_chest', ...site },
        { action: 'deposit', ...site, item: 'oak_planks', count: 7 }
    ]);
    const open = f.bot.openChest;
    f.bot.openChest = async () => {
        const window = await open();
        const deposit = window.deposit;
        window.deposit = async (...args) => { await deposit(...args); throw new Error('Connection lost after mutation'); };
        return window;
    };
    await assert.rejects(f.run(), /Connection lost/);
    delete f.agent.adventureBaseUtilities;
    await assert.rejects(f.run(), /intent is unresolved.*ambiguous/);
    assert.equal(f.calls.filter(call => call === 'deposit').length, 1);
    assert.equal(f.items.find(item => item.name === 'oak_planks').count, 13);
    assert.equal(f.events.some(event => event.type === 'attempt_completed'), false);
});

test('cancelling passive bed acknowledgement waiting neither disconnects nor retains the lock', async t => {
    const f = await fixture(t);
    await f.utilities.placeBed(f.bot, home, site, 'white_bed', 'north', f.context);
    let cancelled = false;
    const check = () => { if (cancelled) throw new Error('New mission'); };
    const context = createBaseContext(f.bot, check, async perform => { check(); const result = await perform(); check(); return result; });
    f.bot.activateBlock = async () => { setTimeout(() => { cancelled = true; }, 10); };
    await assert.rejects(f.utilities.useBed(f.bot, home, site, context), error => /New mission/.test(error.message) && error.retainUtilityLock !== true);
    assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'disconnect'), false);
    assert.equal((await f.utilities.placeBed(f.bot, home, site, 'white_bed', 'north', f.context)).placed, false);
    assert.equal(f.bot.listenerCount('message'), 0);
});

test('utility context drains cancelled work before returning control', async t => {
    const f = await fixture(t);
    let cancelled = false;
    let completed = false;
    const check = () => { if (cancelled) throw new Error('New mission'); };
    const context = createBaseContext(f.bot, check, async perform => { check(); const value = await perform(); check(); return value; });
    const pending = context.run(async () => {
        cancelled = true;
        await new Promise(resolve => setTimeout(resolve, 100));
        completed = true;
    });
    await assert.rejects(pending, /New mission/);
    assert.equal(completed, true);
    assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'disconnect'), false);
});

test('unsettled cancelled chest operation disconnects and retains its lock across utility instances', async t => {
    const f = await fixture(t);
    f.put(site, 'chest', { type: 'single' });
    let cancelled = false;
    const check = () => { if (cancelled) throw new Error('New mission'); };
    const context = createBaseContext(f.bot, check, async perform => { check(); const value = await perform(); check(); return value; });
    f.bot.openChest = async () => { cancelled = true; await new Promise(() => {}); };
    await assert.rejects(f.utilities.transferChest(f.bot, home, site, { direction: 'deposit', item: 'oak_planks', count: 1 }, context), error => error.retainUtilityLock === true);
    assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'disconnect'));
    await assert.rejects(createBaseUtilities({ lockDirectory: f.directory }).ensureChest(f.bot, home, site, f.context), /busy/);
});
