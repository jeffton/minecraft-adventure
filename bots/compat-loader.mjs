import { registerHooks } from 'node:module';

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
  const start = source.indexOf('    // Throttle position packets');
  const end = source.indexOf('    // Suppress PartialReadError');
  if (start < 0 || end <= start) throw new Error('Upstream movement throttle integration point changed');
  // Physics owns the cadence. A deferred movement can arrive after tick_end.
  return source.slice(0, start) + source.slice(end);
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const physics = url.endsWith('/node_modules/mineflayer/lib/plugins/physics.js');
    const bot = url.endsWith('/minecraft-mindcraft/src/utils/mcdata.js');
    if (!physics && !bot) return result;
    if (result.source == null) throw new Error('Minecraft compatibility source unavailable');
    return { ...result, source: physics ? patchPhysics(String(result.source)) : patchBotSource(String(result.source)) };
  }
});
