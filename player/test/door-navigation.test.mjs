import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { withDoorPassage } from '../door-navigation.mjs';
import { createMinecraftRpc } from '../rpc.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('prismarine-registry')('1.21.4');
const Chunk = require('prismarine-chunk')(registry);
const World = require('prismarine-world')(registry);
const Block = require('prismarine-block')(registry);
const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');
const AStar = require('mineflayer-pathfinder/lib/astar');
const Move = require('mineflayer-pathfinder/lib/move');

function fixture(name = 'acacia_door', facing = 'east', hinge = 'left') {
  const world = new World().sync;
  for (let x = -1; x <= 0; x++) for (let z = -1; z <= 0; z++) {
    world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }));
  }
  const put = (x, y, z, name) => world.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].minStateId);
  for (let x = -3; x <= 3; x++) for (let z = -1; z <= 1; z++) {
    put(x, 0, z, 'stone');
    put(x, 3, z, 'stone');
    if (z !== 0 || Math.abs(x) === 3) for (let y = 1; y <= 2; y++) put(x, y, z, 'stone');
  }
  const door = new Vec3(0, 1, 0);
  function setOpen(open) {
    for (const [y, half] of [[1, 'lower'], [2, 'upper']]) {
      const position = new Vec3(0, y, 0);
      const before = world.getBlock(position);
      const block = Block.fromProperties(registry.blocksByName[name].id, { facing, hinge, half, open, powered: false }, 0);
      world.setBlockStateId(position, block.stateId);
      bot.emit('blockUpdate', before, world.getBlock(position));
    }
  }
  const bot = Object.assign(new EventEmitter(), {
    registry, world, blockAt: position => world.getBlock(position), entities: {},
    entity: { id: 1, position: new Vec3(-1.5, 1, 0.5), effects: {} },
    inventory: { items: () => [] }, health: 20, food: 20, oxygenLevel: 20,
    game: { minY: -64, dimension: 'overworld', gameMode: 'survival' },
    pathfinder: { bestHarvestTool: () => null, setGoal() {} },
    stopDigging() {}, clearControlStates() {}, deactivateItem() {},
  });
  setOpen(false);
  function search(Type, reverse = false) {
    const movements = new Type(bot);
    movements.canDig = false;
    movements.allowParkour = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    const start = reverse ? 2 : -2;
    const astar = new AStar(new Move(start, 1, 0, 0, 0), movements, new goals.GoalBlock(-start, 1, 0), 600, 30, -1);
    let result;
    do { result = astar.compute(); } while (result.status === 'partial');
    return result;
  }
  return { bot, door, setOpen, search, rpc: createMinecraftRpc(bot, { Vec3, goals }) };
}

test('real 1.21.4 Pathfinder crosses opened oak/acacia doors both ways without breaking or placing', () => {
  for (const name of ['oak_door', 'acacia_door']) for (const facing of ['east', 'west', 'north', 'south']) {
    for (const hinge of ['left', 'right']) {
      const f = fixture(name, facing, hinge);
      const DoorMovements = withDoorPassage(Movements);
      assert.equal(f.search(DoorMovements).status, 'noPath', 'closed door stays an obstruction');
      f.setOpen(true);
      assert.equal(f.search(Movements).status, 'noPath', 'reproduce upstream open-door obstruction');
      for (const reverse of [false, true]) {
        const result = f.search(DoorMovements, reverse);
        const aligned = facing === 'east' || facing === 'west';
        assert.equal(result.status, aligned ? 'success' : 'noPath', 'the opened panel still blocks crossing its solid side');
        if (aligned) {
          assert.ok(result.path.some(node => node.x === 0));
          assert.ok(result.path.every(node => node.toBreak.length === 0 && node.toPlace.length === 0));
        }
      }
    }
  }
});

test('diagonal door entry respects the hinge-side panel instead of cutting through it', () => {
  for (const hinge of ['left', 'right']) {
    const f = fixture('acacia_door', 'east', hinge);
    for (const x of [-1, 0]) for (const y of [1, 2]) {
      f.bot.world.setBlockStateId(new Vec3(x, y, -1), registry.blocksByName.air.minStateId);
    }
    f.setOpen(true);
    const movements = new (withDoorPassage(Movements))(f.bot);
    movements.canDig = false;
    movements.scafoldingBlocks = [];
    const neighbors = movements.getNeighbors(new Move(-1, 1, -1, 0, 0));
    const entersDoor = neighbors.some(node => node.x === 0 && node.y === 1 && node.z === 0);
    assert.equal(entersDoor, hinge === 'right');
  }
});

test('door activation returns server-confirmed open/closed properties, not the sent interaction', async () => {
  const f = fixture();
  let open = false;
  let completeInteraction;
  f.bot.activateBlock = async () => { await new Promise(resolve => { completeInteraction = resolve; }); };
  for (const desired of [true, false]) {
    let settled = false;
    const pending = f.rpc.call('activateBlock', [f.door]).then(value => { settled = true; return value; });
    completeInteraction();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'sending use-block is not a server acknowledgement');
    open = desired;
    f.setOpen(open);
    const result = await pending;
    const observed = result.blocks.find(block => block.position.x === 0 && block.position.y === 1 && block.position.z === 0);
    assert.equal(observed.properties.open, desired);
    assert.equal(f.bot.listenerCount('blockUpdate'), 0);
  }
});

test('cancelled door activation drains a delayed Mineflayer send before releasing the RPC', async () => {
  const f = fixture();
  let finishSend;
  f.bot.activateBlock = () => new Promise(resolve => { finishSend = resolve; });
  const pending = f.rpc.call('activateBlock', [f.door]);
  f.rpc.cancel();
  let idle = false;
  const drained = f.rpc.waitForIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);
  await assert.rejects(f.rpc.call('observe'), /still settling/);
  finishSend();
  await assert.rejects(pending, /cancelled/);
  await drained;
  assert.equal(idle, true);
  assert.equal(f.bot.listenerCount('blockUpdate'), 0);
});

test('door activation cancellation and send failures remove the block-update waiter', async () => {
  for (const failure of ['cancel', 'send']) {
    const f = fixture();
    f.bot.activateBlock = async () => { if (failure === 'send') throw new Error('Disconnected'); };
    const pending = f.rpc.call('activateBlock', [f.door]);
    if (failure === 'cancel') f.rpc.cancel();
    await assert.rejects(pending, failure === 'cancel' ? /cancelled/ : /Disconnected/);
    assert.equal(f.bot.listenerCount('blockUpdate'), 0);
  }
});
