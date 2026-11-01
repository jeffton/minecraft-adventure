import { randomUUID } from 'node:crypto';

export const RPC_DESCRIPTION = `Skills are async JavaScript function bodies with mc.call(method,...args), mc.observe(), input.
Await every call. Returned values are observations, not proof that your whole objective succeeded.
observe() → health, food, oxygen, position, dimension, inventory, nearby entities/blocks.
blockAt({x,y,z}), findBlocks({names:[name],radius:32,count:16}), itemInfo(name), blockInfo(name).
recipesAll(itemName,table=true) shows named ingredients including unmet requirements; recipesFor(itemName,minOutputCount=1,tablePosition=null) returns indexed currently available recipes; craft(itemName,repetitions=1,tablePosition=null,recipeIndex=0) applies a recipe N times (one plank recipe yields four planks).
goto({x,y,z},range=1), follow(entityId,range=2), lookAt({x,y,z}), control(state,boolean), clearControls(), waitTicks(ticks<=200).
dig({x,y,z}), placeBlock(referencePosition,{x,y,z} unit face), activateBlock(position), activateEntity(id), attack(id), equip(itemName,destination='hand'), unequip(destination), consume(), activateItem(offhand=false), deactivateItem(), toss(itemName,count).
openContainer(position) → {handle,items}; containerItems(handle), deposit(handle,itemName,count), withdraw(handle,itemName,count), closeContainer(handle).
openFurnace(position) → {handle,input,fuel,output}; furnaceItems(handle), furnacePutInput(handle,itemName,count), furnacePutFuel(handle,itemName,count), furnaceTakeInput(handle), furnaceTakeFuel(handle), furnaceTakeOutput(handle).
clickWindow(slot,mouseButton,mode), sleep(bedPosition), wake(), stop().
All references are current coordinates/entity IDs/item names, never host object/property paths. Query fresh observations after death or a failed action.`;

function number(value, name, min = -30_000_000, max = 30_000_000) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
function integer(value, name, min = 0, max = 1_000_000) {
  number(value, name, min, max);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer ${name}`);
  return value;
}
function position(value) {
  return { x: number(value?.x, 'x'), y: number(value?.y, 'y', -2048, 2048), z: number(value?.z, 'z') };
}
function packPosition(value) {
  return value ? { x: value.x, y: value.y, z: value.z } : null;
}
function packItem(item) {
  return item ? { name: item.name, count: item.count, slot: item.slot, type: item.type, metadata: item.metadata } : null;
}
function packBlock(block) {
  return block ? { name: block.name, type: block.type, position: packPosition(block.position), properties: block.getProperties?.() ?? {} } : null;
}

/** Explicit low-level Mineflayer boundary. No dynamic property traversal or executable host callbacks. */
export function createMinecraftRpc(bot, { Vec3, goals, onEvent = () => {} }) {
  let busy = false;
  const idleWaiters = new Set();
  let epoch = 0;
  let window;
  let windowHandle;
  let windowKind;
  const vector = value => { const p = position(value); return new Vec3(p.x, p.y, p.z); };
  const block = value => {
    const found = bot.blockAt(vector(value));
    if (!found) throw new Error('Block is not loaded');
    return found;
  };
  const itemType = name => {
    if (typeof name !== 'string' || !Object.hasOwn(bot.registry.itemsByName, name)) throw new Error(`Unknown item: ${name}`);
    return bot.registry.itemsByName[name].id;
  };
  const packRecipe = (recipe, index) => ({
    index,
    result: { ...recipe.result, name: bot.registry.items[recipe.result.id]?.name },
    delta: recipe.delta.map(item => ({ ...item, name: bot.registry.items[item.id]?.name })),
    requiresTable: recipe.requiresTable
  });
  const inventoryItem = name => {
    itemType(name);
    const item = bot.inventory.items().find(value => value.name === name);
    if (!item) throw new Error(`Inventory does not contain ${name}`);
    return item;
  };
  const entity = id => {
    integer(id, 'entity id');
    if (!Object.hasOwn(bot.entities, id)) throw new Error(`Entity ${id} is no longer visible`);
    return bot.entities[id];
  };
  const getWindow = (handle, kind) => {
    if (!window || handle !== windowHandle || (kind && kind !== windowKind)) throw new Error('Container handle is closed or invalid');
    return window;
  };
  const containerItems = value => value.containerItems().map(packItem);
  const furnaceItems = value => ({ input: packItem(value.inputItem()), fuel: packItem(value.fuelItem()), output: packItem(value.outputItem()) });

  function observe() {
    const origin = bot.entity?.position;
    const entities = origin ? Object.values(bot.entities).filter(value => value.position && value.id !== bot.entity.id)
      .map(value => ({ id: value.id, name: value.name, type: value.type, position: packPosition(value.position), distance: value.position.distanceTo(origin) }))
      .filter(value => value.distance <= 64).sort((a, b) => a.distance - b.distance).slice(0, 32) : [];
    const blocks = [];
    if (origin) {
      for (let y = -1; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
          for (let z = -2; z <= 2; z++) {
            const found = bot.blockAt(new Vec3(Math.floor(origin.x) + x, Math.floor(origin.y) + y, Math.floor(origin.z) + z));
            if (found) blocks.push(packBlock(found));
          }
        }
      }
    }
    return {
      at: new Date().toISOString(), health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
      position: packPosition(origin), dimension: bot.game?.dimension,
      time: bot.time ? { timeOfDay: bot.time.timeOfDay, isDay: bot.time.isDay } : null,
      inventory: bot.inventory.items().map(packItem), heldItem: packItem(bot.heldItem), entities, blocks
    };
  }

  function cancel() {
    epoch++;
    bot.pathfinder?.setGoal(null);
    bot.stopDigging();
    bot.clearControlStates();
    bot.deactivateItem();
    if (window) window.close();
    window = undefined;
    windowHandle = undefined;
    windowKind = undefined;
  }

  const methods = {
    observe,
    blockAt: p => packBlock(bot.blockAt(vector(p))),
    findBlocks({ names, radius = 32, count = 16 }) {
      if (!Array.isArray(names) || names.length < 1 || names.length > 32) throw new Error('Provide 1–32 block names');
      const ids = names.map(name => {
        if (typeof name !== 'string' || !Object.hasOwn(bot.registry.blocksByName, name)) throw new Error(`Unknown block: ${name}`);
        return bot.registry.blocksByName[name].id;
      });
      return bot.findBlocks({ matching: ids, maxDistance: number(radius, 'radius', 1, 64), count: integer(count, 'count', 1, 64) })
        .map(p => packBlock(bot.blockAt(p)));
    },
    itemInfo(name) {
      const id = itemType(name);
      const item = bot.registry.items[id];
      return { id, name: item.name, displayName: item.displayName, stackSize: item.stackSize };
    },
    blockInfo(name) {
      if (!Object.hasOwn(bot.registry.blocksByName, name)) throw new Error(`Unknown block: ${name}`);
      const value = bot.registry.blocksByName[name];
      return { id: value.id, name: value.name, hardness: value.hardness, diggable: value.diggable, harvestTools: value.harvestTools, drops: value.drops };
    },
    recipesFor(name, count = 1, table = null) {
      return bot.recipesFor(itemType(name), null, integer(count, 'count', 1, 64), table ? block(table) : null)
        .slice(0, 16).map(packRecipe);
    },
    recipesAll(name, table = true) {
      if (typeof table !== 'boolean') throw new Error('table must be boolean');
      return bot.recipesAll(itemType(name), null, table).slice(0, 32).map(packRecipe);
    },
    async craft(name, count = 1, table = null, recipeIndex = 0) {
      integer(count, 'count', 1, 64);
      const tableBlock = table ? block(table) : null;
      const recipes = bot.recipesFor(itemType(name), null, 1, tableBlock);
      const recipe = recipes[integer(recipeIndex, 'recipe index', 0, 15)];
      if (!recipe) throw new Error(`No currently craftable recipe for ${name}`);
      for (const ingredient of recipe.delta.filter(value => value.count < 0)) {
        const available = bot.inventory.items().filter(value => value.type === ingredient.id &&
          (ingredient.metadata == null || value.metadata === ingredient.metadata)).reduce((sum, value) => sum + value.count, 0);
        if (available + ingredient.count * count < 0) throw new Error(`Insufficient ${bot.registry.items[ingredient.id]?.name} for ${count} recipe repetitions`);
      }
      await bot.craft(recipe, count, tableBlock);
      return observe();
    },
    async goto(p, range = 1) {
      const goal = position(p);
      await bot.pathfinder.goto(new goals.GoalNear(goal.x, goal.y, goal.z, number(range, 'range', 0, 16)));
      return packPosition(bot.entity.position);
    },
    async follow(id, range = 2) {
      await bot.pathfinder.goto(new goals.GoalFollow(entity(id), number(range, 'range', 1, 16)));
      return packPosition(bot.entity.position);
    },
    lookAt: p => bot.lookAt(vector(p), true),
    control(state, value) {
      if (!['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].includes(state) || typeof value !== 'boolean') throw new Error('Invalid control');
      bot.setControlState(state, value);
      return { state, value };
    },
    clearControls() { bot.clearControlStates(); return null; },
    async waitTicks(ticks) { await bot.waitForTicks(integer(ticks, 'ticks', 1, 200)); return observe(); },
    async dig(p) { await bot.dig(block(p)); return packBlock(bot.blockAt(vector(p))); },
    async placeBlock(p, face) {
      const direction = position(face);
      if (Math.abs(direction.x) + Math.abs(direction.y) + Math.abs(direction.z) !== 1 || !Object.values(direction).every(Number.isInteger)) {
        throw new Error('Block face must be an axis-aligned unit vector');
      }
      const reference = block(p);
      await bot.placeBlock(reference, vector(direction));
      return packBlock(bot.blockAt(reference.position.plus(vector(direction))));
    },
    async activateBlock(p) { await bot.activateBlock(block(p)); return observe(); },
    async activateEntity(id) { await bot.activateEntity(entity(id)); return observe(); },
    attack(id) { bot.attack(entity(id)); return { target: id }; },
    async equip(name, destination = 'hand') {
      if (!['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(destination)) throw new Error('Invalid equipment destination');
      await bot.equip(inventoryItem(name), destination);
      return observe();
    },
    async unequip(destination) {
      if (!['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(destination)) throw new Error('Invalid equipment destination');
      await bot.unequip(destination);
      return observe();
    },
    async consume() { await bot.consume(); return observe(); },
    activateItem(offhand = false) {
      if (typeof offhand !== 'boolean') throw new Error('offhand must be boolean');
      bot.activateItem(offhand); return null;
    },
    deactivateItem() { bot.deactivateItem(); return null; },
    async toss(name, count) { await bot.toss(itemType(name), null, integer(count, 'count', 1, 64)); return observe(); },
    async openContainer(p) {
      if (window) throw new Error('Close the current container first');
      const started = epoch;
      const opened = await bot.openContainer(block(p));
      if (started !== epoch) { opened.close(); throw new Error('Container opening was cancelled'); }
      window = opened;
      windowKind = 'container';
      windowHandle = randomUUID();
      return { handle: windowHandle, items: containerItems(window) };
    },
    containerItems(handle) { return containerItems(getWindow(handle, 'container')); },
    async deposit(handle, name, count) {
      const container = getWindow(handle, 'container');
      await container.deposit(itemType(name), null, integer(count, 'count', 1, 64));
      return { inventory: bot.inventory.items().map(packItem), items: containerItems(container) };
    },
    async withdraw(handle, name, count) {
      const container = getWindow(handle, 'container');
      await container.withdraw(itemType(name), null, integer(count, 'count', 1, 64));
      return { inventory: bot.inventory.items().map(packItem), items: containerItems(container) };
    },
    closeContainer(handle) {
      getWindow(handle).close();
      window = undefined; windowHandle = undefined; windowKind = undefined;
      return null;
    },
    async openFurnace(p) {
      if (window) throw new Error('Close the current container first');
      const started = epoch;
      const opened = await bot.openFurnace(block(p));
      if (started !== epoch) { opened.close(); throw new Error('Furnace opening was cancelled'); }
      window = opened; windowKind = 'furnace'; windowHandle = randomUUID();
      return { handle: windowHandle, ...furnaceItems(window) };
    },
    furnaceItems(handle) { return furnaceItems(getWindow(handle, 'furnace')); },
    async furnacePutInput(handle, name, count) {
      const furnace = getWindow(handle, 'furnace');
      await furnace.putInput(itemType(name), null, integer(count, 'count', 1, 64));
      return furnaceItems(furnace);
    },
    async furnacePutFuel(handle, name, count) {
      const furnace = getWindow(handle, 'furnace');
      await furnace.putFuel(itemType(name), null, integer(count, 'count', 1, 64));
      return furnaceItems(furnace);
    },
    async furnaceTakeInput(handle) { return packItem(await getWindow(handle, 'furnace').takeInput()); },
    async furnaceTakeFuel(handle) { return packItem(await getWindow(handle, 'furnace').takeFuel()); },
    async furnaceTakeOutput(handle) { return packItem(await getWindow(handle, 'furnace').takeOutput()); },
    async clickWindow(slot, button, mode) {
      await bot.clickWindow(integer(slot, 'slot', -999, 128), integer(button, 'mouse button', 0, 8), integer(mode, 'click mode', 0, 6));
      return observe();
    },
    async sleep(p) { await bot.sleep(block(p)); return { isSleeping: bot.isSleeping }; },
    async wake() { await bot.wake(); return { isSleeping: bot.isSleeping }; },
    stop() { cancel(); return null; }
  };

  return {
    observe,
    cancel,
    waitForIdle() {
      if (!busy) return Promise.resolve();
      return new Promise(resolve => idleWaiters.add(resolve));
    },
    async call(method, args = [], { signal } = {}) {
      if (!Object.hasOwn(methods, method)) throw new Error(`Minecraft RPC method is not allowed: ${method}`);
      if (!Array.isArray(args) || args.length > 4) throw new Error('RPC arguments must be an array of at most four values');
      signal?.throwIfAborted();
      if (busy) throw new Error('A previous Minecraft RPC is still settling; inspect action status before retry');
      busy = true;
      const started = epoch;
      const abort = () => cancel();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const value = await methods[method](...args);
        signal?.throwIfAborted();
        if (started !== epoch && method !== 'stop') throw new Error('Minecraft RPC was cancelled');
        const result = value ?? null;
        // Bound host serialization before it reaches the sandbox protocol.
        if (Buffer.byteLength(JSON.stringify(result)) > 60_000) throw new Error('Minecraft RPC result exceeds 60 KiB');
        onEvent({ type: 'minecraft-rpc', method, args, result });
        return result;
      } finally {
        signal?.removeEventListener('abort', abort);
        busy = false;
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    }
  };
}
