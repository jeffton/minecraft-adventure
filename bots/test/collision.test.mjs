import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import '../compat-loader.mjs';
const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('minecraft-data')('1.21.4');
const Block = require('prismarine-block')(registry);
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const injectPhysics = require('mineflayer/lib/plugins/physics.js');

function botFixture() {
  const bot = Object.assign(new EventEmitter(), {
    version: '1.21.4', registry, supportFeature: registry.supportFeature,
    _client: Object.assign(new EventEmitter(), { state: 'play', write() {} }),
    inventory: { slots: Array(46) }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: { position: new Vec3(9.305687393083753, 97, -6.305972897049035), velocity: new Vec3(-0.05, -0.0784, 0),
      onGround: false, yaw: 0, pitch: 0, attributes: {}, effects: {}, isInWater: false, isInLava: false }
  });
  bot.blockAt = position => {
    const p = position.floored();
    const solid = p.y === 96 || (p.x === 8 && p.z === -7 && p.y >= 97 && p.y <= 98);
    const block = Block.fromStateId(solid ? registry.blocksByName.grass_block.minStateId : 0, 0);
    block.position = p;
    return block;
  };
  return bot;
}

function firstCollision(physics, bot) {
  const control = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const state = new PlayerState(bot, control);
  return physics.simulatePlayer(state, { getBlock: bot.blockAt });
}

test('client collision box matches Java float dimensions at the observed side-wall failure', () => {
  const baselineBot = botFixture();
  const old = firstCollision(Physics(registry, { getBlock: baselineBot.blockAt }), baselineBot);
  const fixedBot = botFixture();
  injectPhysics(fixedBot, {});
  const fixed = firstCollision(fixedBot.physics, fixedBot);
  const serverHalfWidth = Math.fround(0.6) / 2;
  assert.ok(old.pos.x - serverHalfWidth < 9, 'double 0.3 clips the actual server AABB into the side wall');
  assert.ok(fixed.pos.x - serverHalfWidth >= 9, 'matched float bounds stop at the same surface as the server');
  assert.equal(fixed.onGround, true);
});
