import test from 'node:test';
import assert from 'node:assert/strict';
import { bowAim, needsEye, portalLayout, registerProgression } from './progression.mjs';

class Position {
    constructor(x, y, z) { Object.assign(this, { x, y, z }); }
    offset(x, y, z) { return new Position(this.x + x, this.y + y, this.z + z); }
}

function fixture(items = []) {
    const calls = [];
    const logs = [];
    const position = new Position(0, 64, 0);
    const bot = {
        game: { dimension: 'overworld', gameMode: 'survival' }, health: 20, food: 20,
        entity: { position, yaw: 0 }, inventory: { items: () => items }, entities: {},
        pathfinder: { goto: async () => { calls.push('path'); }, setGoal: () => calls.push('clearGoal') },
        blockAt: p => ({ name: 'air', position: p }), findBlocks: () => [],
        clearControlStates: () => calls.push('clearControls'), deactivateItem: () => calls.push('release'),
        setControlState: (key, value) => calls.push([key, value]),
        lookAt: async () => {}, equip: async () => calls.push('equip'),
        activateBlock: async () => calls.push('activateBlock'),
        placeBlock: async () => calls.push('placeBlock'),
        chat: () => { throw new Error('No commands allowed.'); }
    };
    const actions = [];
    registerProgression(actions, { log: (_, value) => logs.push(value) });
    const agent = { bot, actions: { runAction: async (_, execute) => { await execute(); return { message: logs.at(-1) }; } } };
    return { bot, calls, logs, run: (name, ...args) => actions.find(a => a.name === name).perform(agent, ...args) };
}

test('minimal frame has 10 obsidian, 6 clear interior blocks, and four scaffold corners in either orientation', () => {
    for (const axis of ['x', 'z']) {
        const layout = portalLayout(10, 64, -8, axis);
        const unique = list => new Set(list.map(p => JSON.stringify(p)));
        assert.equal(unique(layout.frame).size, 10);
        assert.equal(unique(layout.interior).size, 6);
        assert.equal(unique([...layout.frame, ...layout.corners, ...layout.interior]).size, 20);
        assert.equal(Math.max(...layout.frame.map(p => p.y)), 68);
        assert.ok(layout.frame.every(p => axis === 'x' ? p.z === -8 : p.x === 10));
    }
    assert.throws(() => portalLayout(0, 64, 0, 'y'), /axis/);
    assert.throws(() => portalLayout(0.5, 64, 0), /integer/);
});

test('ballistic low arc compensates gravity and uses Mineflayer yaw/pitch signs', () => {
    const origin = { x: 0, y: 0, z: 0 };
    const aim = bowAim(origin, { x: 0, y: 0, z: -40 });
    assert.ok(Math.abs(aim.yaw) < 1e-10);
    assert.ok(aim.pitch > 0);
    const ticks = 40 / (3 * Math.cos(aim.pitch));
    assert.ok(Math.abs(3 * Math.sin(aim.pitch) * ticks - 0.025 * ticks ** 2) < 1e-8);
    assert.equal(bowAim(origin, { x: 40, y: 0, z: 0 }).yaw, -Math.PI / 2);
    assert.throws(() => bowAim(origin, { x: 1000, y: 1000, z: 0 }), /arc/);
});

test('only actual empty portal frames accept Eyes', () => {
    const block = eye => ({ name: 'end_portal_frame', getProperties: () => ({ eye }) });
    assert.equal(needsEye(block(false)), true);
    assert.equal(needsEye(block(true)), false);
    assert.equal(needsEye(block('true')), false);
    assert.equal(needsEye({ name: 'end_stone' }), false);
    assert.equal(needsEye(null), false);
});

test('earned prerequisites reject before any placement or activation', async () => {
    const f = fixture([{ name: 'obsidian', count: 9 }]);
    await assert.rejects(f.run('!buildNetherPortal', 0, 64, 0, 'x'), /10 earned obsidian/);
    assert.ok(!f.calls.includes('placeBlock'));
    assert.ok(!f.calls.includes('activateBlock'));
    assert.ok(f.calls.includes('clearControls'));
});

test('survival action refuses creative mode', async () => {
    const f = fixture(); f.bot.game.gameMode = 'creative';
    await assert.rejects(f.run('!throwEnderEye'), /survival/);
});

test('obstructed interior rejects without mining or overwriting blocks', async () => {
    const f = fixture([{ name: 'obsidian', count: 10 }, { name: 'cobblestone', count: 4 }, { name: 'flint_and_steel', count: 1 }]);
    f.bot.blockAt = p => ({ name: 'stone', position: p });
    await assert.rejects(f.run('!buildNetherPortal', 0, 64, 0, 'x'), /interior must be clear/);
    assert.ok(!f.calls.includes('placeBlock'));
});

test('failed portal path never teleports or reports success', async () => {
    const f = fixture();
    f.bot.findBlocks = () => [new Position(0, 64, 0)];
    f.bot.blockAt = p => ({ name: 'nether_portal', position: p });
    f.bot.pathfinder.goto = async () => { throw new Error('No path into portal'); };
    await assert.rejects(f.run('!enterPortal', 'nether'), /No path/);
    assert.deepEqual(f.logs, []);
    assert.equal(f.bot.game.dimension, 'overworld');
    assert.ok(f.calls.includes('clearGoal'));
});

test('completed path without transition does not report portal entry', async () => {
    const f = fixture();
    f.bot.findBlocks = () => [new Position(0, 64, 0)];
    f.bot.blockAt = p => ({ name: 'nether_portal', position: p });
    let cancel;
    f.bot.pathfinder.goto = async () => {
        cancel = setTimeout(() => { f.bot.interrupt_code = true; }, 10);
    };
    await assert.rejects(f.run('!enterPortal', 'nether'), /cancelled/);
    clearTimeout(cancel);
    assert.equal(f.bot.game.dimension, 'overworld');
    assert.deepEqual(f.logs, []);
    assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'forward' && call[1] === false));
});

test('portal success requires observed dimension change, not path completion', async () => {
    const f = fixture();
    f.bot.findBlocks = () => [new Position(0, 64, 0)];
    f.bot.blockAt = p => ({ name: 'end_portal', position: p });
    f.bot.pathfinder.goto = async () => {
        f.bot.game.dimension = 'the_end';
        f.bot.entity.position = new Position(100, 50, 0);
        throw new Error('Path reset on respawn');
    };
    assert.match(await f.run('!enterPortal', 'end'), /Observed dimension transition to the_end/);
});

test('cancellation and low health stop before using earned items', async () => {
    for (const mode of ['interrupt', 'health']) {
        const f = fixture([{ name: 'ender_eye', count: 1 }]);
        if (mode === 'interrupt') f.bot.interrupt_code = true;
        else f.bot.health = 10;
        await assert.rejects(f.run('!throwEnderEye'), /cancelled|Safety stop/);
        assert.ok(!f.calls.includes('equip'));
    }
});

test('cancellation drains a delayed equipment operation before releasing the action', async () => {
    const f = fixture([{ name: 'ender_eye', count: 1 }]);
    let finished = false;
    f.bot.equip = async () => {
        await new Promise(resolve => setTimeout(resolve, 160));
        finished = true;
    };
    const promise = f.run('!throwEnderEye');
    const cancel = setTimeout(() => { f.bot.interrupt_code = true; }, 10);
    await assert.rejects(promise, /cancelled/);
    clearTimeout(cancel);
    assert.equal(finished, true, 'No equipment operation remains pending after return');
    assert.deepEqual(f.logs, []);
});

test('real registry phase permits sword-only reachable perched body melee, never arrows', async () => {
    const f = fixture([{ name: 'iron_sword', count: 1 }]);
    f.bot.game.dimension = 'the_end';
    f.bot.registry = { entitiesByName: { ender_dragon: { metadataKeys: ['health', 'phase'] } } };
    const dragon = { id: 400, name: 'ender_dragon', position: new Position(1, 65, 0), metadata: [200, 6] };
    f.bot.entities = { 400: dragon };
    f.bot.attack = target => {
        assert.equal(target, dragon);
        f.calls.push('melee');
        f.bot.interrupt_code = true;
    };
    f.bot.activateItem = () => { throw new Error('Perched dragon must not be shot.'); };
    await assert.rejects(f.run('!fightEnd'), /cancelled/);
    assert.ok(f.calls.includes('melee'));
});

test('perched dragon outside melee reach is not attacked or shot', async () => {
    const f = fixture([{ name: 'bow', count: 1 }, { name: 'arrow', count: 1 }]);
    f.bot.game.dimension = 'the_end';
    f.bot.registry = { entitiesByName: { ender_dragon: { metadataKeys: ['phase'] } } };
    f.bot.entities = { 400: { name: 'ender_dragon', position: new Position(10, 65, 0), metadata: [6] } };
    assert.match(await f.run('!fightEnd'), /outside melee reach/);
    assert.ok(!f.calls.includes('equip'));
});

test('disappeared frame is not mistaken for a confirmed Eye insertion', async () => {
    const f = fixture([{ name: 'ender_eye', count: 1 }]);
    let activated = false;
    f.bot.findBlocks = () => [new Position(0, 64, 0)];
    f.bot.canSeeBlock = () => true;
    f.bot.blockAt = p => ({ name: activated ? 'air' : 'end_portal_frame', position: p, getProperties: () => ({ eye: false }) });
    f.bot.activateBlock = async () => { activated = true; };
    await assert.rejects(f.run('!fillEndPortal'), /did not confirm/);
    assert.deepEqual(f.logs, []);
});

test('Eye insertion requires enough earned Eyes for observed empty frames', async () => {
    const f = fixture([{ name: 'ender_eye', count: 1 }]);
    f.bot.findBlocks = () => [new Position(0, 64, 0), new Position(1, 64, 0)];
    f.bot.blockAt = p => ({ name: 'end_portal_frame', position: p, getProperties: () => ({ eye: false }) });
    await assert.rejects(f.run('!fillEndPortal'), /2 earned ender_eye/);
    assert.ok(!f.calls.includes('activateBlock'));
});
