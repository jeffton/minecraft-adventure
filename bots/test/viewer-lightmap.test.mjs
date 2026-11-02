import test from 'node:test';
import assert from 'node:assert/strict';
import { minecraftLighting } from '../viewer-lightmap.mjs';

function pixel(lighting, block, sky) {
  const offset = (sky * 16 + block) * 4;
  return Array.from(lighting.lightmap.slice(offset, offset + 4));
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, received ${actual}`);
}

// Independent reference values from the vanilla 1.21.4 lightmap equations:
// https://mcasset.cloud/1.21.4/assets/minecraft/shaders/core/lightmap.fsh
// Default brightness 0.5, mean BlockFactor 1.5, clear Overworld weather.
// RGB bytes precede texture, face shading and ambient occlusion. Keeping these
// constants, rather than a duplicate equation in the test, catches curve changes.
const golden = [
  { ticks: 18000, block: 0, sky: 0, rgb: [25, 25, 25] },
  { ticks: 6000, block: 0, sky: 15, rgb: [251, 251, 251] },
  { ticks: 12517, block: 0, sky: 15, rgb: [151, 151, 186] },
  { ticks: 13000, block: 0, sky: 15, rgb: [97, 97, 142] },
  { ticks: 18000, block: 0, sky: 15, rgb: [80, 80, 125] },
  { ticks: 18000, block: 1, sky: 0, rgb: [39, 35, 31] },
  { ticks: 18000, block: 4, sky: 0, rgb: [85, 68, 52] },
  { ticks: 18000, block: 7, sky: 0, rgb: [134, 112, 82] },
  { ticks: 18000, block: 10, sky: 0, rgb: [185, 168, 136] },
  { ticks: 18000, block: 12, sky: 0, rgb: [221, 213, 194] },
  { ticks: 18000, block: 13, sky: 0, rgb: [243, 240, 234] },
  { ticks: 18000, block: 14, sky: 0, rgb: [252, 252, 252] },
  { ticks: 18000, block: 15, sky: 0, rgb: [252, 252, 252] },
  { ticks: 18000, block: 7, sky: 9, rgb: [143, 122, 107] },
  { ticks: 12517, block: 4, sky: 12, rgb: [140, 129, 144] },
  { ticks: 6000, block: 9, sky: 4, rgb: [184, 167, 139] },
  { ticks: 6000, block: 15, sky: 15, rgb: [252, 252, 252] }
];

for (const { ticks, block, sky, rgb } of golden) {
  test(`vanilla lightmap golden: ticks ${ticks}, block ${block}, sky ${sky}`, () => {
    const actual = pixel(minecraftLighting(ticks, 'overworld'), block, sky);
    rgb.forEach((expected, channel) => near(actual[channel], expected, 1, `channel ${channel}`));
    assert.equal(actual[3], 255);
  });
}

test('18:31 uses celestial easing and retains visible twilight', () => {
  const lighting = minecraftLighting(12517, 'overworld');
  near(lighting.celestialAngle, 0.2380825913192968, 1e-10, 'celestial angle');
  near(lighting.sun, 0.47969493311234607, 1e-10, 'sun');
  near(lighting.skyFactor, 0.5057101864567287, 1e-10, 'sky factor');
  near(lighting.skyVisibility, 0.6496186663904325, 1e-10, 'sky visibility');
});

test('dusk and dawn are continuous and symmetric, including day and celestial wrap', () => {
  for (const ticks of [0, 6000, 12000, 12517, 13000, 14000, 22000, 23000, 23483, 24000]) {
    const before = minecraftLighting(ticks - 0.01, 'overworld');
    const after = minecraftLighting(ticks + 0.01, 'overworld');
    const angleDistance = Math.abs(before.celestialAngle - after.celestialAngle);
    near(Math.min(angleDistance, 1 - angleDistance), 0, 1e-5, `angle continuity at ${ticks}`);
    for (const field of ['sun', 'skyFactor', 'skyVisibility']) {
      near(before[field], after[field], 1e-4, `${field} continuity at ${ticks}`);
    }
    before.lightmap.forEach((byte, index) => near(byte, after.lightmap[index], 1, `byte ${index} at ${ticks}`));
  }
  for (const ticks of [12000, 12517, 13000, 14000]) {
    const dusk = minecraftLighting(ticks, 'overworld');
    const dawn = minecraftLighting(36000 - ticks, 'overworld');
    near(dusk.sun, dawn.sun, 1e-12, `sun symmetry at ${ticks}`);
    near(dusk.skyVisibility, dawn.skyVisibility, 1e-12, `sky symmetry at ${ticks}`);
    assert.deepEqual(dusk.lightmap, dawn.lightmap);
  }
  for (const ticks of [-1, 0, 12517, 23999]) {
    const original = minecraftLighting(ticks, 'overworld');
    const nextDay = minecraftLighting(ticks + 24000, 'overworld');
    near(original.celestialAngle, nextDay.celestialAngle, 1e-12, '24,000-tick periodicity');
    assert.deepEqual(original.lightmap, nextDay.lightmap);
  }
  assert.ok(minecraftLighting(12000, 'overworld').sun > minecraftLighting(13000, 'overworld').sun);
  assert.ok(minecraftLighting(23000, 'overworld').sun < minecraftLighting(24000, 'overworld').sun);
});

test('cave ambient and every block-only level are independent of time', () => {
  const midday = minecraftLighting(6000, 'overworld');
  for (const ticks of [0, 12517, 13000, 18000, 23000]) {
    const lighting = minecraftLighting(ticks, 'overworld');
    for (let block = 0; block < 16; block++) {
      assert.deepEqual(pixel(lighting, block, 0), pixel(midday, block, 0));
    }
  }
});

test('block and sky contributions combine instead of selecting the brighter source', () => {
  const lighting = minecraftLighting(18000, 'overworld');
  const combined = pixel(lighting, 7, 9);
  const blockOnly = pixel(lighting, 7, 0);
  const skyOnly = pixel(lighting, 0, 9);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(combined[channel] > Math.max(blockOnly[channel], skyOnly[channel]),
      `combined channel ${channel} must exceed either isolated contribution`);
  }
});

test('night outdoors stays visible while a skyless cave stays dark', () => {
  const night = minecraftLighting(18000, 'overworld');
  const cave = pixel(night, 0, 0);
  const outdoors = pixel(night, 0, 15);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(outdoors[channel] > cave[channel] * 3);
  }
  assert.ok(outdoors[2] > outdoors[0], 'moonlit sky light has a cool tint');
  assert.ok(pixel(night, 13, 0)[0] > outdoors[0] * 2, 'furnace light stands out at night');
});

test('non-Overworld viewer lighting does not retain an Overworld night', () => {
  const day = minecraftLighting(6000, 'overworld');
  minecraftLighting(18000, 'overworld');
  for (const dimension of ['the_nether', 'the_end']) {
    const midnight = minecraftLighting(18000, dimension);
    const midday = minecraftLighting(6000, dimension);
    assert.equal(midnight.sun, 1);
    assert.equal(midnight.skyVisibility, 1);
    assert.equal(midnight.skyFactor, 1);
    assert.deepEqual(midnight.lightmap, midday.lightmap);
    assert.deepEqual(midnight.lightmap, day.lightmap);
  }
  assert.equal(minecraftLighting(18000, 'overworld').sun, 0.2);
});

test('lightmap is opaque 16×16 RGBA with sky rows and block columns', () => {
  const lighting = minecraftLighting(18000, 'overworld');
  assert.ok(lighting.lightmap instanceof Uint8Array);
  assert.equal(lighting.lightmap.length, 16 * 16 * 4);
  for (let index = 3; index < lighting.lightmap.length; index += 4) {
    assert.equal(lighting.lightmap[index], 255);
  }
  // Fixed, asymmetric byte offsets detect a transposed block/sky texture.
  assert.deepEqual(Array.from(lighting.lightmap.slice(13 * 4, 13 * 4 + 4)), [243, 240, 234, 255]);
  const sky15Offset = 15 * 16 * 4;
  assert.deepEqual(Array.from(lighting.lightmap.slice(sky15Offset, sky15Offset + 4)), [80, 80, 125, 255]);
});
