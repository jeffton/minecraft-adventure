import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import '../compat-loader.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('prismarine-registry')('1.21.4');
const Entity = require('prismarine-entity')('1.21.4');
const sourcePath = require.resolve('mineflayer/lib/plugins/entities.js');
const source = readFileSync(sourcePath, 'utf8');

function unpatchedPlugin() {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(createRequire(sourcePath), module, module.exports);
  return module.exports;
}

function fixture(plugin) {
  const bot = new EventEmitter();
  Object.assign(bot, { registry, version: '1.21.4', supportFeature: registry.supportFeature, _client: new EventEmitter(), oxygenLevel: 20 });
  plugin(bot);
  for (const [id, name] of [[1, 'player'], [2, 'dolphin']]) {
    const entity = new Entity(id);
    entity.name = name;
    bot.entities[id] = entity;
  }
  bot.entity = bot.entities[1];
  let breaths = 0;
  bot.on('breath', () => { breaths++; });
  return {
    bot, breaths: () => breaths,
    air(entityId, value) { bot._client.emit('entity_metadata', { entityId, metadata: [{ key: 1, type: 'int', value }] }); },
  };
}

test('installed Mineflayer loader keeps other mobs air from corrupting player survival sensors', () => {
  assert.equal(registry.supportFeature('mcDataHasEntityMetadata'), true);
  const before = fixture(unpatchedPlugin());
  before.air(2, 4530);
  assert.equal(before.bot.oxygenLevel, 302, 'reproduces the live impossible oxygen reading');

  const fixed = fixture(require('mineflayer/lib/plugins/entities.js'));
  fixed.air(2, 4530);
  assert.equal(fixed.bot.oxygenLevel, 20);
  assert.equal(fixed.breaths(), 0);
  fixed.air(1, 105);
  assert.equal(fixed.bot.oxygenLevel, 7);
  fixed.air(2, 4800);
  assert.equal(fixed.bot.oxygenLevel, 7, 'nearby dolphin cannot hide a drowning player');
  assert.equal(fixed.breaths(), 1);
  fixed.air(1, 300);
  assert.equal(fixed.bot.oxygenLevel, 20);
  assert.equal(fixed.breaths(), 2);
});
