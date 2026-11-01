import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meterCells, itemName } from './inventory.js';

test('pixel meters represent zero, half hearts and exact twenty-point scale', () => {
  assert.deepEqual(meterCells(3.9), [2, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(meterCells(7), [2, 2, 2, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(meterCells(0), Array(10).fill(0));
  assert.deepEqual(meterCells(20), Array(10).fill(2));
  assert.equal(itemName('stone_pickaxe'), 'stone pickaxe');
});
