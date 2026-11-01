import test from 'node:test';
import assert from 'node:assert/strict';
import { craftExecutions, recipeIngredients, registerPrograms, validateProgram } from './program.mjs';

function fixture(program, initial = {}, name = 'Roy') {
    const names = ['oak_log', 'oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'cobblestone', 'stone_pickaxe', 'coal', 'raw_iron', 'iron_ingot', 'furnace', 'diamond', 'torch', 'iron_helmet', 'mutton', 'cooked_mutton', 'acacia_log', 'acacia_planks', 'pale_oak_log', 'pale_oak_planks'];
    const items = names.map((name, id) => ({ name, id }));
    const registry = { items, itemsByName: Object.fromEntries(items.map(item => [item.name, item])) };
    const inventory = new Map(Object.entries(initial));
    const equipment = new Map();
    const amount = item => inventory.get(item) ?? 0;
    const add = (item, count) => inventory.set(item, amount(item) + count);
    const recipes = {};
    const recipe = (name, count, ingredients, requiresTable = false) => {
        recipes[name] = [{ requiresTable, result: { id: registry.itemsByName[name].id, count }, delta: [
            ...Object.entries(ingredients).map(([item, count]) => ({ id: registry.itemsByName[item].id, count: -count })),
            { id: registry.itemsByName[name].id, count }
        ] }];
    };
    recipe('oak_planks', 4, { oak_log: 1 });
    recipe('stick', 4, { oak_planks: 2 });
    recipe('crafting_table', 1, { oak_planks: 4 });
    recipe('wooden_pickaxe', 1, { oak_planks: 3, stick: 2 }, true);
    recipe('stone_pickaxe', 1, { cobblestone: 3, stick: 2 }, true);
    recipe('furnace', 1, { cobblestone: 8 }, true);
    recipe('torch', 4, { coal: 1, stick: 1 });
    recipe('iron_helmet', 1, { iron_ingot: 5 }, true);
    let mission = { id: 'revision1', bots: { [name]: { program } } };
    let home = null;
    const events = [], calls = [];
    const resources = new Map();
    const block = (name, x = 8) => ({ name, position: { x, y: 64, z: 0 } });
    const bot = {
        registry, game: { dimension: 'overworld', gameMode: 'survival' }, health: 20, food: 20, entities: {},
        modes: { isOn: () => false },
        inventory: { items: () => [...inventory].filter(([, count]) => count > 0).map(([name, count]) => ({ ...registry.itemsByName[name], count })),
            get slots() {
                const slots = Array(46);
                this.items().forEach((item, index) => { slots[index + 9] = item; });
                for (const [slot, item] of equipment) slots[slot] = item;
                return slots;
            } },
        entity: { position: { x: 0, y: 64, z: 0, distanceTo(p) { return Math.hypot(p.x - this.x, p.y - this.y, p.z - this.z); } } },
        pathfinder: { setGoal: () => {} }, clearControlStates: () => {},
        _syncWindow: async () => {},
        findBlock: ({ matching, useExtraInfo, maxDistance }) => {
            // Mineflayer first matches the section palette, without coordinates.
            const possible = [...resources.values()].some(block => matching({ name: block.name, position: null }));
            if (!possible) return null;
            return [...resources.values()].find(block => matching(block) && bot.entity.position.distanceTo(block.position) <= maxDistance && (!useExtraInfo || useExtraInfo(block))) ?? null;
        },
        findBlocks: ({ matching }) => [...resources.values()].filter(matching).map(b => b.position),
        recipesAll: id => recipes[items[id].name] ?? [],
        recipesFor: id => (recipes[items[id].name] ?? []).filter(recipe => recipe.delta.filter(i => i.count < 0).every(i => amount(items[i.id].name) >= -i.count))
    };
    const skills = {
        log: (_, value) => calls.push(['log', value]),
        collectBlock: async (_, source, count, exclude) => {
            calls.push(['gather', source, count, exclude]);
            add(source === 'stone' ? 'cobblestone' : source === 'coal_ore' ? 'coal' : source === 'iron_ore' ? 'raw_iron' : source, count);
            return true;
        },
        craftRecipe: async (_, item, executions) => {
            calls.push(['craft', item, executions]);
            const recipe = bot.recipesFor(registry.itemsByName[item].id)[0];
            for (const ingredient of recipe.delta.filter(i => i.count < 0)) {
                assert.ok(amount(items[ingredient.id].name) >= -ingredient.count * executions);
                add(items[ingredient.id].name, ingredient.count * executions);
            }
            add(item, recipe.result.count * executions);
            return true;
        },
        smeltItem: async (_, input, count) => {
            calls.push(['smelt', input, count]);
            const fuel = amount('coal') > 0 ? 'coal' : 'oak_planks';
            const fuelCount = Math.ceil(count / (fuel === 'coal' ? 8 : 1.5));
            assert.ok(amount(fuel) >= fuelCount, 'smelting consumes available earned fuel');
            add(input, -count); add(fuel, -fuelCount);
            add(input === 'raw_iron' ? 'iron_ingot' : input === 'mutton' ? 'cooked_mutton' : 'stone', count);
            return true;
        },
        equip: async (_, item) => { calls.push(['equip', item]); return true; }
    };
    const helpers = { getMission: () => mission, getHome: () => home, emit: (agent, type, message) => events.push([agent.name, type, message]),
        gatherResource: async (agent, names) => {
            const source = [...resources.values()].find(block => names.includes(block.name));
            return skills.collectBlock(bot, source.name, 1, []);
        },
        buildLodge: async () => ({ message: 'eight blocks placed', complete: false }) };
    const agent = { name, bot, actions: { runAction: async (label, perform) => {
        calls.push(['action', label]); await perform(); return { success: true };
    } } };
    const actions = [];
    registerPrograms(actions, skills, helpers);
    return { bot, calls, events, skills, helpers, amount, add, resources, block, equipment, recipes,
        setMission: next => { mission = next; }, setHome: next => { home = next; },
        run: () => actions[0].perform(agent) };
}

const ensure = (item, count) => ({ action: 'ensure_item', item, count });

test('mission revision after authored gathering stops the remaining program', async () => {
    const t = fixture([ensure('oak_log', 1), ensure('oak_planks', 4)]);
    t.resources.set('tree', t.block('oak_log', 20));
    t.helpers.gatherResource = async () => {
        t.calls.push(['authored-gather']);
        t.setMission({ id: 'new-revision', bots: { Roy: { program: [ensure('oak_log', 1)] } } });
        return true;
    };
    await assert.rejects(t.run(), /mission|revision/i);
    assert.ok(t.calls.some(call => call[0] === 'authored-gather'));
    assert.equal(t.calls.some(call => call[0] === 'craft'), false);
});

test('only fixed declarative actions and registered items are accepted before gameplay', async () => {
    for (const program of [[{ action: 'eval', source: 'process.exit()' }], [ensure('minecraft:fake_js()', 1)], [ensure('oak_log', 65)], [{ action: 'regroup', code: 'malicious()' }], []]) {
        const f = fixture(program);
        await assert.rejects(f.run(), /Unsupported|Unknown|minimum|one to six/);
        assert.ok(!f.calls.some(call => ['gather', 'craft', 'smelt', 'equip'].includes(call[0])));
    }
});

test('craft yield converts minimum into recipe executions, not desired output count', () => {
    assert.equal(craftExecutions(3, 10, 4), 2);
    assert.equal(craftExecutions(10, 10, 4), 0);
    assert.throws(() => craftExecutions(0, 1, 0), /invalid/);
});

test('already satisfied inventory skips gameplay', async () => {
    const f = fixture([ensure('oak_log', 4)], { oak_log: 8 });
    assert.match(await f.run(), /0 gameplay operations/);
    assert.equal(f.amount('oak_log'), 8);
});

test('crafts rounded batches from actual ingredients, replay does not craft twice', async () => {
    const f = fixture([ensure('oak_planks', 10)], { oak_log: 4, oak_planks: 3 });
    await f.run();
    assert.deepEqual(f.calls.filter(call => call[0] === 'craft'), [['craft', 'oak_planks', 2]]);
    assert.equal(f.amount('oak_planks'), 11);
    assert.equal(f.amount('oak_log'), 2);
    await f.run();
    assert.equal(f.calls.filter(call => call[0] === 'craft').length, 1);
});

test('dependent inventory crafts wait for authoritative server state between recipes', async () => {
    const f = fixture([ensure('wooden_pickaxe', 1)], { oak_log: 5 });
    // Model the 2x2 craft's unacknowledged final put-away: the API has returned,
    // but starting another recipe before a full inventory fence can apply an old
    // server snapshot over the next recipe's predicted ingredient slots.
    let pendingPutAway = false;
    const craft = f.skills.craftRecipe;
    f.skills.craftRecipe = async (...args) => {
        if (pendingPutAway) throw new Error('missing ingredient: previous put-away not synchronized');
        await craft(...args);
        pendingPutAway = true;
        return true;
    };
    f.bot._syncWindow = async window => {
        assert.equal(window, f.bot.inventory);
        pendingPutAway = false;
    };
    await f.run();
    assert.equal(f.amount('wooden_pickaxe'), 1);
    assert.equal(pendingPutAway, false);
    assert.ok(f.calls.filter(call => call[0] === 'craft').length >= 4);
});

test('a predicted crafting result rejected by server cannot satisfy the next step', async () => {
    const f = fixture([ensure('oak_planks', 4), { action: 'equip', item: 'oak_planks' }], { oak_log: 1 });
    let craftReturned = false;
    const craft = f.skills.craftRecipe;
    f.skills.craftRecipe = async (...args) => { await craft(...args); craftReturned = true; return true; };
    f.bot._syncWindow = async () => {
        if (craftReturned) f.add('oak_planks', -f.amount('oak_planks'));
    };
    await assert.rejects(f.run(), /did not reach observed acquired minimum/);
    assert.ok(!f.calls.some(call => call[0] === 'equip'));
});

test('failed craft still refreshes authoritative inventory before releasing the action', async () => {
    const f = fixture([ensure('oak_planks', 4)], { oak_log: 1 });
    let started = false, refreshedAfterError = false;
    f.skills.craftRecipe = async () => { started = true; throw new Error('missing ingredient'); };
    f.bot._syncWindow = async () => { if (started) refreshedAfterError = true; };
    await assert.rejects(f.run(), /missing ingredient/);
    assert.equal(refreshedAfterError, true);
});

test('survival interruption cancels a pending inventory fence before the manager kill deadline', async () => {
    const f = fixture([ensure('oak_planks', 4)], { oak_log: 1 });
    let syncStarted;
    const started = new Promise(resolve => { syncStarted = resolve; });
    let settle;
    f.bot._syncWindow = async () => {
        syncStarted();
        await new Promise(resolve => { settle = resolve; });
    };
    const running = f.run();
    await started;
    f.bot.interrupt_code = true;
    await assert.rejects(running, /interrupted/);
    settle();
    await Promise.resolve();
    assert.ok(!f.calls.some(call => call[0] === 'craft'));
});

test('survival interruption also cancels a pending post-craft fence without starting dependent work', async () => {
    const f = fixture([ensure('oak_planks', 4), { action: 'equip', item: 'oak_planks' }], { oak_log: 1 });
    let calls = 0, syncStarted;
    const started = new Promise(resolve => { syncStarted = resolve; });
    let settle;
    f.bot._syncWindow = async () => {
        if (++calls === 1) return;
        syncStarted();
        await new Promise(resolve => { settle = resolve; });
    };
    const running = f.run();
    await started;
    f.bot.interrupt_code = true;
    await assert.rejects(running, /interrupted/);
    settle();
    await Promise.resolve();
    assert.ok(!f.calls.some(call => call[0] === 'equip'));
});

for (const held of [true, false]) {
    test(`crafting chooses available wood instead of the registry's first pale-oak recipe (${held ? 'inventory' : '40 blocks away'})`, async () => {
        const f = fixture([ensure('crafting_table', 1)], held ? { acacia_log: 1 } : {});
        const id = name => f.bot.registry.itemsByName[name].id;
        const recipe = (result, count, ingredient, consumed) => ({ requiresTable: false,
            result: { id: id(result), count }, delta: [{ id: id(ingredient), count: -consumed }, { id: id(result), count }] });
        f.recipes.crafting_table = [recipe('crafting_table', 1, 'pale_oak_planks', 4), recipe('crafting_table', 1, 'acacia_planks', 4)];
        f.recipes.pale_oak_planks = [recipe('pale_oak_planks', 4, 'pale_oak_log', 1)];
        f.recipes.acacia_planks = [recipe('acacia_planks', 4, 'acacia_log', 1)];
        if (!held) f.resources.set('tree', f.block('acacia_log', 40));
        await f.run();
        assert.equal(f.amount('crafting_table'), 1);
        assert.deepEqual(f.calls.filter(call => call[0] === 'craft'), [['craft', 'acacia_planks', 1], ['craft', 'crafting_table', 1]]);
        assert.equal(f.calls.some(call => call[0] === 'gather'), !held);
    });
}

test('cooked food from initial resources resolves equipment prerequisites beyond the old depth-four cutoff', async () => {
    const f = fixture([ensure('cooked_mutton', 2)], {}, 'Moss');
    f.bot.entities = { 7: { name: 'sheep', position: { x: 5, y: 64, z: 0 } } };
    f.resources.set('tree', f.block('oak_log'));
    f.resources.set('rock', f.block('stone'));
    f.resources.set('coal', f.block('coal_ore'));
    f.skills.attackEntity = async () => { f.add('mutton', 2); delete f.bot.entities[7]; return true; };
    await f.run();
    assert.equal(f.amount('cooked_mutton'), 2);
    assert.equal(f.amount('wooden_pickaxe'), 1);
    assert.equal(f.amount('furnace'), 1);
});

test('cyclic recipe dependencies fail explicitly instead of recursing indefinitely', async () => {
    const f = fixture([ensure('oak_planks', 4)]);
    const original = f.bot.recipesAll;
    f.bot.recipesAll = (id, ...args) => id === f.bot.registry.itemsByName.oak_planks.id
        ? [{ requiresTable: false, result: { id, count: 4 }, delta: [{ id: f.bot.registry.itemsByName.stick.id, count: -1 }, { id, count: 4 }] }]
        : original(id, ...args);
    await assert.rejects(f.run(), /Cyclic acquisition prerequisites/);
});

test('recursive sticks use earned logs and correct plank/stick yields', async () => {
    const f = fixture([ensure('stick', 8)], { oak_log: 1 });
    await f.run();
    assert.equal(f.amount('oak_log'), 0);
    assert.equal(f.amount('oak_planks'), 0);
    assert.equal(f.amount('stick'), 8);
    assert.deepEqual(f.calls.filter(call => call[0] === 'craft'), [['craft', 'oak_planks', 1], ['craft', 'stick', 2]]);
});

test('shared intermediate ingredients are reserved in dependency order', async () => {
    const f = fixture([ensure('wooden_pickaxe', 1)], { oak_log: 3 });
    f.resources.set('table', f.block('crafting_table'));
    await f.run();
    assert.equal(f.amount('wooden_pickaxe'), 1);
    assert.ok(f.calls.findIndex(c => c[1] === 'stick') < f.calls.findIndex(c => c[1] === 'wooden_pickaxe'));
});

test('auto-equipped crafted armour satisfies acquisition without consuming it as an ingredient or crafting twice', async () => {
    const f = fixture([ensure('iron_helmet', 1)], { iron_ingot: 10 });
    f.resources.set('table', f.block('crafting_table'));
    const craft = f.skills.craftRecipe;
    f.skills.craftRecipe = async (...args) => {
        await craft(...args);
        f.add('iron_helmet', -1);
        f.equipment.set(5, { name: 'iron_helmet', count: 1 });
        return true;
    };
    await f.run();
    assert.equal(f.amount('iron_helmet'), 0);
    assert.equal(f.equipment.get(5).name, 'iron_helmet');
    await f.run();
    assert.equal(f.calls.filter(call => call[0] === 'craft').length, 1);
    assert.equal(f.amount('iron_ingot'), 5);
});

test('unsupported missing item fails explicitly instead of inventing a resource', async () => {
    const f = fixture([ensure('diamond', 1)]);
    await assert.rejects(f.run(), /Unsupported ensure_item acquisition for diamond/);
    assert.ok(f.events.some(event => event[1] === 'error' && event[2].includes('diamond')));
});

test('mission revision during one operation stops before the next operation', async () => {
    const f = fixture([ensure('oak_planks', 8), { action: 'equip', item: 'oak_planks' }], { oak_log: 2 });
    const craft = f.skills.craftRecipe;
    f.skills.craftRecipe = async (...args) => {
        const result = await craft(...args);
        f.setMission({ id: 'revision2', bots: { Roy: { program: [ensure('oak_log', 2)] } } });
        return result;
    };
    await assert.rejects(f.run(), /Mission revision changed/);
    assert.equal(f.amount('oak_planks'), 8);
    assert.ok(!f.calls.some(call => call[0] === 'equip'));
});

test('gather updates desired state after each block, replay adds nothing', async () => {
    const f = fixture([ensure('oak_log', 3)], { oak_log: 1 });
    f.resources.set('oak', f.block('oak_log'));
    await f.run(); await f.run();
    assert.equal(f.amount('oak_log'), 3);
    assert.equal(f.calls.filter(call => call[0] === 'gather').length, 2);
});

test('home footprint is not selected as a resource', async () => {
    const f = fixture([ensure('oak_log', 1)]);
    f.setHome({ x: 0, y: 64, z: 0, dimension: 'overworld' });
    f.resources.set('lodge', f.block('oak_log', 2));
    await assert.rejects(f.run(), /No loaded unprotected/);
    assert.ok(!f.calls.some(call => call[0] === 'gather'));
});

test('a claimed successful gather with no actual inventory progress is an error', async () => {
    const f = fixture([ensure('oak_log', 1)]);
    f.resources.set('oak', f.block('oak_log'));
    f.skills.collectBlock = async () => true;
    await assert.rejects(f.run(), /no oak_log entered inventory/);
});

test('earned iron is smelted from actual raw iron and fuel', async () => {
    const f = fixture([ensure('iron_ingot', 2)], { raw_iron: 2, coal: 1 });
    f.resources.set('furnace', f.block('furnace'));
    await f.run();
    assert.equal(f.amount('iron_ingot'), 2);
    assert.equal(f.amount('raw_iron'), 0);
    assert.deepEqual(f.calls.filter(call => call[0] === 'smelt'), [['smelt', 'raw_iron', 2]]);
});

test('lodge batch is not misreported as a finished structure', async () => {
    const f = fixture([{ action: 'build_lodge' }]);
    await assert.rejects(f.run(), /Lodge remains incomplete/);
    assert.ok(!f.events.some(event => event[1] === 'program' && event[2].includes('completed')));
    const other = fixture([{ action: 'build_lodge' }], {}, 'Moss');
    assert.throws(() => validateProgram([{ action: 'build_lodge' }], other.bot, 'Moss'), /Only Roy/);
});

test('injured hungry empty-inventory bots can forage, craft and equip without a recovery deadlock', async () => {
    const f = fixture([ensure('oak_planks', 4), { action: 'equip', item: 'oak_planks' }], {}, 'Moss');
    f.bot.health = 4.16;
    f.bot.food = 2;
    f.resources.set('oak', f.block('oak_log'));
    await f.run();
    assert.equal(f.amount('oak_planks'), 4);
    assert.ok(f.calls.some(call => call[0] === 'gather'));
    assert.ok(f.calls.some(call => call[0] === 'craft'));
    assert.ok(f.calls.some(call => call[0] === 'equip'));
});

test('injured empty-inventory Moss can obtain actual edible drops from observed sheep', async () => {
    const f = fixture([ensure('mutton', 2)], {}, 'Moss');
    f.bot.health = 4.16;
    f.bot.food = 2;
    f.bot.entities = { 7: { name: 'sheep', position: { x: 5, y: 64, z: 0 } } };
    f.skills.attackEntity = async (_, animal, kill) => {
        assert.equal(animal, f.bot.entities[7]); assert.equal(kill, true);
        f.add('mutton', 2);
        delete f.bot.entities[7];
        return true;
    };
    await f.run();
    assert.equal(f.amount('mutton'), 2);
});

test('cooked meat uses real earned raw drops and coal in an observed furnace', async () => {
    const f = fixture([ensure('cooked_mutton', 2)], { coal: 1 }, 'Moss');
    f.bot.health = 4.16;
    f.bot.entities = { 7: { name: 'sheep', position: { x: 5, y: 64, z: 0 } } };
    f.resources.set('furnace', f.block('furnace'));
    f.skills.attackEntity = async () => { f.add('mutton', 2); delete f.bot.entities[7]; return true; };
    await f.run();
    assert.equal(f.amount('mutton'), 0);
    assert.equal(f.amount('cooked_mutton'), 2);
    assert.equal(f.amount('coal'), 0);
    assert.deepEqual(f.calls.filter(call => call[0] === 'smelt'), [['smelt', 'mutton', 2]]);
});

test('cooking with an owned furnace and wood does not require a coal expedition', async () => {
    const f = fixture([ensure('cooked_mutton', 2)], { mutton: 2, oak_planks: 4 }, 'Moss');
    f.bot.health = 2;
    f.bot.food = 0;
    f.resources.set('furnace', f.block('furnace'));
    await f.run();
    assert.equal(f.amount('cooked_mutton'), 2);
    assert.equal(f.amount('oak_planks'), 2);
    assert.equal(f.amount('coal'), 0);
    assert.equal(f.calls.some(call => call[0] === 'gather'), false);
});

test('food preparation approaches the nearest observed animal beyond the combat radius before hunting it', async () => {
    const f = fixture([ensure('mutton', 2)], {}, 'Moss');
    const far = { name: 'sheep', position: { x: 70, y: 64, z: 0 } };
    const near = { name: 'sheep', position: { x: 25, y: 64, z: 0 } };
    f.bot.entities = { 1: far, 2: near };
    f.helpers.approachAnimal = async (agent, animal) => {
        assert.equal(animal, near);
        f.calls.push(['approach', animal.name]);
        f.bot.entity.position.x = 17;
        return true;
    };
    f.skills.attackEntity = async (bot, animal) => {
        assert.equal(animal, near);
        assert.ok(f.calls.some(call => call[0] === 'approach'));
        f.add('mutton', 2);
        delete f.bot.entities[2];
        return true;
    };
    await f.run();
    assert.equal(f.amount('mutton'), 2);
});

test('hunting without observed food drops cannot claim recovery success', async () => {
    const f = fixture([ensure('mutton', 1)], {}, 'Moss');
    f.bot.entities = { 7: { name: 'sheep', position: { x: 5, y: 64, z: 0 } } };
    f.skills.attackEntity = async () => true;
    await assert.rejects(f.run(), /no observed mutton/);
    assert.equal(f.amount('mutton'), 0);
});

test('food hunting rejects missing passive animals without attacking any player or hostile', async () => {
    const f = fixture([ensure('mutton', 1)], {}, 'Moss');
    f.bot.entities = { 7: { name: 'player', username: 'sheep', position: { x: 1, y: 64, z: 0 } } };
    f.skills.attackEntity = async () => { throw new Error('Must not attack unrelated entities'); };
    await assert.rejects(f.run(), /No loaded sheep/);
});

test('dead bots cannot start gameplay even when resources are reachable', async () => {
    const f = fixture([ensure('oak_log', 1)]);
    f.bot.health = 0;
    f.resources.set('oak', f.block('oak_log'));
    await assert.rejects(f.run(), /while dead/);
    assert.ok(!f.calls.some(call => call[0] === 'gather'));
});

test('survival reflex interruption prevents the following operation', async () => {
    const f = fixture([ensure('oak_planks', 4), { action: 'equip', item: 'oak_planks' }], { oak_log: 1 });
    const craft = f.skills.craftRecipe;
    f.skills.craftRecipe = async (...args) => { await craft(...args); f.bot.interrupt_code = true; };
    await assert.rejects(f.run(), /interrupted/);
    assert.ok(!f.calls.some(call => call[0] === 'equip'));
});

test('creative and cheat modes are rejected before gameplay', async () => {
    for (const mode of ['creative', 'cheat']) {
        const f = fixture([ensure('oak_log', 1)]);
        if (mode === 'creative') f.bot.game.gameMode = mode;
        else f.bot.modes.isOn = () => true;
        await assert.rejects(f.run(), /survival mode with cheats disabled/);
    }
});
