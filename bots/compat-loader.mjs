import { registerHooks } from 'node:module';
import { createInventoryController } from './inventory-controller.mjs';
import { patchChunkLightSource } from './chunk-light.mjs';

// Paper 26.3 validates client-tick boundaries. Mineflayer 4.39 supports this
// packet in its protocol registry but omits it from physics/teleport responses.
// Close the real tick at its three source boundaries; do not spam per packet.
export function patchPhysics(source) {
  const edits = [
    ['  const physics = Physics(bot.registry, world)', '  const physics = Physics(bot.registry, world)\n  // Vanilla EntityDimensions stores width/height as Java floats.\n  // Double 0.6/1.8 clips a few nanometres into side walls under strict collision checks.\n  physics.playerHalfWidth = Math.fround(0.6) / 2\n  physics.playerHeight = Math.fround(1.8)'],
    ['      updatePosition(now)\n    }\n  }', "      updatePosition(now)\n      if (bot.supportFeature('sendsClientTickEndPacket')) bot._client.write('tick_end', {})\n    }\n  }"],
    ['        sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)\n', "        sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)\n        if (bot.supportFeature('sendsClientTickEndPacket')) bot._client.write('tick_end', {})\n"],
    ['    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)\n', "    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)\n    if (bot.supportFeature('sendsClientTickEndPacket')) bot._client.write('tick_end', {})\n"]
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Mineflayer physics compatibility integration point changed');
    source = source.replace(before, after);
  }
  return source;
}

export function patchBotSource(source) {
  const marker = 'export function initBot(username) {';
  if (source.split(marker).length !== 2) throw new Error('Mindcraft initBot integration point changed');
  source = source.replace(marker, marker + '\n    mc_version = settings.minecraft_version;');
  const hostile = "return  (mob.type === 'mob' || mob.type === 'hostile') && mob.name !== 'iron_golem' && mob.name !== 'snow_golem';";
  if (source.split(hostile).length !== 2) throw new Error('Mindcraft hostile-entity integration point changed');
  // Endermen are neutral until their 1.21.4 `creepy` metadata flag is set.
  // Proximity alone must not provoke one during unarmoured gathering.
  source = source.replace(hostile, hostile.replace("mob.name !== 'snow_golem'", "mob.name !== 'snow_golem' && (mob.name !== 'enderman' || mob.metadata?.[17] === true)"));
  const start = source.indexOf('    // Throttle position packets');
  const end = source.indexOf('    // Suppress PartialReadError');
  if (start < 0 || end <= start) throw new Error('Upstream movement throttle integration point changed');
  // Physics owns the cadence. A deferred movement can arrive after tick_end.
  return source.slice(0, start) + source.slice(end);
}

export function patchInventorySource(source) {
  const setup = '  let stateId = -1';
  const click = '  async function clickWindow (slot, mouseButton, mode) {';
  const sync = '  async function syncWindow (window) {';
  for (const marker of [setup, click, sync]) {
    if (source.split(marker).length !== 2) throw new Error('Mineflayer inventory integration point changed');
  }
  return source.replace(setup, `${setup}\n  const authoritativeInventory = (${createInventoryController.toString()})(bot, Item)`)
    .replace(click, `${click}\n    if (bot.supportFeature('stateIdUsed')) return authoritativeInventory.click(slot, mouseButton, mode)`)
    .replace(sync, `${sync}\n    if (bot.supportFeature('stateIdUsed')) {\n      if (window !== (bot.currentWindow || bot.inventory)) throw new Error('Inventory window replaced before synchronization')\n      return authoritativeInventory.click(-999, 2, 5)\n    }`);
}

export function patchCraftSource(source) {
  const fabricated = '        const item = new Item(recipe.result.id, recipe.result.count, recipe.result.metadata)\n        window.updateSlot(0, item)';
  const start = source.indexOf('      async function updateOutShape () {');
  const end = source.indexOf('      function slot (x, y) {', start);
  if (source.split(fabricated).length !== 2 || start < 0 || end < start) throw new Error('Mineflayer crafting integration point changed');
  source = source.slice(0, start) + `      async function updateOutShape () {\n        // Server-authoritative clicks already updated consumed ingredients.\n        // Collect only real remainders; never fabricate predicted slot contents.\n        for (let slot = 1; slot <= w * h; slot++) {\n          if (window.slots[slot]) await bot.putAway(slot)\n        }\n      }\n\n` + source.slice(end);
  return source.replace(fabricated, `        const item = window.slots[0]\n        if (!item || item.type !== recipe.result.id || item.count < recipe.result.count) throw new Error('Server did not produce the expected crafting result')`);
}

export function patchPathfinderGoals(source) {
  const before = 'if (node.distanceTo(this.pos.offset(0, this.entityHeight, 0)) > this.reach) return false';
  if (source.split(before).length !== 2) throw new Error('Pathfinder block-reach integration point changed');
  // Broad phase must include any reachable block face. Exact face raycasts below
  // still enforce reach and line of sight; this sphere only rejects distant nodes.
  return source.replace(before, 'if (node.offset(0.5, this.entityHeight, 0.5).distanceTo(this.pos.offset(0.5, 0.5, 0.5)) > this.reach + Math.sqrt(3) / 2) return false');
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const chunkLight = url.endsWith('/node_modules/prismarine-chunk/src/pc/1.18/ChunkColumn.js');
    const physics = url.endsWith('/node_modules/mineflayer/lib/plugins/physics.js');
    const bot = url.endsWith('/minecraft-mindcraft/src/utils/mcdata.js');
    const inventory = url.endsWith('/node_modules/mineflayer/lib/plugins/inventory.js');
    const craft = url.endsWith('/node_modules/mineflayer/lib/plugins/craft.js');
    const goals = url.endsWith('/node_modules/mineflayer-pathfinder/lib/goals.js');
    if (!chunkLight && !physics && !bot && !inventory && !craft && !goals) return result;
    if (result.source == null) throw new Error('Minecraft compatibility source unavailable');
    const source = String(result.source);
    return { ...result, source: chunkLight ? patchChunkLightSource(source) : physics ? patchPhysics(source) : bot ? patchBotSource(source) : inventory ? patchInventorySource(source) : craft ? patchCraftSource(source) : patchPathfinderGoals(source) };
  }
});
