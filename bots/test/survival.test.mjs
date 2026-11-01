import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchBotSource } from '../compat-loader.mjs';

const source = patchBotSource(readFileSync('/opt/minecraft-mindcraft/src/utils/mcdata.js', 'utf8'));
const start = source.indexOf('export function isHostile(');
const end = source.indexOf('\n}', start) + 2;
const hostile = vm.runInNewContext(`(${source.slice(start, end).replace('export ', '')})`);

test('nearby neutral endermen do not trigger combat, angry endermen and ordinary hostiles do', () => {
  const enderman = { name: 'enderman', type: 'hostile', metadata: [] };
  assert.equal(hostile(enderman), false);
  enderman.metadata[17] = false;
  assert.equal(hostile(enderman), false);
  enderman.metadata[17] = true;
  assert.equal(hostile(enderman), true);
  assert.equal(hostile({ name: 'skeleton', type: 'hostile' }), true);
  assert.equal(hostile({ name: 'zombie', type: 'mob' }), true);
  assert.equal(hostile({ name: 'cow', type: 'animal' }), false);
});
