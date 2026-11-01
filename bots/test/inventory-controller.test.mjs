import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInventoryController } from '../inventory-controller.mjs'

function fixture () {
  const bot = new EventEmitter()
  const client = bot._client = new EventEmitter()
  bot.inventory = { id: 0, slots: [], selectedItem: null }
  const writes = []
  const ends = []
  client.write = (name, packet) => writes.push({ name, ...packet })
  client.end = reason => ends.push(reason)
  // Model Mineflayer's authoritative handlers, not optimistic click acceptance.
  client.on('window_items', packet => {
    const window = bot.currentWindow || bot.inventory
    window.slots = packet.items
    window.selectedItem = packet.carriedItem
  })
  const Item = { toNotch: item => item, fromNotch: item => item && { ...item, decoded: true } }
  const controller = createInventoryController(bot, Item)
  const ack = sequenceId => client.emit('acknowledge_player_digging', { sequenceId })
  const snapshot = (items, carriedItem = null) => client.emit('window_items', { items, carriedItem })
  return { bot, client, writes, ends, controller, ack, snapshot }
}

test('multiple full snapshots and cursor updates precede the ACK; no optimistic mutation', async () => {
  const f = fixture()
  const cursor = { name: 'oak_log', count: 2 }
  f.bot.inventory.selectedItem = cursor
  let completed = false
  const click = f.controller.click(36, 0, 0).then(() => { completed = true })
  assert.deepEqual(f.writes[0], {
    name: 'window_click', windowId: 0, stateId: -1, slot: 36,
    mouseButton: 0, mode: 0, changedSlots: [], cursorItem: cursor
  })
  assert.equal(f.bot.inventory.selectedItem, cursor)
  f.snapshot([{ name: 'old' }], cursor)
  f.snapshot([{ name: 'oak_planks' }])
  f.client.emit('set_cursor_item', { contents: { name: 'stick', count: 4 } })
  await Promise.resolve()
  assert.equal(completed, false)
  f.ack(f.writes[1].sequence)
  await click
  assert.equal(f.bot.inventory.slots[0].name, 'oak_planks')
  assert.deepEqual(f.bot.inventory.selectedItem, { name: 'stick', count: 4, decoded: true })
})

test('queued clicks serialize strictly and use authoritative pre-click cursor', async () => {
  const f = fixture()
  const first = f.controller.click(36, 0, 0)
  const second = f.controller.click(1, 1, 0)
  assert.equal(f.writes.length, 2)
  const item = { name: 'oak_log', count: 4 }
  f.snapshot([], item)
  f.ack(1)
  await first
  assert.equal(f.writes.length, 4)
  assert.equal(f.writes[2].cursorItem, item)
  assert.equal(f.writes[3].sequence, 2)
  f.ack(1) // earlier ACK cannot complete the second click
  f.ack(2)
  await second
})

test('shared outgoing sequence allocator accepts only known later aggregate ACKs', async () => {
  const f = fixture()
  f.client.write('use_item', { sequence: 900, hand: 0 })
  f.client.write('block_place', { sequence: 0 })
  let completed = false
  const click = f.controller.click(1, 0, 0).then(() => { completed = true })
  assert.deepEqual(f.writes.filter(p => p.sequence).map(p => p.sequence), [1, 2, 3])
  f.ack(1)
  f.ack(2)
  f.ack(99)
  await Promise.resolve()
  assert.equal(completed, false)
  f.client.write('use_item', { sequence: 0, hand: 1 })
  f.ack(4) // server coalesced the fence with a real later outgoing action
  await click
})

for (const event of ['death', 'end', 'kicked']) {
  test(`${event} rejects active and queued clicks and prevents subsequent writes`, async () => {
    const f = fixture()
    const first = assert.rejects(f.controller.click(1, 0, 0), /interrupted/)
    const second = assert.rejects(f.controller.click(2, 0, 0), /interrupted/)
    f.bot.emit(event)
    await Promise.all([first, second])
    await assert.rejects(f.controller.click(3, 0, 0), /interrupted/)
    assert.equal(f.writes.length, 2)
    assert.equal(f.ends.length, 1)
    assert.equal(f.client.listenerCount('acknowledge_player_digging'), 0)
  })
}

test('idle death and respawn leave the new player able to craft', async () => {
  const f = fixture()
  f.client.write('block_dig', { status: 0, location: { x: 2, y: 70, z: 3 } })
  f.bot.emit('death')
  f.client.emit('respawn')
  const click = f.controller.click(1, 0, 0)
  f.ack(2)
  await click
  assert.equal(f.ends.length, 0)
})

test('same-ID replacement invalidates queued window by identity', async () => {
  const f = fixture()
  const first = assert.rejects(f.controller.click(1, 0, 0), /Window replaced/)
  const second = assert.rejects(f.controller.click(2, 0, 0), /Window replaced/)
  f.bot.currentWindow = { id: 0, selectedItem: null }
  f.bot.emit('windowOpen')
  await Promise.all([first, second])
  assert.equal(f.writes.length, 2)
})

test('replacement is checked at ACK even without a window event', async () => {
  const f = fixture()
  const click = assert.rejects(f.controller.click(1, 0, 0), /Window replaced/)
  f.bot.inventory = { id: 0, selectedItem: null }
  f.ack(1)
  await click
})

test('active digging is never aborted to fence a click', async () => {
  const f = fixture()
  f.client.write('block_dig', { status: 0, location: { x: 2, y: 70, z: 3 } })
  await assert.rejects(f.controller.click(1, 0, 0), /active digging/)
  assert.equal(f.writes.length, 1)
  assert.equal(f.ends.length, 0)
})

test('queued click gets its own full timeout after the preceding ACK', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const first = f.controller.click(1, 0, 0)
  const second = f.controller.click(2, 0, 0)
  t.mock.timers.tick(4000)
  f.ack(1)
  await first
  t.mock.timers.tick(4000)
  assert.equal(f.ends.length, 0)
  f.ack(2)
  await second
})

test('timeout rejects the entire queue, removes listeners, and disconnects uncertain state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const first = assert.rejects(f.controller.click(1, 0, 0), /5000ms/)
  const second = assert.rejects(f.controller.click(2, 0, 0), /5000ms/)
  t.mock.timers.tick(5000)
  await Promise.all([first, second])
  f.ack(1)
  t.mock.timers.tick(10000)
  assert.equal(f.writes.length, 2)
  assert.equal(f.ends.length, 1)
  assert.equal(f.client.listenerCount('set_cursor_item'), 0)
})

test('function body can be injected into CommonJS without imports', () => {
  const factory = new Function(`return (${createInventoryController.toString()})`)()
  assert.equal(typeof factory, 'function')
})
