import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeModernGeometry, rotatePoint } from '../viewer-modern-entities.mjs';

const cube = { origin: [0, 0, 0], size: [2, 4, 6], uv: [0, 0] };
const document = bones => ({ 'minecraft:geometry': [{ description: { texture_width: 32, texture_height: 16 }, bones }] });
const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-10, `${actual} != ${expected}`));

test('cube rotation uses its own pivot, then parent rotations in model space', () => {
  const model = bakeModernGeometry(document([
    { name: 'parent', pivot: [0, 0, 0], rotation: [0, 0, 90] },
    { name: 'child', parent: 'parent', pivot: [2, 0, 0], rotation: [0, 90, 0],
      cubes: [{ origin: [2, 0, 0], size: [2, 2, 2], uv: [0, 0], pivot: [2, 0, 0], rotation: [0, 0, 90] }] }
  ]));
  // First top vertex (2,2,2): cube -> (4,0,2), child -> (0,0,2), parent -> (0,0,2).
  close(model.positions.slice(0, 3), [0, 0, 2 / 16]);
  close(model.normals.slice(0, 3), [0, 0, 1]);
});

test('all six faces preserve legacy box atlas layout', () => {
  const model = bakeModernGeometry(document([{ name: 'body', cubes: [cube] }]));
  const pixels = model.uvs.map((value, index) => value * (index % 2 ? 16 : 32));
  assert.deepEqual(pixels, [
    6, 0, 8, 0, 6, 6, 8, 6,
    8, 0, 10, 0, 8, 6, 10, 6,
    0, 6, 0, 10, 6, 6, 6, 10,
    8, 6, 8, 10, 14, 6, 14, 10,
    6, 10, 8, 10, 6, 6, 8, 6,
    14, 10, 16, 10, 14, 6, 16, 6
  ]);
});

test('mirror swaps east/west faces while maintaining outward winding and normals', () => {
  const model = bakeModernGeometry(document([{ name: 'body', cubes: [{ ...cube, mirror: true }] }]));
  close(model.positions.slice(2 * 12, 2 * 12 + 3), [0, 4 / 16, 6 / 16]);
  close(model.normals.slice(2 * 12, 2 * 12 + 3), [-1, 0, 0]);
  for (let i = 0; i < model.indices.length; i += 3) {
    const [a, b, c] = model.indices.slice(i, i + 3).map(index => model.positions.slice(index * 3, index * 3 + 3));
    const u = b.map((v, j) => v - a[j]);
    const v = c.map((n, j) => n - a[j]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const normal = model.normals.slice(model.indices[i] * 3, model.indices[i] * 3 + 3);
    assert.ok(cross.reduce((sum, value, j) => sum + value * normal[j], 0) > 0);
  }
});

test('hidden pose parts are omitted and zero-depth planes retain unit normals', () => {
  const model = bakeModernGeometry(document([
    { name: 'body', cubes: [{ ...cube, size: [2, 4, 0] }] },
    { name: 'rolled', cubes: [cube] }
  ]), { hiddenBones: ['rolled'] });
  assert.equal(model.positions.length, 72);
  for (let i = 0; i < model.normals.length; i += 3) close([Math.hypot(...model.normals.slice(i, i + 3))], [1]);
});

test('nonzero pivots do not translate a zero rotation and clockwise angles match viewer axes', () => {
  close(rotatePoint([1, 2, 3], [0, 0, 0], [5, 6, 7]), [1, 2, 3]);
  close(rotatePoint([1, 0, 0], [0, 0, 90]), [0, -1, 0]);
});

test('noncommuting rotations follow the schema X then Y then Z, not THREE Euler XYZ', () => {
  close(rotatePoint([1, 2, 3], [90, 90, 90]), [3, -2, 1]);
});

test('cube rotation without an explicit pivot uses its uninflated center', () => {
  const model = bakeModernGeometry(document([{ name: 'body', cubes: [
    { ...cube, origin: [10, 0, 0], rotation: [0, 0, 90] }
  ] }]));
  // Top corner (10,4,6), rotated around cube center (11,2,3).
  close(model.positions.slice(0, 3), [13 / 16, 3 / 16, 6 / 16]);
});

test('unsupported per-face UVs fail visibly instead of generating invalid buffers', () => {
  assert.throws(() => bakeModernGeometry(document([{ name: 'body', cubes: [{ ...cube, uv: {} }] }])), /box UV/);
});
