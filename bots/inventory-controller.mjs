// Self-contained: the compatibility loader injects this function into Mineflayer.
export function createInventoryController (bot, Item) {
  const client = bot._client
  const originalWrite = client.write
  const queue = []
  const listeners = []
  let sequence = 0
  let digging = false
  let active = null
  let failure = null
  const windowNow = () => bot.currentWindow || bot.inventory
  function listen (emitter, event, fn) {
    emitter.on(event, fn)
    listeners.push(() => emitter.removeListener(event, fn))
  }
  function fail (message) {
    if (failure) return
    failure = new Error(message)
    for (const entry of queue.splice(0)) {
      clearTimeout(entry.timer)
      entry.reject(failure)
    }
    active = null
    for (const remove of listeners) remove()
    client.write = originalWrite
    if (!client.ended) client.end(`Inventory state uncertain: ${message}`)
  }
  client.write = function (name, packet) {
    if (['block_dig', 'block_place', 'use_item'].includes(name)) {
      packet = { ...packet, sequence: ++sequence }
      if (name === 'block_dig' && packet.status <= 2) digging = packet.status === 0
      if (active?.fence !== undefined) active.watermarks.add(sequence)
    }
    return originalWrite.call(this, name, packet)
  }
  listen(client, 'set_cursor_item', packet => {
    windowNow().selectedItem = Item.fromNotch(packet.contents)
  })
  listen(client, 'acknowledge_player_digging', packet => {
    if (!active || !active.watermarks.has(packet.sequenceId)) return
    if (windowNow() !== active.window) return fail('Window replaced during inventory click')
    const entry = queue.shift()
    clearTimeout(entry.timer)
    active = null
    entry.resolve()
    // Promise continuations see all authoritative packets preceding this ACK.
    pump()
  })
  for (const event of ['end', 'kicked']) {
    listen(bot, event, () => fail(`Inventory controller interrupted: ${event}`))
  }
  const replacePlayer = () => {
    digging = false
    if (active || queue.length) fail('Inventory player interrupted during a click')
  }
  listen(bot, 'death', replacePlayer)
  listen(client, 'end', () => fail('Inventory connection ended'))
  listen(client, 'respawn', replacePlayer)
  for (const event of ['windowOpen', 'windowClose']) {
    listen(bot, event, () => {
      if (active && windowNow() !== active.window) fail('Window replaced during inventory click')
    })
  }
  function pump () {
    if (active || failure || !queue.length) return
    const entry = queue[0]
    if (windowNow() !== entry.window) return fail('Queued inventory window replaced')
    if (digging || bot.targetDigBlock) return fail('Cannot fence inventory click during active digging')
    active = entry
    entry.timer = setTimeout(() => fail('Inventory click timed out after 5000ms'), 5000)
    try {
      // A mismatched revision executes the real click and forces full state;
      // neither the revision nor any individual slot update is an ACK.
      const cursorItem = Item.toNotch(entry.window.selectedItem)
      entry.sent = true
      client.write('window_click', {
        windowId: entry.window.id,
        stateId: -1,
        slot: entry.slot,
        mouseButton: entry.mouseButton,
        mode: entry.mode,
        changedSlots: [],
        cursorItem
      })
      entry.fence = sequence + 1
      entry.watermarks = new Set([entry.fence])
      // Out-of-reach ABORT is acknowledged without touching active block breaks.
      client.write('block_dig', {
        status: 1, location: { x: 0, y: -2048, z: 0 }, face: 0, sequence: entry.fence
      })
    } catch (error) {
      fail(`Inventory click write failed: ${error.message}`)
    }
  }
  return {
    click (slot, mouseButton, mode) {
      const window = windowNow()
      if (failure) return Promise.reject(failure)
      if (digging || bot.targetDigBlock) return Promise.reject(new Error('Cannot fence inventory click during active digging'))
      return new Promise((resolve, reject) => {
        const entry = { window, slot, mouseButton, mode, resolve, reject }
        queue.push(entry)
        pump()
      })
    }
  }
}
