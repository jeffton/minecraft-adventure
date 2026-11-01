// Read-only state: deliberately excludes chat, filesystem paths and planner data.
export function viewerState(bot, action) {
  const item = stack => stack ? { name: stack.name, count: stack.count } : null;
  return {
    name: bot.username, at: Date.now(), health: bot.health, food: bot.food,
    position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    action, held: item(bot.heldItem), offhand: item(bot.inventory.slots[45]),
    inventory: bot.inventory.items().map(item),
    moving: Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) > 0.05 || (!bot.entity.onGround && Math.abs(bot.entity.velocity.y) > 0.1),
    digging: bot.targetDigBlock?.name ?? null
  };
}

export function patchViewerServer(source, stateFunction) {
  const replacements = [
    ['http.listen(port, () => {', "http.listen(port, '127.0.0.1', () => {"],
    ['worldView.init(bot.entity.position)', `let initialChunksComplete = false
    let previousManifest = ''
    function sendChunkManifest() {
      if (!initialChunksComplete) return
      const chunks = Object.keys(worldView.loadedChunks).sort()
      const manifest = chunks.join(';')
      if (manifest !== previousManifest) { previousManifest = manifest; socket.emit('adventureChunks', chunks) }
    }
    worldView.init(bot.entity.position).then(() => { initialChunksComplete = true; sendChunkManifest() })`],
    ['worldView.updatePosition(bot.entity.position)', 'worldView.updatePosition(bot.entity.position).then(sendChunkManifest)'],
    ["bot.on('move', botPosition)", `bot.on('move', botPosition)
    botPosition()
    const sendState = () => socket.emit('adventureState', (${stateFunction})(bot, bot.adventureAction()))
    sendState()
    const stateTimer = setInterval(sendState, 1000)
    bot.on('heldItemChanged', sendState)
    bot.inventory.on('updateSlot', sendState)`],
    ["bot.removeListener('move', botPosition)", `bot.removeListener('move', botPosition)
      clearInterval(stateTimer)
      bot.removeListener('heldItemChanged', sendState)
      bot.inventory.removeListener('updateSlot', sendState)`]
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('Upstream live viewer integration changed');
    source = source.replace(before, after);
  }
  return source;
}

// No tween queue: smooth both position and shortest-arc look direction per frame.
export function createCameraMotion() {
  let target;
  let last = 0;
  return {
    receive(viewer, position, yaw, pitch) {
      const next = { x: position.x, y: position.y + viewer.playerHeight, z: position.z, yaw, pitch };
      const camera = viewer.camera;
      if (!target || Math.hypot(next.x - camera.position.x, next.y - camera.position.y, next.z - camera.position.z) > 8) {
        camera.position.set(next.x, next.y, next.z);
        camera.rotation.set(pitch, yaw, 0, 'ZYX');
      }
      target = next;
    },
    frame(viewer, now) {
      if (!target) return;
      const blend = 1 - Math.exp(-Math.min(now - last, 100) / 65);
      last = now;
      const camera = viewer.camera;
      for (const key of ['x', 'y', 'z']) camera.position[key] += (target[key] - camera.position[key]) * blend;
      const arc = Math.atan2(Math.sin(target.yaw - camera.rotation.y), Math.cos(target.yaw - camera.rotation.y));
      camera.rotation.set(camera.rotation.x + (target.pitch - camera.rotation.x) * blend, camera.rotation.y + arc * blend, 0, 'ZYX');
    }
  };
}
