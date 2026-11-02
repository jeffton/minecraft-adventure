// Server-propagated light only: no client flood fill or synthetic point lights.
export function trackViewerLightColumns(bot) {
  const ready = new Set();
  bot.roycraftLightColumns = ready;
  bot._client.on('map_chunk', packet => ready.add(`${packet.x * 16},${packet.z * 16}`));
  bot._client.on('unload_chunk', packet => ready.delete(`${packet.chunkX * 16},${packet.chunkZ * 16}`));
  // Mineflayer retains columns on same-dimension respawn. Invalidate only the
  // columns it actually unloads (also covers a real dimension/world switch).
  bot.on('chunkColumnUnload', pos => ready.delete(`${pos.x},${pos.z}`));
}

// Installed after Mineflayer's synchronous update_light handler. Each viewer has
// its own subscription and bounded, coalesced pending set; socket order is kept.
export function installViewerLightStream(bot, worldView, socket) {
  const pending = new Map();
  let closed = false;
  const loads = new Map();
  worldView.loadChunk = async pos => {
    const key = `${pos.x},${pos.z}`;
    const ticket = {};
    if (closed || !bot.roycraftLightColumns.has(key)) return;
    loads.set(key, ticket);
    const column = await bot.world.getColumnAt(pos);
    const dx = Math.abs(Math.floor(worldView.lastPos.x / 16) - pos.x / 16);
    const dz = Math.abs(Math.floor(worldView.lastPos.z / 16) - pos.z / 16);
    if (closed || loads.get(key) !== ticket || !column || !bot.roycraftLightColumns.has(key) || dx >= worldView.viewDistance || dz >= worldView.viewDistance) return;
    loads.delete(key);
    socket.emit('loadChunk', { x: pos.x, z: pos.z, chunk: column.toJson() });
    worldView.loadedChunks[key] = true;
  };
  const receive = packet => {
    const x = packet.chunkX * 16;
    const z = packet.chunkZ * 16;
    const key = `${x},${z}`;
    if (!worldView.loadedChunks[key] || !bot.roycraftLightColumns.has(key)) return;
    const column = bot.world.getColumn(packet.chunkX, packet.chunkZ);
    if (!column) return;
    const sections = pending.get(key) ?? new Set();
    const masks = [packet.skyLightMask, packet.blockLightMask, packet.emptySkyLightMask, packet.emptyBlockLightMask];
    for (let index = 0; index < column.worldHeight / 16 + 2; index++) {
      const word = Math.floor(index / 64);
      const half = index % 64 < 32 ? 1 : 0;
      if (masks.some(mask => ((mask[word]?.[half] ?? 0) >>> (index % 32)) & 1)) sections.add(column.minY + (index - 1) * 16);
    }
    pending.set(key, sections);
  };
  const unload = pos => {
    const key = `${pos.x},${pos.z}`;
    pending.delete(key);
    loads.delete(key);
    if (worldView.loadedChunks[key]) worldView.unloadChunk(pos);
  };
  bot._client.on('update_light', receive);
  bot.on('chunkColumnUnload', unload);
  const timer = setInterval(() => {
    for (const [key, sections] of pending) {
      pending.delete(key);
      if (!worldView.loadedChunks[key] || !bot.roycraftLightColumns.has(key)) continue;
      const [x, z] = key.split(',').map(Number);
      const column = bot.world.getColumn(x / 16, z / 16);
      if (column) socket.emit('lightColumn', { x, z, sections: [...sections], light: column.dumpLight() });
    }
  }, 100);
  socket.once('disconnect', () => {
    closed = true;
    loads.clear();
    pending.clear();
    clearInterval(timer);
    bot._client.off('update_light', receive);
    bot.off('chunkColumnUnload', unload);
  });
}

// Run inside the mesher worker after geometry generation. Sampling the column
// directly avoids upstream's block cache (shared by state ID, not position).
export function attachGeometryLight(geometry, world) {
  const light = new Float32Array(geometry.positions.length / 3 * 2);
  function sample(x, y, z) {
    const cx = Math.floor(x / 16) * 16;
    const cz = Math.floor(z / 16) * 16;
    const column = world.getColumn(cx, cz);
    if (!column || y < column.minY - 16 || y >= column.minY + column.worldHeight + 16) return [0, 0];
    const pos = { x: x - cx, y, z: z - cz };
    return [column.getBlockLight(pos), column.getSkyLight(pos)];
  }
  for (let i = 0, j = 0; i < geometry.positions.length; i += 3, j += 2) {
    // Each quad has one face normal. Pull the vertex toward the quad centre
    // before sampling, so an edge never reads a diagonally unrelated cell.
    const start = Math.floor(i / 12) * 12;
    const centre = [0, 0, 0];
    for (let vertex = 0; vertex < 4; vertex++) {
      for (let axis = 0; axis < 3; axis++) centre[axis] += geometry.positions[start + vertex * 3 + axis] / 4;
    }
    const outer = [];
    const inner = [];
    const offsets = [geometry.sx, geometry.sy, geometry.sz];
    for (let axis = 0; axis < 3; axis++) {
      const p = geometry.positions[i + axis] * 0.999 + centre[axis] * 0.001 + offsets[axis];
      outer.push(Math.floor(p + geometry.normals[i + axis] * 0.01));
      inner.push(Math.floor(p - geometry.normals[i + axis] * 0.01));
    }
    const a = sample(...outer);
    const b = sample(...inner);
    light[j] = Math.max(a[0], b[0]);
    light[j + 1] = Math.max(a[1], b[1]);
  }
  geometry.light = light;
  return geometry;
}

// Self-contained for embedding in the browser bundle. The tiny lightmap changes
// with time; terrain geometry and the server's two light channels do not.
export function createViewerLightMaterial(THREE, lighting) {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, alphaTest: 0.1, toneMapped: false });
  const texture = new THREE.DataTexture(new Uint8Array(16 * 16 * 4), 16, 16, THREE.RGBAFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.encoding = THREE.LinearEncoding;
  texture.generateMipmaps = false;
  material.userData.lightmap = texture;
  material.userData.setTime = (timeOfDay, dimension) => {
    const frame = lighting(timeOfDay, dimension);
    texture.image.data.set(frame.lightmap);
    texture.needsUpdate = true;
    material.userData.skyFactor = frame.skyFactor;
    material.userData.skyVisibility = frame.skyVisibility;
  };
  material.userData.setTime(6000, 'overworld');
  material.addEventListener('dispose', () => texture.dispose());
  material.onBeforeCompile = shader => {
    shader.uniforms.roycraftLightmap = { value: texture };
    shader.vertexShader = 'attribute vec2 minecraftLight;\nvarying vec2 vMinecraftLight;\nvarying float vMinecraftShade;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vMinecraftLight = minecraftLight;
      vec3 face = abs(normal);
      vMinecraftShade = face.y > 0.5 ? (normal.y > 0.0 ? 1.0 : 0.5) : (face.z > 0.5 ? 0.8 : 0.6);`);
    shader.fragmentShader = 'uniform sampler2D roycraftLightmap;\nvarying vec2 vMinecraftLight;\nvarying float vMinecraftShade;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec3 light = texture2D(roycraftLightmap, (vMinecraftLight + 0.5) / 16.0).rgb;
      diffuseColor.rgb *= light * vMinecraftShade;`);
  };
  material.customProgramCacheKey = () => 'roycraft-vanilla-lightmap-v2';
  return material;
}

export function installViewerLightClient(viewer, socket) {
  const world = viewer.world;
  socket.on('adventureState', state => {
    if (!state.time) return;
    world.material.userData.setTime(state.time.timeOfDay, state.dimension);
  });
  socket.on('lightColumn', ({ x, z, sections, light }) => {
    if (!world.loadedChunks[`${x},${z}`]) return;
    for (const worker of world.workers) worker.postMessage({ type: 'lightColumn', x, z, light });
    const unique = new Map();
    for (const y of sections) {
      for (const [dx, dy, dz] of [[0, 0, 0], [-16, 0, 0], [16, 0, 0], [0, 0, -16], [0, 0, 16], [0, -16, 0], [0, 16, 0]]) {
        const position = { x: x + dx, y: y + dy, z: z + dz };
        if (world.loadedChunks[`${position.x},${position.z}`]) unique.set(`${position.x},${position.y},${position.z}`, position);
      }
    }
    for (const position of unique.values()) world.setSectionDirty(position);
  });
  socket.on('unloadChunk', ({ x, z }) => {
    // This hook is registered before upstream's removeColumn listener. Queue
    // dirty work after it posts the unload, preserving worker-message order.
    queueMicrotask(() => {
      for (const [dx, dz] of [[-16, 0], [16, 0], [0, -16], [0, 16]]) {
        if (!world.loadedChunks[`${x + dx},${z + dz}`]) continue;
        for (let y = -64; y < 320; y += 16) world.setSectionDirty({ x: x + dx, y, z: z + dz });
      }
    });
  });
}

export function patchViewerLightServer(source, installerSource) {
  const before = 'worldView.init(bot.entity.position)';
  if (source.split(before).length !== 2) throw new Error('Upstream light stream integration changed');
  return source.replace(before, `;(${installerSource})(bot, worldView, socket);\n    ${before}`);
}

export function patchViewerLightClient(source, materialSource, clientSource, lightingSource) {
  const edits = [
    ['new n.MeshLambertMaterial({vertexColors:!0,transparent:!0,alphaTest:.1})', `(${materialSource})(n,(${lightingSource}))`],
    ['r.setAttribute("color",new n.BufferAttribute(t.geometry.colors,3))', 'r.setAttribute("minecraftLight",new n.BufferAttribute(t.geometry.light,2)),r.setAttribute("color",new n.BufferAttribute(t.geometry.colors,3))'],
    ['const u=new r(l);', `const u=new r(l);(${clientSource})(u,o);`]
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Upstream light client integration changed');
    source = source.replace(before, after);
  }
  return source;
}

export function patchViewerLightWorker(source) {
  const edits = [
    ['const l=getSectionGeometry(e,n,a,world,blocksStates),i=', `const l=(${attachGeometryLight.toString()})(getSectionGeometry(e,n,a,world,blocksStates),world),i=`],
    ['l.colors.buffer,l.uvs.buffer]', 'l.colors.buffer,l.uvs.buffer,l.light.buffer]'],
    ['else if("unloadChunk"===e.type)', 'else if("lightColumn"===e.type){const c=world.getColumn(e.x,e.z);if(c){const l=e.light;c.loadParsedLight(l.skyLight,l.blockLight,l.skyLightMask,l.blockLightMask,l.emptySkyLightMask,l.emptyBlockLightMask)}}else if("unloadChunk"===e.type)']
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Upstream light worker integration changed');
    source = source.replace(before, after);
  }
  return source;
}
