// Read-only observer. Mineflayer does not receive its own server crack packets:
// use its actual start/cancel/finish packets and the same digTime as bot.dig.
export function installViewerBreaking(bot, broadcast, now = () => performance.now()) {
  const active = new Map();
  let own = null;
  const plainPosition = p => ({ x: p.x, y: p.y, z: p.z });
  const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
  const clear = id => {
    if (!active.delete(id)) return;
    if (own?.id === id) own = null;
    broadcast({ id, stage: -1 });
  };
  const update = (id, position, stage) => {
    if (stage < 0 || stage > 9) return clear(id);
    const point = bot.entity.position.offset(position.x - bot.entity.position.x, position.y - bot.entity.position.y, position.z - bot.entity.position.z);
    const block = bot.blockAt(point);
    if (!block?.shapes.length) return clear(id);
    const packet = { id, position: plainPosition(position), stage, shapes: block.shapes };
    const previous = active.get(id);
    active.set(id, { packet, at: now() });
    if (!previous || previous.packet.stage !== stage || !same(previous.packet.position, position)) broadcast(packet);
  };
  const write = bot._client.write;
  function observedWrite(name, packet, ...args) {
    const result = write.call(this, name, packet, ...args);
    if (name !== 'block_dig') return result;
    const id = `own:${bot.entity.id}`;
    if (packet.status === 0) {
      clear(id);
      const block = bot.blockAt(packet.location);
      if (block) {
        own = { id, position: packet.location, started: now(), duration: bot.digTime(block) };
        update(id, packet.location, 0);
      }
    } else if (packet.status === 1 || packet.status === 2) clear(id);
    return result;
  }
  bot._client.write = observedWrite;
  const observed = packet => {
    if (packet.entityId === bot.entity.id) return;
    update(`entity:${packet.entityId}`, packet.location, packet.destroyStage);
  };
  const blockUpdate = (before, after) => {
    const position = after?.position ?? before?.position;
    if (!position) return;
    for (const [id, entry] of active) if (same(entry.packet.position, position)) clear(id);
  };
  const reset = () => {
    own = null;
    active.clear();
    broadcast({ reset: true });
  };
  bot._client.on('block_break_animation', observed);
  bot.on('blockUpdate', blockUpdate);
  for (const event of ['death', 'respawn', 'end']) bot.on(event, reset);
  const timer = setInterval(() => {
    if (own) update(own.id, own.position, Math.min(9, Math.floor((now() - own.started) / own.duration * 10)));
    // Vanilla expires abandoned remote animations after 400 ticks.
    for (const [id, entry] of active) if (id !== own?.id && now() - entry.at > 20000) clear(id);
  }, 40);
  return {
    snapshot: () => [...active.values()].map(entry => entry.packet),
    close() {
      clearInterval(timer);
      if (bot._client.write === observedWrite) bot._client.write = write;
      bot._client.removeListener('block_break_animation', observed);
      bot.removeListener('blockUpdate', blockUpdate);
      for (const event of ['death', 'respawn', 'end']) bot.removeListener(event, reset);
      reset();
    }
  };
}

export function patchViewerBreakingServer(source, installSource) {
  const edits = [
    ["io.on('connection', (socket) => {", `const breaking = (${installSource})(bot, packet => {
    for (const socket of sockets) socket.emit('adventureBreaking', packet)
  })
  io.on('connection', (socket) => {`],
    ['worldView.init(bot.entity.position)', `worldView.init(bot.entity.position)
    for (const packet of breaking.snapshot()) socket.emit('adventureBreaking', packet)`],
    ['bot.viewer.close = () => {', 'bot.viewer.close = () => {\n    breaking.close()']
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Upstream breaking integration changed');
    source = source.replace(before, after);
  }
  return source;
}
