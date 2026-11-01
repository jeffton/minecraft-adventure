import { mkdir, readFile, writeFile, rmdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const { Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const FACINGS = {
    north: { x: 0, z: -1, yaw: 0 },
    south: { x: 0, z: 1, yaw: Math.PI },
    east: { x: 1, z: 0, yaw: -Math.PI / 2 },
    west: { x: -1, z: 0, yaw: Math.PI / 2 }
};
const vec = p => new Vec3(p.x, p.y, p.z);
const position = p => ({ x: p.x, y: p.y, z: p.z });
const count = (items, name) => items.filter(item => item?.name === name).reduce((sum, item) => sum + item.count, 0);
const snapshot = items => items.filter(Boolean).map(({ name, count }) => ({ name, count }));

// The caller owns the mission/deadline scope. run must drain interrupted operations
// before returning/rejecting, so a late click cannot escape the container lock.
export function createBaseUtilities({ lockDirectory }) {
    const key = (bot, p) => createHash('sha256').update(JSON.stringify([bot.game.dimension, p.x, p.y, p.z])).digest('hex');
    const recordPath = (bot, p) => join(lockDirectory, `${key(bot, p)}.bed.json`);

    function guard(bot, home, p, context) {
        context.check();
        if (bot.interrupt_code || bot.health <= 0 || bot.game.gameMode !== 'survival' || bot.modes?.isOn('cheat')) throw new Error('Base utility requires active survival control.');
        if (!home || home.dimension !== bot.game.dimension) throw new Error('Shared home is missing or in another dimension.');
        if (![p.x, p.y, p.z, home.x, home.y, home.z].every(Number.isInteger) ||
            Math.abs(p.x - home.x) > 12 || Math.abs(p.z - home.z) > 12 || Math.abs(p.y - home.y) > 4) throw new Error('Utility position must be an integer position within the shared home.');
        if (!bot.blockAt(vec(p))) throw new Error('Utility block is not loaded.');
    }

    async function locked(bot, home, p, context, operation, footprint = [p]) {
        guard(bot, home, p, context);
        await mkdir(lockDirectory, { recursive: true });
        const acquired = [];
        let retainLocks = false;
        try {
            // Placement reserves neighbors too, so two independently delayed
            // single-chest placements cannot merge behind coordinate-only locks.
            for (const lockKey of [...new Set(footprint.map(part => key(bot, part)))].sort()) {
                const path = join(lockDirectory, `${lockKey}.lock`);
                try { await mkdir(path); } catch (error) {
                    if (error.code === 'EEXIST') throw new Error('Base utility is busy (or a prior owner disconnected); re-observe rather than overlapping operations.');
                    throw error;
                }
                acquired.push(path);
            }
            guard(bot, home, p, context);
            return await operation();
        } catch (error) {
            retainLocks = error.retainUtilityLock === true;
            throw error;
        } finally {
            if (!retainLocks) for (const path of acquired.reverse()) await rmdir(path);
        }
    }

    async function reach(bot, home, p, context) {
        guard(bot, home, p, context);
        const movements = new Movements(bot);
        movements.canDig = false;
        movements.allow1by1towers = false;
        movements.allowParkour = false;
        movements.maxDropDown = 2;
        movements.scafoldingBlocks = [];
        bot.pathfinder.setMovements(movements);
        await context.run(() => bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)));
        guard(bot, home, p, context);
        const block = bot.blockAt(vec(p));
        if (bot.entity.position.offset(0, 1.62, 0).distanceTo(vec(p).offset(0.5, 0.5, 0.5)) > 4.5 || !bot.canSeeBlock(block)) throw new Error('Utility block is not reachable and visible.');
        return block;
    }

    function singleChest(bot, p) {
        const block = bot.blockAt(vec(p));
        if (block?.name !== 'chest' || block.getProperties().type !== 'single') throw new Error('Expected a loaded single shared chest. Double chests are not supported.');
        for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const adjacent = bot.blockAt(vec(p).offset(x, 0, z));
            if (!adjacent || adjacent.name === 'chest') throw new Error('Shared chest must have loaded non-chest neighbors, preventing alias locks.');
        }
        if (bot.blockAt(vec(p).offset(0, 1, 0))?.boundingBox !== 'empty') throw new Error('Shared chest lid is obstructed or unloaded.');
        return block;
    }

    async function sync(bot, context, window = bot.inventory) {
        await context.run(() => bot._syncWindow(window));
        context.check();
        if ((bot.currentWindow || bot.inventory) !== window) throw new Error('Inventory window changed during utility operation.');
        if (window.selectedItem) throw new Error('Inventory cursor is occupied; resolve it before another utility operation.');
    }

    async function place(bot, home, p, itemName, context, facing, footprint = [vec(p)]) {
        const target = bot.blockAt(vec(p));
        if (!target || !AIR.has(target.name)) throw new Error('Utility placement is obstructed; no existing blocks will be destroyed.');
        const supportPosition = vec(p).offset(0, -1, 0);
        const support = await reach(bot, home, supportPosition, context);
        if (support.boundingBox !== 'block' || !/^(grass_block|dirt|stone|cobblestone|sand|red_sand|[a-z_]+_planks|[a-z_]+_log)$/.test(support.name)) throw new Error('Utility needs a plain solid building support, not an interactive block.');
        await sync(bot, context);
        const before = count(bot.inventory.items(), itemName);
        if (before < 1) throw new Error(`Need an earned ${itemName} in inventory.`);
        await context.run(() => bot.equip(bot.inventory.items().find(item => item.name === itemName), 'hand'));
        // Do not let a replacement block or equipment delay turn placement into
        // interaction with a foreign block. Only click a plain solid support.
        const checkSite = () => {
            guard(bot, home, p, context);
            if (itemName === 'chest' && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => {
                const adjacent = bot.blockAt(vec(p).offset(x, 0, z));
                return !adjacent || adjacent.name === 'chest';
            })) throw new Error('Chest neighbors changed before placement.');
            if (bot.blockAt(supportPosition)?.type !== support.type || footprint.some(part =>
                !AIR.has(bot.blockAt(part)?.name) || bot.blockAt(part.offset(0, -1, 0))?.boundingBox !== 'block' ||
                !AIR.has(bot.blockAt(part.offset(0, 1, 0))?.name))) throw new Error('Placement site changed or lacks clear headroom.');
        };
        if (facing) {
            await context.run(() => bot.look(FACINGS[facing].yaw, 0, true));
            checkSite();
            await context.run(() => bot._placeBlockWithOptions(support, new Vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right' }));
        } else {
            checkSite();
            await context.run(() => bot.placeBlock(support, new Vec3(0, 1, 0)));
        }
        guard(bot, home, p, context);
        await sync(bot, context);
        const after = count(bot.inventory.items(), itemName);
        if (bot.blockAt(vec(p))?.name !== itemName || after !== before - 1) throw new Error(`Placement of ${itemName} not confirmed by block and inventory; inspect before retrying.`);
        return { item: itemName, before, after, position: position(p) };
    }

    async function verifyChest(bot, home, p, context) {
        return locked(bot, home, p, context, async () => {
            if (bot.blockAt(vec(p)).name !== 'chest') return null;
            singleChest(bot, p);
            return { placed: false, position: position(p), block: 'chest' };
        });
    }

    async function ensureChest(bot, home, p, context) {
        return locked(bot, home, p, context, async () => {
            if (bot.blockAt(vec(p)).name === 'chest') {
                singleChest(bot, p);
                return { placed: false, position: position(p), block: 'chest' };
            }
            for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const adjacent = bot.blockAt(vec(p).offset(x, 0, z));
                if (!adjacent || adjacent.name === 'chest') throw new Error('Chest placement requires loaded non-chest neighbors.');
            }
            const result = await place(bot, home, p, 'chest', context);
            singleChest(bot, p);
            return { placed: true, ...result };
        }, [p, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => vec(p).offset(x, 0, z))]);
    }

    async function transferChest(bot, home, p, { direction, item, count: quantity, receiptKey }, context) {
        if (!['deposit', 'withdraw'].includes(direction) || !Number.isInteger(quantity) || quantity < 1 || quantity > 64 || !bot.registry.itemsByName[item]) throw new Error('Transfer requires deposit/withdraw, a registry item, and count 1..64.');
        return locked(bot, home, p, context, async () => {
            const receiptPath = receiptKey === undefined ? null : join(lockDirectory,
                `${createHash('sha256').update(JSON.stringify([bot.username, receiptKey])).digest('hex')}.transfer.json`);
            if (receiptPath) {
                let receipt;
                try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
                context.check();
                if (receipt?.status === 'confirmed') return { ...receipt.result, replayed: true };
                if (receipt) throw new Error('Earlier transfer intent is unresolved; actual movement is ambiguous. Inspect observations before issuing a new mission, never blindly replay this step.');
            }
            await reach(bot, home, p, context);
            const block = singleChest(bot, p);
            let chest;
            try {
                if (bot.currentWindow) throw new Error('Close the existing inventory window before using a chest.');
                await context.run(async () => { chest = await bot.openChest(block); });
                await sync(bot, context, chest);
                guard(bot, home, p, context);
                singleChest(bot, p);
                const state = () => ({
                    inventory: count(chest.slots.slice(chest.inventoryStart, chest.inventoryEnd), item),
                    container: count(chest.containerItems(), item),
                    containerItems: snapshot(chest.containerItems())
                });
                const before = state();
                if ((direction === 'deposit' ? before.inventory : before.container) < quantity) throw new Error('Transfer source lacks the requested actual item count.');
                if (receiptPath) {
                    await writeFile(receiptPath, JSON.stringify({ status: 'pending', direction, item, count: quantity, position: position(p), before }), { flag: 'wx', mode: 0o640 });
                }
                await context.run(() => chest[direction](bot.registry.itemsByName[item].id, null, quantity));
                await sync(bot, context, chest);
                guard(bot, home, p, context);
                singleChest(bot, p);
                const after = state();
                const delta = direction === 'deposit' ? quantity : -quantity;
                if (before.inventory - after.inventory !== delta || after.container - before.container !== delta) throw new Error(`Chest transfer counts do not confirm ${quantity} ${item}; inspect current state before retrying.`);
                const result = { direction, item, count: quantity, position: position(p), before, after, confirmed: true, observedAt: new Date().toISOString() };
                if (receiptPath) {
                    const temporary = `${receiptPath}.${process.pid}.tmp`;
                    await writeFile(temporary, JSON.stringify({ status: 'confirmed', result }), { flag: 'w', mode: 0o640 });
                    await rename(temporary, receiptPath);
                }
                return result;
            } finally {
                if (chest && bot.currentWindow === chest) await chest.close();
            }
        });
    }

    async function matchingOwnedBed(bot, p, item, facing) {
        const head = vec(p).offset(FACINGS[facing].x, 0, FACINGS[facing].z);
        if (bot.blockAt(vec(p))?.name !== item) return null;
        let owned;
        try { owned = JSON.parse(await readFile(recordPath(bot, p), 'utf8')); } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
        if (owned.owner !== bot.username || owned.item !== item || owned.facing !== facing || owned.dimension !== bot.game.dimension ||
            bot.blockAt(vec(p)).getProperties().part !== 'foot' || bot.blockAt(head)?.name !== item || bot.blockAt(head).getProperties().part !== 'head' ||
            bot.blockAt(vec(p)).getProperties().facing !== facing || bot.blockAt(head).getProperties().facing !== facing) return null;
        return { placed: false, item, position: position(p), head: position(head), owned: true, spawnConfirmed: false };
    }

    async function verifyOwnedBed(bot, home, p, item, facing, context) {
        return locked(bot, home, p, context, async () => {
            const result = await matchingOwnedBed(bot, p, item, facing);
            guard(bot, home, p, context);
            return result;
        });
    }

    async function placeBed(bot, home, p, item, facing, context) {
        if (!Object.hasOwn(FACINGS, facing) || !/^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_bed$/.test(item)) throw new Error('Specify a real colored bed and cardinal facing.');
        return locked(bot, home, p, context, async () => {
            // The home planner assigns disjoint bed footprints. Existing beds
            // are reusable only when this bot's own placement record matches.
            const head = vec(p).offset(FACINGS[facing].x, 0, FACINGS[facing].z);
            if (bot.blockAt(vec(p))?.name === item) {
                const existing = await matchingOwnedBed(bot, p, item, facing);
                guard(bot, home, p, context);
                if (!existing) throw new Error('Existing bed is not this bot’s matching recorded owned bed.');
                return existing;
            }
            for (const part of [vec(p), head]) {
                guard(bot, home, part, context);
                if (!AIR.has(bot.blockAt(part)?.name) || !AIR.has(bot.blockAt(part.offset(0, 1, 0))?.name) || bot.blockAt(part.offset(0, -1, 0))?.boundingBox !== 'block') throw new Error('Bed requires two clear loaded spaces with solid supports and headroom.');
            }
            const result = await place(bot, home, p, item, context, facing, [vec(p), head]);
            const footBlock = bot.blockAt(vec(p));
            const headBlock = bot.blockAt(head);
            if (footBlock?.getProperties().part !== 'foot' || headBlock?.name !== item || headBlock.getProperties().part !== 'head' || footBlock.getProperties().facing !== facing || headBlock.getProperties().facing !== facing) throw new Error('Server did not confirm both oriented bed halves.');
            const ownership = { owner: bot.username, item, foot: position(p), head: position(head), facing, dimension: bot.game.dimension };
            await writeFile(recordPath(bot, p), JSON.stringify(ownership), { flag: 'w', mode: 0o640 });
            return { ...result, placed: true, head: position(head), owned: true, spawnConfirmed: false };
        });
    }

    async function useBed(bot, home, p, context) {
        return locked(bot, home, p, context, async () => {
            if (!['overworld', 'minecraft:overworld'].includes(bot.game.dimension)) throw new Error('Bed interaction is restricted to the Overworld; other dimensions explode.');
            const owned = JSON.parse(await readFile(recordPath(bot, p), 'utf8'));
            if (owned.owner !== bot.username || owned.dimension !== bot.game.dimension) throw new Error('This is not the bot’s recorded owned bed.');
            await reach(bot, home, p, context);
            for (const [part, pos] of [['foot', owned.foot], ['head', owned.head]]) {
                const block = bot.blockAt(vec(pos));
                if (block?.name !== owned.item || block.getProperties().part !== part || block.getProperties().facing !== owned.facing) throw new Error('Owned bed no longer matches the observed world.');
            }
            let spawnConfirmed = false;
            let slept = false;
            const messages = [];
            const onMessage = (message, channel, sender) => {
                // Never accept player chat, translated English text or the world
                // spawn_position packet as an acknowledgement of personal spawn.
                if (sender != null || channel === 'chat') return;
                if (message.translate === 'block.minecraft.set_spawn') spawnConfirmed = true;
                if (message.translate?.startsWith('block.minecraft.bed.')) messages.push(message.translate);
            };
            const onSleep = () => { slept = true; };
            const onReset = () => { spawnConfirmed = false; };
            bot.on('message', onMessage);
            bot.on('sleep', onSleep);
            bot.on('spawnReset', onReset);
            try {
                // Raw vanilla interaction also sets spawn during daylight; bot.sleep
                // rejects daylight locally. The server itself chooses valid sleep.
                await context.run(() => bot.activateBlock(bot.blockAt(vec(p))));
                await context.run(() => new Promise(resolve => setTimeout(resolve, 3000)), { passive: true });
                guard(bot, home, p, context);
                return { position: position(p), head: owned.head, spawnConfirmed, slept, sleeping: bot.isSleeping === true, messages,
                    confirmation: spawnConfirmed ? 'Server system translation block.minecraft.set_spawn observed during bed interaction.' : 'No personal-spawn acknowledgement observed. Sleep or compass spawn alone is not confirmation.' };
            } finally {
                bot.removeListener('message', onMessage);
                bot.removeListener('sleep', onSleep);
                bot.removeListener('spawnReset', onReset);
            }
        });
    }

    return { ensureChest, transferChest, placeBed, useBed, verifyOwnedBed, verifyChest };
}
