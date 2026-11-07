import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MINDCRAFT_ROOT || '/opt/minecraft-mindcraft'}/package.json`);
const { Vec3 } = require('vec3');
const makeBlock = require('prismarine-block');

// Local two-pass lighting, adapted from Mineflayer PR #4170, commit
// d823dc9a430d963e1862e134f8d6001329002554 (MIT; PrismarineJS contributors).
// https://github.com/PrismarineJS/mineflayer/pull/4170
/*
 * Copyright (c) 2015 Andrew Kelley
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Only edited blocks seed work. Initial/server light is authoritative; absent
// columns and absent light arrays do not supply light. No world bootstrap pass.
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OPPOSITE = [1, 0, 3, 2, 5, 4];

function faces(shapes) {
  return DIRS.map(([dx, dy, dz]) => {
    const axis = dx ? 0 : dy ? 1 : 2;
    const side = dx + dy + dz > 0 ? 1 : 0;
    const axes = [0, 1, 2].filter(value => value !== axis);
    return shapes.filter(box => box[axis + side * 3] === side)
      .map(box => [box[axes[0]], box[axes[1]], box[axes[0] + 3], box[axes[1] + 3]]);
  });
}

// Two touching partial shapes can collectively seal a face, even when neither
// does alone. Partitioning at actual shape edges handles stairs and slabs exactly.
function covered(rectangles) {
  if (!rectangles.length) return false;
  const xs = [...new Set([0, 1, ...rectangles.flatMap(r => [r[0], r[2]])])].sort((a, b) => a - b);
  const ys = [...new Set([0, 1, ...rectangles.flatMap(r => [r[1], r[3]])])].sort((a, b) => a - b);
  for (let x = 1; x < xs.length; x++) {
    for (let y = 1; y < ys.length; y++) {
      const mx = (xs[x - 1] + xs[x]) / 2;
      const my = (ys[y - 1] + ys[y]) / 2;
      if (!rectangles.some(r => mx >= r[0] && mx <= r[2] && my >= r[1] && my <= r[3])) return false;
    }
  }
  return true;
}

export function createClientRelighter(bot, { hasSkylight }) {
  const Block = makeBlock(bot.registry);
  const states = new Map();
  const crossings = new Map();
  const emptyFaces = DIRS.map(() => []);

  function state(id) {
    if (states.has(id)) return states.get(id);
    const definition = bot.registry.blocksByStateId[id];
    const block = Block.fromStateId(id, 0);
    const props = block.getProperties();
    let emission = definition.emitLight;
    // minecraft-data stores block defaults, not the emission of every state.
    if (['furnace', 'smoker', 'blast_furnace'].includes(block.name)) emission = props.lit ? 13 : 0;
    else if (block.name === 'redstone_lamp') emission = props.lit ? 15 : 0;
    else if (block.name === 'redstone_ore' || block.name === 'deepslate_redstone_ore') emission = props.lit ? 9 : 0;
    else if (block.name === 'glow_lichen') emission = 7;
    else if (block.name.endsWith('copper_bulb')) {
      emission = props.lit ? (block.name.includes('oxidized') ? 4 : block.name.includes('weathered') ? 8 : block.name.includes('exposed') ? 12 : 15) : 0;
    } else if (block.name === 'candle' || block.name.endsWith('_candle')) emission = props.lit ? 3 * Number(props.candles) : 0;
    else if (block.name.endsWith('candle_cake')) emission = props.lit ? 3 : 0;
    else if (block.name === 'sea_pickle') emission = props.waterlogged ? 3 + 3 * Number(props.pickles) : 0;
    else if (block.name === 'light') emission = Number(props.level);
    else if (block.name === 'respawn_anchor') emission = Math.floor(Number(props.charges) * 15 / 4);
    else if (block.name === 'cave_vines' || block.name === 'cave_vines_plant') emission = props.berries ? 14 : 0;
    else if (block.name === 'sculk_sensor' || block.name === 'calibrated_sculk_sensor') emission = props.sculk_sensor_phase === 'active' ? 1 : 0;
    else if (props.lit === false) emission = 0;
    const opacity = props.type === 'double' && block.name.endsWith('_slab') ? 15 : Math.max(definition.filterLight, props.waterlogged ? 1 : 0);
    // Transparent full cubes (glass) must not acquire collision-shape occlusion.
    // Opaque full cubes already block incoming light through opacity. Their own
    // emitted light must be allowed out (e.g. a lit furnace).
    const partial = !definition.transparent && block.shapes.some(box => box.some((value, index) => value !== (index < 3 ? 0 : 1)));
    const value = { emission, opacity, faces: partial ? faces(block.shapes) : emptyFaces };
    states.set(id, value);
    return value;
  }

  function blocked(fromId, toId, direction) {
    const key = `${fromId},${toId},${direction}`;
    if (!crossings.has(key)) crossings.set(key, covered([...state(fromId).faces[direction], ...state(toId).faces[OPPOSITE[direction]]]));
    return crossings.get(key);
  }

  function relight(oldBlock, newBlock) {
    const changed = new Map();
    if (oldBlock.stateId === newBlock.stateId) return changed;
    const before = state(oldBlock.stateId);
    const after = state(newBlock.stateId);
    const transmissionChanged = before.opacity !== after.opacity || JSON.stringify(before.faces) !== JSON.stringify(after.faces);
    if (before.emission === after.emission && !transmissionChanged) return changed;
    const { minY, height } = bot.game;
    const maxY = minY + height - 1;
    const origin = newBlock.position;
    const px = Math.floor(origin.x); const py = Math.floor(origin.y); const pz = Math.floor(origin.z);
    const local = new Vec3(0, 0, 0);
    function columnAt(x, y, z) {
      if (y < minY || y > maxY) return null;
      return bot.world.getColumn(x >> 4, z >> 4);
    }
    function idAt(x, y, z) {
      return columnAt(x, y, z).getBlockStateId(local.set(x & 15, y, z & 15));
    }

    function channel(sky) {
      function get(x, y, z) {
        const column = columnAt(x, y, z);
        if (!column) return -1;
        local.set(x & 15, y, z & 15);
        return sky ? column.getSkyLight(local) : column.getBlockLight(local);
      }
      function set(x, y, z, value) {
        const column = columnAt(x, y, z);
        if (get(x, y, z) === value) return;
        local.set(x & 15, y, z & 15);
        if (sky) column.setSkyLight(local, value);
        else column.setBlockLight(local, value);
        const key = `${(x >> 4) * 16},${(z >> 4) * 16}`;
        if (!changed.has(key)) changed.set(key, new Set());
        changed.get(key).add(Math.floor(y / 16) * 16);
      }
      const add = [];
      const removed = [];
      const initial = get(px, py, pz);
      if (initial < 0) return;
      if (initial > 0) {
        const remove = [[px, py, pz, initial]];
        set(px, py, pz, 0);
        for (let i = 0; i < remove.length; i++) {
          const [x, y, z, level] = remove[i];
          removed.push([x, y, z]);
          for (let d = 0; d < DIRS.length; d++) {
            const [dx, dy, dz] = DIRS[d];
            const nx = x + dx; const ny = y + dy; const nz = z + dz;
            const n = get(nx, ny, nz);
            if (n <= 0) continue;
            if (n < level || (sky && d === 3 && level === 15 && n === 15)) {
              set(nx, ny, nz, 0);
              remove.push([nx, ny, nz, n]);
            } else add.push([nx, ny, nz]);
          }
        }
      }
      // Restore independent emitters only AFTER removal; otherwise the removal
      // wave can repeatedly revisit a source that it has just restored.
      for (const [x, y, z] of [...removed, [px, py, pz]]) {
        const cell = state(idAt(x, y, z));
        // Every exposed world-top cell has an independent sky source. Removal
        // may reach neighbouring water (14), not just the edited cell (15).
        const source = sky
          ? (y === maxY && !covered(cell.faces[2]) ? Math.max(0, 15 - cell.opacity) : 0)
          : cell.emission;
        if (source > get(x, y, z)) set(x, y, z, source);
        if (source > 0) add.push([x, y, z]);
      }
      add.push([px, py, pz]);
      for (const [dx, dy, dz] of DIRS) add.push([px + dx, py + dy, pz + dz]);
      for (let i = 0; i < add.length; i++) {
        const [x, y, z] = add[i];
        const level = get(x, y, z);
        if (level <= 1) continue;
        const sourceId = idAt(x, y, z);
        for (let d = 0; d < DIRS.length; d++) {
          const [dx, dy, dz] = DIRS[d];
          const nx = x + dx; const ny = y + dy; const nz = z + dz;
          const n = get(nx, ny, nz);
          if (n < 0) continue;
          const targetId = idAt(nx, ny, nz);
          const opacity = state(targetId).opacity;
          const next = sky && d === 3 && level === 15 && opacity === 0 ? 15 : level - Math.max(1, opacity);
          if (next > n && !blocked(sourceId, targetId, d)) {
            set(nx, ny, nz, next);
            add.push([nx, ny, nz]);
          }
        }
      }
    }
    if (!columnAt(px, py, pz)) return changed;
    channel(false);
    if (transmissionChanged && hasSkylight()) channel(true);
    return changed;
  }
  return { relight };
}
