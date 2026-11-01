// Terra supplies data, never executable code. Each run observes inventory afresh.
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];
const LOGS = new Set(WOODS.map(wood => `${wood}_log`));
const PLANKS = new Set(WOODS.map(wood => `${wood}_planks`));
const CRAFTED = new Set(['stick', 'crafting_table', 'furnace', 'chest', 'torch', 'shield', 'bucket', 'flint_and_steel', ...PLANKS]);
for (const material of ['wooden', 'stone', 'iron']) {
    for (const tool of ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']) CRAFTED.add(`${material}_${tool}`);
}
for (const armour of ['helmet', 'chestplate', 'leggings', 'boots']) CRAFTED.add(`iron_${armour}`);
const RAW = { cobblestone: ['stone', 'cobblestone'], coal: ['coal_ore', 'deepslate_coal_ore'], raw_iron: ['iron_ore', 'deepslate_iron_ore'] };
const MEAT = { beef: 'cow', porkchop: 'pig', mutton: 'sheep', chicken: 'chicken' };
const SMELTED = { iron_ingot: 'raw_iron', stone: 'cobblestone', cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_mutton: 'mutton', cooked_chicken: 'chicken' };
const inventoryCount = (bot, name) => bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
const acquiredCount = (bot, name) => {
    if (!/_(helmet|chestplate|leggings|boots)$/.test(name) && name !== 'shield') return inventoryCount(bot, name);
    const usable = bot.inventory.items();
    const equipment = [5, 6, 7, 8, 45].map(slot => bot.inventory.slots[slot]);
    return inventoryCount(bot, name) + equipment.filter(item => item?.name === name && !usable.includes(item)).reduce((sum, item) => sum + item.count, 0);
};

export function validateProgram(program, bot, name) {
    if (!Array.isArray(program) || program.length < 1 || program.length > 6) throw new Error('Program must contain one to six declarative steps.');
    for (const step of program) {
        const keys = { ensure_item: ['action', 'item', 'count'], equip: ['action', 'item'], build_lodge: ['action'], regroup: ['action'] }[step?.action];
        if (!keys || Object.keys(step).some(key => !keys.includes(key))) throw new Error('Unsupported program action or fields; executable code is not accepted.');
        if (['ensure_item', 'equip'].includes(step.action) && (typeof step.item !== 'string' || !Object.hasOwn(bot.registry.itemsByName, step.item))) throw new Error(`Unknown registry item: ${step.item}.`);
        if (step.action === 'ensure_item' && (!Number.isInteger(step.count) || step.count < 1 || step.count > 64)) throw new Error('ensure_item count must be an inventory minimum from 1 to 64.');
        if (step.action === 'build_lodge' && name !== 'Roy') throw new Error('Only Roy may execute build_lodge.');
    }
    return program;
}

export function recipeIngredients(recipe, registry) {
    return recipe.delta.filter(item => item.count < 0).map(item => {
        const name = registry.items[item.id]?.name;
        if (!name) throw new Error(`Unknown ingredient registry id ${item.id}.`);
        return { name, count: -item.count };
    });
}

export function craftExecutions(current, desired, resultCount) {
    if (!Number.isInteger(resultCount) || resultCount < 1) throw new Error('Recipe has invalid result count.');
    return Math.ceil(Math.max(0, desired - current) / resultCount);
}

function protectedHome(block, home, bot) {
    if (!home || home.dimension !== bot.game.dimension) return false;
    const p = block.position;
    return p.x >= home.x - 2 && p.x <= home.x + 8 && p.z >= home.z - 3 && p.z <= home.z + 10 && p.y >= home.y - 2;
}

function nearestResource(bot, names, home) {
    return bot.findBlock({
        matching: block => names.includes(block.name),
        // Palette probes have no position; site filtering needs a world block.
        useExtraInfo: block => !protectedHome(block, home, bot),
        maxDistance: 64
    });
}

function requireSurvival(bot) {
    if (bot.game.gameMode !== 'survival' || bot.modes?.isOn('cheat')) throw new Error('Programs require survival mode with cheats disabled.');
}

export async function executeProgram(agent, skills, helpers) {
    const bot = agent.bot;
    const mission = helpers.getMission();
    if (!mission || typeof mission.id !== 'string') throw new Error('No current versioned mission.');
    const program = validateProgram(mission.bots?.[agent.name]?.program, bot, agent.name);
    requireSurvival(bot);
    const initialDimension = bot.game.dimension;
    const deadline = Date.now() + 120000;
    let operations = 0;
    let gathered = 0;
    let timedOut = false;
    const check = () => {
        if (timedOut || Date.now() >= deadline) throw new Error('Program reached its 120-second time budget; re-observe inventory before retrying.');
        if (bot.interrupt_code) throw new Error('Program interrupted by action manager or survival reflex.');
        if (helpers.getMission()?.id !== mission.id) throw new Error('Mission revision changed; stopped the old program at an operation boundary.');
        if (bot.game.dimension !== initialDimension) throw new Error('Dimension changed; old program stopped.');
        if (bot.health <= 0) throw new Error('Cannot execute a program while dead.');
        // Injured or hungry bots still need to forage, craft and equip recovery supplies.
        // Existing self-preservation modes own eating/retreat and interrupt this action.
        requireSurvival(bot);
    };
    const syncInventory = async () => {
        check();
        const stopAt = Date.now() + 5000;
        let timer;
        try {
            // _syncWindow sends one read-only resync request, then only awaits its
            // reply. Stop awaiting promptly on interrupts; no gameplay runs later.
            await Promise.race([
                Promise.resolve().then(() => bot._syncWindow(bot.inventory)),
                new Promise((_, reject) => {
                    timer = setInterval(() => {
                        try {
                            check();
                            if (Date.now() >= stopAt) throw new Error('Server inventory synchronization timed out after 5 seconds.');
                        } catch (error) { reject(error); }
                    }, 50);
                })
            ]);
        } finally { clearInterval(timer); }
        check();
    };
    const operation = async perform => {
        check();
        if (++operations > 64) throw new Error('Program exhausted its 64-operation budget.');
        const result = await perform();
        check();
        if (result === false) throw new Error('Gameplay skill reported failure; inspect current inventory/world before replanning.');
        return result;
    };
    const tableNearby = () => bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 16 });
    const gather = async (item, target, names, depth) => {
        if (item === 'cobblestone' || item === 'coal') {
            if (!bot.inventory.items().some(i => ['wooden', 'stone', 'iron', 'diamond', 'netherite'].some(material => i.name === `${material}_pickaxe`))) await ensure('wooden_pickaxe', 1, depth + 1);
        } else if (item === 'raw_iron') {
            if (!bot.inventory.items().some(i => ['stone', 'iron', 'diamond', 'netherite'].some(material => i.name === `${material}_pickaxe`))) await ensure('stone_pickaxe', 1, depth + 1);
        }
        while (inventoryCount(bot, item) < target) {
            check();
            const home = helpers.getHome();
            const block = nearestResource(bot, names, home);
            if (!block) throw new Error(`No loaded unprotected ${names.join('/')} within 64 blocks for ${item}. Explore or change the program.`);
            if (++gathered > 64) throw new Error('Program reached its 64-block gathering budget.');
            const before = inventoryCount(bot, item);
            await operation(() => helpers.gatherResource(agent, names, home));
            if (inventoryCount(bot, item) <= before) throw new Error(`Collected ${block.name} but no ${item} entered inventory; no progress.`);
        }
    };
    const chooseRecipe = item => {
        const recipes = bot.recipesAll(bot.registry.itemsByName[item].id, null, true);
        const home = helpers.getHome();
        const cost = recipe => recipeIngredients(recipe, bot.registry).reduce((sum, ingredient) => {
            if (inventoryCount(bot, ingredient.name) >= ingredient.count) return sum;
            const planks = PLANKS.has(ingredient.name);
            const log = planks ? ingredient.name.replace('_planks', '_log') : ingredient.name;
            const held = planks ? inventoryCount(bot, log) * 4 : 0;
            const local = LOGS.has(log) && nearestResource(bot, [log], home);
            return sum + (local ? 1 : 10) * Math.max(0, ingredient.count - inventoryCount(bot, ingredient.name) - held);
        }, 0);
        return recipes.filter(recipe => recipe.result.id === bot.registry.itemsByName[item].id && recipeIngredients(recipe, bot.registry).every(ingredient =>
            ingredient.name !== item && (inventoryCount(bot, ingredient.name) >= ingredient.count || LOGS.has(ingredient.name) || RAW[ingredient.name] || CRAFTED.has(ingredient.name) || ['iron_ingot', 'stone'].includes(ingredient.name))))
            .sort((a, b) => cost(a) - cost(b))[0];
    };
    const acquire = async (item, target, depth) => {
        check();
        // Root acquisition includes worn equipment (craftRecipe auto-equips armour).
        // Recipe ingredients must remain in usable inventory, never equipment slots.
        const observedCount = () => depth === 0 ? acquiredCount(bot, item) : inventoryCount(bot, item);
        if (observedCount() >= target) return;
        if (target > 64) throw new Error(`Bounded resolver cannot supply a batch larger than 64 ${item}.`);
        if (LOGS.has(item) || RAW[item]) return gather(item, target, RAW[item] ?? [item], depth);
        if (Object.hasOwn(MEAT, item)) {
            while (inventoryCount(bot, item) < target) {
                check();
                const animal = Object.values(bot.entities).filter(entity => entity.name === MEAT[item] && bot.entity.position.distanceTo(entity.position) <= 96)
                    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
                if (!animal) throw new Error(`No loaded ${MEAT[item]} within 96 blocks for earned ${item}.`);
                if (bot.entity.position.distanceTo(animal.position) > 20) await operation(() => helpers.approachAnimal(agent, animal));
                if (++gathered > 64) throw new Error('Program reached its 64-resource gathering budget.');
                const before = inventoryCount(bot, item);
                // Attack the observed passive animal directly. attackNearest disables
                // cowardice; food gathering must remain interruptible by nearby hostiles.
                await operation(() => skills.attackEntity(bot, animal, true));
                if (inventoryCount(bot, item) <= before) throw new Error(`Hunting ${MEAT[item]} yielded no observed ${item}; stop and re-observe.`);
            }
            return;
        }
        if (Object.hasOwn(SMELTED, item)) {
            const input = SMELTED[item];
            const missing = target - inventoryCount(bot, item);
            // Obtain edible raw meat before furnace preparation, so recovery food is
            // available even when the cooking preparation cannot yet be completed.
            await ensure(input, missing, depth + 1);
            if (!bot.findBlock({ matching: block => block.name === 'furnace', maxDistance: 16 })) await ensure('furnace', 1, depth + 1);
            // Coal is explicit so smelting never consumes reserved construction wood.
            await ensure('coal', Math.ceil(missing / 8), depth + 1);
            const before = inventoryCount(bot, item);
            await operation(() => skills.smeltItem(bot, input, missing));
            if (inventoryCount(bot, item) < target) throw new Error(`Smelting produced ${inventoryCount(bot, item) - before} ${item}; desired inventory minimum ${target} not reached.`);
            return;
        }
        if (!CRAFTED.has(item)) throw new Error(`Unsupported ensure_item acquisition for ${item}; supply it through another authored gameplay command.`);
        const recipe = chooseRecipe(item);
        if (!recipe) throw new Error(`No supported crafting recipe for ${item}.`);
        if (recipe.requiresTable && !tableNearby()) await ensure('crafting_table', 1, depth + 1);
        const executions = craftExecutions(observedCount(), target, recipe.result.count);
        // Sticks consume planks: create them before reserving the final plank ingredient.
        const ingredients = recipeIngredients(recipe, bot.registry).sort((a, b) => Number(b.name === 'stick') - Number(a.name === 'stick'));
        for (const ingredient of ingredients) await ensure(ingredient.name, ingredient.count * executions, depth + 1);
        for (const ingredient of ingredients) {
            if (inventoryCount(bot, ingredient.name) < ingredient.count * executions) throw new Error(`Missing reserved ${ingredient.name} after preparation; replan rather than crafting blindly.`);
        }
        // craftRecipe uses the first currently feasible recipe, which may differ from
        // recipesAll's planning choice. Use that actual recipe's yield and input cost.
        const inventoryRecipes = bot.recipesFor(bot.registry.itemsByName[item].id, null, 1, null);
        const ready = (inventoryRecipes.length ? inventoryRecipes : bot.recipesFor(bot.registry.itemsByName[item].id, null, 1, true))[0];
        if (!ready) throw new Error(`No currently feasible recipe for ${item} after preparation.`);
        const actualExecutions = craftExecutions(observedCount(), target, ready.result.count);
        for (const ingredient of recipeIngredients(ready, bot.registry)) {
            if (inventoryCount(bot, ingredient.name) < ingredient.count * actualExecutions) throw new Error(`Actual recipe lacks ${ingredient.name} for desired ${item}; split the preparation program.`);
        }
        await operation(async () => {
            try {
                return await skills.craftRecipe(bot, item, actualExecutions);
            } finally {
                // Inventory (2x2) crafting returns with predicted local slot changes;
                // unlike table crafting, upstream does not fence the final put-away.
                // Read the server's full inventory before reserving dependent inputs.
                await syncInventory();
            }
        });
        if (observedCount() < target) throw new Error(`Crafting ${item} did not reach observed acquired minimum ${target}.`);
    };
    const resolving = new Set();
    const ensure = async (item, target, depth = 0) => {
        check();
        const available = depth === 0 ? acquiredCount(bot, item) : inventoryCount(bot, item);
        if (available >= target) return;
        if (resolving.has(item)) throw new Error(`Cyclic acquisition prerequisites: ${[...resolving, item].join(' -> ')}.`);
        resolving.add(item);
        try {
            return await acquire(item, target, depth);
        } finally { resolving.delete(item); }
    };
    const timer = setTimeout(() => {
        timedOut = true;
        bot.interrupt_code = true;
        bot.pathfinder.setGoal(null);
    }, 120000);
    try {
        // A preceding non-program command may also leave optimistic inventory state.
        check();
        await syncInventory();
        check();
        for (let index = 0; index < program.length; index++) {
            check();
            const step = program[index];
            if (step.action === 'ensure_item') await ensure(step.item, step.count);
            else if (step.action === 'equip') {
                if (!bot.inventory.slots.some(item => item?.name === step.item)) throw new Error(`Cannot equip missing earned ${step.item}.`);
                await operation(() => skills.equip(bot, step.item));
            } else if (step.action === 'build_lodge') {
                if (!helpers.buildLodge) throw new Error('Direct authored lodge helper is not registered.');
                const result = await operation(() => helpers.buildLodge(bot, helpers.getHome(), agent));
                skills.log(bot, result.message);
                if (result.complete !== true) throw new Error('Lodge remains incomplete after earned build batch; re-observe supplies and continue building.');
            } else {
                const home = helpers.getHome();
                if (!home) throw new Error('Cannot regroup before shared home is chosen.');
                if (home.dimension !== bot.game.dimension) throw new Error('Shared home is in another dimension; use an authored portal action.');
                if (bot.entity.position.distanceTo(home) > 3) await operation(() => skills.goToPosition(bot, home.x, home.y, home.z, 3));
                if (bot.entity.position.distanceTo(home) > 4) throw new Error('Regroup did not reach the shared home.');
            }
            check();
            helpers.emit?.(agent, 'program', `${mission.id}: step ${index + 1}/${program.length} ${step.action} completed.`);
        }
        return `Program ${mission.id} completed ${program.length} observed steps; ${operations} gameplay operations. No generated code executed.`;
    } finally { clearTimeout(timer); }
}

export function registerPrograms(actionsList, skills, helpers = {}) {
    actionsList.push({
        name: '!runProgram',
        description: 'Execute the current Terra-authored declarative program using earned resources. Rechecks inventory, stops on mission revisions, and reports unsupported requirements. No arbitrary code.',
        perform: async agent => {
            if (typeof helpers.getMission !== 'function' || typeof helpers.getHome !== 'function') throw new Error('Program mission/home helpers are not registered.');
            let message;
            const result = await agent.actions.runAction('adventure:runProgram', async () => {
                try {
                    message = await executeProgram(agent, skills, helpers);
                    skills.log(agent.bot, message);
                } catch (error) {
                    helpers.emit?.(agent, 'error', `Program: ${error.message}`);
                    throw error;
                } finally {
                    agent.bot.pathfinder.setGoal(null);
                    agent.bot.clearControlStates();
                }
            }, { timeout: 2.1 });
            return result.interrupted || result.success === false ? result.message : message;
        }
    });
}
