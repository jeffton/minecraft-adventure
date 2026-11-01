// Authored survival actions. No chat commands, generated code, or inventory creation.
const AIR = new Set(['air', 'cave_air', 'void_air']);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
const point = (bot, p) => bot.entity.position.offset(p.x - bot.entity.position.x, p.y - bot.entity.position.y, p.z - bot.entity.position.z);
const center = (bot, p) => point(bot, p).offset(0.5, 0.5, 0.5);
const dimension = bot => String(bot.game.dimension);

export function portalLayout(x, y, z, axis = 'x') {
    if (!['x', 'z'].includes(axis) || ![x, y, z].every(Number.isInteger)) throw new Error('Use integer coordinates and axis x or z.');
    const at = (u, v) => ({ x: x + (axis === 'x' ? u : 0), y: y + v, z: z + (axis === 'z' ? u : 0) });
    const frame = [at(1, 0), at(2, 0)];
    for (let v = 1; v <= 3; v++) frame.push(at(0, v), at(3, v));
    frame.push(at(1, 4), at(2, 4));
    return { frame, corners: [at(0, 0), at(3, 0), at(0, 4), at(3, 4)], interior: [1, 2].flatMap(u => [1, 2, 3].map(v => at(u, v))) };
}

export function needsEye(block) {
    return block?.name === 'end_portal_frame' && ![true, 'true'].includes(block.getProperties().eye);
}

// Full-charge arrow: about 3 blocks/tick, gravity .05 blocks/tick².
// Low ballistic arc; ignores air drag and target motion, so distant shots are approximate.
export function bowAim(origin, target, speed = 3, gravity = 0.05) {
    const dx = target.x - origin.x, dz = target.z - origin.z;
    const horizontal = Math.hypot(dx, dz), dy = target.y - origin.y;
    const discriminant = speed ** 4 - gravity * (gravity * horizontal ** 2 + 2 * dy * speed ** 2);
    if (horizontal < 0.01 || discriminant < 0) throw new Error('No useful low bow arc to target.');
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan((speed ** 2 - Math.sqrt(discriminant)) / (gravity * horizontal)) };
}

function requireItems(bot, items) {
    for (const [name, quantity] of Object.entries(items)) {
        if (count(bot, name) < quantity) throw new Error(`Need ${quantity} earned ${name}; inventory has ${count(bot, name)}.`);
    }
}

function scope(bot, helpers, milliseconds) {
    const until = Date.now() + milliseconds;
    const initialDimension = dimension(bot);
    const check = (allowDimensionChange = false) => {
        if (bot.interrupt_code || helpers.shouldStop?.(bot)) throw new Error('Progression action cancelled.');
        if (Date.now() >= until) throw new Error('Progression action time budget exhausted.');
        if (bot.health <= 10 || bot.food <= 6) throw new Error('Safety stop: recover health/food before continuing.');
        if (!allowDimensionChange && dimension(bot) !== initialDimension) throw new Error('Dimension changed; re-observe before continuing.');
    };
    const run = async (operation, allowDimensionChange = false) => {
        check(allowDimensionChange);
        let timer;
        let settled = false;
        const pending = Promise.resolve().then(operation).finally(() => { settled = true; });
        try {
            return await Promise.race([
                pending,
                new Promise((_, reject) => {
                    timer = setInterval(() => { try { check(allowDimensionChange); } catch (e) { reject(e); } }, 50);
                })
            ]);
        } catch (error) {
            // Do not let delayed navigation/equipment complete inside the next action.
            bot.pathfinder.setGoal(null);
            bot.clearControlStates();
            let drainTimer;
            try {
                await Promise.race([
                    pending.catch(() => {}),
                    new Promise(resolve => { drainTimer = setTimeout(resolve, 2000); })
                ]);
            } finally { clearTimeout(drainTimer); }
            if (!settled) {
                bot.end('Progression operation did not stop; disconnecting to prevent late interactions.');
                throw new Error(`${error.message} Outstanding operation did not settle; game connection closed.`);
            }
            throw error;
        } finally { clearInterval(timer); }
    };
    const wait = (ms, allow = false) => run(() => new Promise(resolve => setTimeout(resolve, ms)), allow);
    return { check, run, wait };
}

async function near(bot, p, radius, s, allowDimensionChange = false) {
    const goal = {
        heuristic: node => Math.max(0, distance(node, p) - radius),
        isEnd: node => distance(node, p) <= radius,
        hasChanged: () => false,
        isValid: () => true
    };
    const before = dimension(bot);
    try {
        await s.run(() => bot.pathfinder.goto(goal), allowDimensionChange);
    } catch (error) {
        if (!allowDimensionChange || dimension(bot) === before) throw error;
        s.check(true);
    }
    if (allowDimensionChange && dimension(bot) !== before) return;
    if (distance(bot.entity.position, p) > radius + 1) throw new Error('Pathfinding did not reach target.');
}

async function equip(bot, name, s) {
    requireItems(bot, { [name]: 1 });
    await s.run(() => bot.equip(bot.inventory.items().find(i => i.name === name), 'hand'));
}

async function reachable(bot, block, s) {
    await near(bot, block.position, 3, s);
    const eyes = bot.entity.position.offset(0, 1.62, 0);
    if (distance(eyes, center(bot, block.position)) > 4.5 || !bot.canSeeBlock(block)) throw new Error(`Cannot safely reach/see ${block.name}.`);
}

async function placeEarned(bot, name, p, s) {
    const target = bot.blockAt(point(bot, p));
    if (target?.name === name) return;
    if (!target || !AIR.has(target.name)) throw new Error(`Build site obstructed at ${JSON.stringify(p)}.`);
    const offsets = [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0]];
    const reference = offsets.map(([x, y, z]) => ({ block: bot.blockAt(point(bot, p).offset(x, y, z)), x, y, z }))
        .find(r => r.block?.boundingBox === 'block');
    if (!reference) throw new Error('No solid support for earned block placement.');
    await reachable(bot, reference.block, s);
    await equip(bot, name, s);
    await s.run(() => bot.placeBlock(reference.block, point(bot, { x: -reference.x, y: -reference.y, z: -reference.z })));
    if (bot.blockAt(point(bot, p))?.name !== name) throw new Error(`Server did not confirm placed ${name}.`);
}

function findBlocks(bot, name, radius = 48, amount = 1) {
    return bot.findBlocks({ matching: block => block.name === name, maxDistance: radius, count: amount }).map(p => bot.blockAt(p)).filter(Boolean);
}

export async function buildNetherPortal(bot, x, y, z, axis, s) {
    if (!dimension(bot).includes('overworld')) throw new Error('Build Nether portal in the overworld.');
    requireItems(bot, { obsidian: 10, cobblestone: 4, flint_and_steel: 1 });
    const layout = portalLayout(x, y, z, axis);
    if (distance(bot.entity.position, { x, y, z }) > 24) throw new Error('Portal build site must be within 24 blocks.');
    for (const p of layout.interior) {
        if (!AIR.has(bot.blockAt(point(bot, p))?.name)) throw new Error('Portal interior must be clear.');
    }
    // Corners are ordinary earned scaffolding; the Nether frame needs only ten obsidian.
    for (const p of [...layout.corners.slice(0, 2), ...layout.frame.slice(0, 8), ...layout.corners.slice(2), ...layout.frame.slice(8)]) {
        await placeEarned(bot, layout.corners.includes(p) ? 'cobblestone' : 'obsidian', p, s);
    }
    const base = bot.blockAt(point(bot, layout.frame[0]));
    await reachable(bot, base, s);
    await equip(bot, 'flint_and_steel', s);
    await s.run(() => bot.activateBlock(base, point(bot, { x: 0, y: 1, z: 0 })));
    await s.wait(1000);
    if (!layout.interior.some(p => bot.blockAt(point(bot, p))?.name === 'nether_portal')) throw new Error('Ignition did not create a Nether portal. Frame remains in world.');
    return 'Observed an active Nether portal; not entered.';
}

export async function enterPortal(bot, kind, s) {
    if (!['nether', 'end'].includes(kind)) throw new Error('Portal kind must be nether or end.');
    const portal = findBlocks(bot, `${kind}_portal`)[0];
    if (!portal) throw new Error(`No loaded ${kind} portal within 48 blocks.`);
    const before = dimension(bot);
    await near(bot, portal.position, 1, s, true);
    if (dimension(bot) !== before) return `Observed dimension transition to ${dimension(bot)}.`;
    const target = center(bot, portal.position);
    await s.run(() => bot.lookAt(target, true), true);
    try {
        // Walk into the actual portal, never teleport or infer success from pathfinding.
        bot.setControlState('forward', true);
        for (let n = 0; n < 20 && distance(bot.entity.position, target) > 0.65; n++) {
            if (dimension(bot) !== before) return `Observed dimension transition to ${dimension(bot)}.`;
            await s.wait(100, true);
        }
        bot.setControlState('forward', false);
        for (let n = 0; n < 80; n++) {
            if (dimension(bot) !== before) return `Observed dimension transition to ${dimension(bot)}.`;
            await s.wait(100, true);
        }
    } finally { bot.setControlState('forward', false); }
    throw new Error('Portal attempt ended without a dimension transition.');
}

export async function throwEnderEye(bot, s) {
    if (!dimension(bot).includes('overworld')) throw new Error('Throw Eyes in the overworld.');
    requireItems(bot, { ender_eye: 1 });
    const existing = new Set(Object.keys(bot.entities));
    const samples = [];
    let eyeId;
    await equip(bot, 'ender_eye', s);
    await s.run(() => bot.look(bot.entity.yaw, 0.4, true));
    bot.activateItem();
    try {
        for (let n = 0; n < 45; n++) {
            await s.wait(100);
            const eye = eyeId ? bot.entities[eyeId] : Object.values(bot.entities).find(e =>
                !existing.has(String(e.id)) && ['eye_of_ender', 'ender_eye'].includes(e.name) && distance(e.position, bot.entity.position) < 24);
            if (eye) {
                eyeId = eye.id;
                samples.push({ x: eye.position.x, y: eye.position.y, z: eye.position.z });
            }
        }
    } finally { bot.deactivateItem(); }
    if (samples.length < 2) throw new Error('No usable Eye trajectory observed; do not infer a stronghold location.');
    const first = samples[0], last = samples.at(-1);
    if (Math.hypot(last.x - first.x, last.z - first.z) < 0.5) throw new Error('Eye trajectory was too short to establish a direction.');
    return JSON.stringify({ observation: 'Eye trajectory, not stronghold coordinates. Reposition and triangulate.', first, last,
        horizontalDirection: { x: last.x - first.x, z: last.z - first.z } });
}

export async function fillEndPortal(bot, s) {
    const frames = findBlocks(bot, 'end_portal_frame', 16, 12).filter(needsEye);
    if (!frames.length) throw new Error('No loaded empty End portal frames within 16 blocks.');
    requireItems(bot, { ender_eye: frames.length });
    let inserted = 0;
    for (const frame of frames) {
        await reachable(bot, frame, s);
        await equip(bot, 'ender_eye', s);
        await s.run(() => bot.activateBlock(bot.blockAt(frame.position), point(bot, { x: 0, y: 1, z: 0 })));
        await s.wait(300);
        const updated = bot.blockAt(frame.position);
        if (updated?.name !== 'end_portal_frame' || ![true, 'true'].includes(updated.getProperties().eye)) throw new Error('Server did not confirm Eye insertion.');
        inserted++;
    }
    return `Inserted ${inserted} Eyes. Active End portal observed: ${findBlocks(bot, 'end_portal', 16).length > 0}. Not entered.`;
}

export async function fightEnd(bot, s) {
    if (!['the_end', 'minecraft:the_end'].includes(dimension(bot))) throw new Error('End combat requires the End dimension.');
    let shots = 0, strikes = 0;
    for (let step = 0; step < 20; step++) {
        s.check();
        const entities = Object.values(bot.entities);
        const crystals = entities.filter(e => ['end_crystal', 'ender_crystal'].includes(e.name) && distance(e.position, bot.entity.position) <= 48 && distance(e.position, bot.entity.position) >= 12);
        const dragon = entities.find(e => e.name === 'ender_dragon');
        const target = crystals.sort((a, b) => distance(a.position, bot.entity.position) - distance(b.position, bot.entity.position))[0] ?? dragon;
        if (!target) return `No loaded combat target; fired ${shots}, melee strikes ${strikes}. Victory not established.`;
        // Dragon phase index comes from the negotiated client's registry, not a fixed protocol offset.
        // Vanilla phases 5/6/7 are sitting; arrows cannot damage a sitting dragon.
        const phaseIndex = bot.registry.entitiesByName.ender_dragon.metadataKeys.indexOf('phase');
        const perched = dragon && [5, 6, 7].includes(dragon.metadata[phaseIndex]);
        if (target === dragon && perched) {
            // Mineflayer does not expose multipart heads. Vanilla's parent hurt() delegates
            // to its body (reduced damage). Only attack when the actual parent origin is
            // within melee reach; never forge part IDs or chase an airborne hitbox.
            if (distance(bot.entity.position.offset(0, 1.62, 0), dragon.position) > 3) return 'Dragon is perched but body is outside melee reach; reposition safely. No arrows wasted.';
            const sword = bot.inventory.items().find(i => i.name.endsWith('_sword'));
            if (!sword) throw new Error('Need earned sword for reachable perched dragon body.');
            await s.run(() => bot.equip(sword, 'hand'));
            bot.attack(dragon);
            strikes++;
            await s.wait(700);
            continue;
        }
        if (distance(target.position, bot.entity.position) > 48) return 'Target beyond bounded bow range; reposition safely.';
        const aimPoint = target.position.offset(0, target === dragon ? 2 : 0.5, 0);
        const obstruction = bot.world.raycast(bot.entity.position.offset(0, 1.62, 0), aimPoint.minus(bot.entity.position.offset(0, 1.62, 0)).normalize(), distance(aimPoint, bot.entity.position));
        if (obstruction) return 'Shot obstructed (possibly caged crystal); clear obstruction with ordinary mining before retrying.';
        await equip(bot, 'bow', s);
        requireItems(bot, { arrow: 1 });
        const aim = bowAim(bot.entity.position.offset(0, 1.62, 0), aimPoint);
        await s.run(() => bot.look(aim.yaw, aim.pitch, true));
        bot.activateItem();
        await s.wait(1100);
        bot.deactivateItem();
        shots++;
        await s.wait(900);
    }
    return `Bounded combat attempt: ${shots} shots, ${strikes} melee strikes. Re-observe targets; victory not established.`;
}

export function registerProgression(actionsList, skills, helpers = {}) {
    const integer = description => ({ type: 'int', description, domain: [-30000000, 30000000] });
    const definitions = [
        ['!buildNetherPortal', 'Build and ignite earned ten-obsidian portal at clear nearby base; needs four cobblestone corners and flint_and_steel.', { x: integer('Base x'), y: { ...integer('Base y'), domain: [-60, 250] }, z: integer('Base z'), axis: { type: 'string', description: 'x or z' } }, buildNetherPortal, 120000],
        ['!enterPortal', 'Attempt entry into nearest loaded portal; success requires actual dimension transition.', { kind: { type: 'string', description: 'nether or end' } }, enterPortal, 30000],
        ['!throwEnderEye', 'Throw one earned Eye and report observed trajectory for triangulation; not exact stronghold position.', {}, throwEnderEye, 10000],
        ['!fillEndPortal', 'Insert earned Eyes into nearby reachable actual empty frames. Reports observed activation.', {}, fillEndPortal, 90000],
        ['!fightEnd', 'Bounded bow combat against visible crystals/dragon; reachable stationary head melee only. Not guaranteed victory.', {}, fightEnd, 60000]
    ];
    for (const [name, description, params, execute, duration] of definitions) {
        actionsList.push({ name, description, params, perform: async (agent, ...args) => {
            const outcome = await agent.actions.runAction(`action:${name.slice(1)}`, async () => {
                const bot = agent.bot;
                if (bot.game.gameMode !== 'survival') throw new Error('Authored progression requires survival mode.');
                try {
                    const result = await execute(bot, ...args, scope(bot, helpers, duration));
                    skills.log(bot, result);
                } finally {
                    bot.pathfinder.setGoal(null);
                    bot.clearControlStates();
                    // Switching slots cancels a drawn bow; releasing it would fire on a safety stop.
                    if (bot.usingHeldItem && bot.heldItem?.name === 'bow') bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9);
                    bot.deactivateItem();
                }
            }, { timeout: duration / 60000 + 0.1 });
            return outcome.message;
        } });
    }
}
