// Self-contained so the installed viewer bundle can use the same tested code.
export function createViewerBreakingClient(viewer, socket, THREE, lifecycle = window) {
  const overlays = new Map();
  const textures = new Map();
  const loader = new THREE.TextureLoader();

  function remove(id) {
    const overlay = overlays.get(id);
    if (!overlay) return;
    viewer.scene.remove(overlay.group);
    for (const mesh of overlay.group.children) mesh.geometry.dispose();
    overlay.material.dispose();
    overlays.delete(id);
  }

  function clear() {
    for (const id of overlays.keys()) remove(id);
  }

  function texture(stage) {
    if (!textures.has(stage)) {
      const map = loader.load(`textures/1.21.4/blocks/destroy_stage_${stage}.png`);
      map.magFilter = THREE.NearestFilter;
      map.minFilter = THREE.NearestFilter;
      textures.set(stage, map);
    }
    return textures.get(stage);
  }

  function receive(event) {
    if (event.reset) {
      clear();
      return;
    }
    const { id, position, stage, shapes } = event;
    if (stage === -1) {
      remove(id);
      return;
    }
    const signature = JSON.stringify([position, shapes]);
    const previous = overlays.get(id);
    if (previous?.signature === signature) {
      previous.material.map = texture(stage);
      previous.material.needsUpdate = true;
      return;
    }
    remove(id);
    const group = new THREE.Group();
    group.position.set(position.x, position.y, position.z);
    const material = new THREE.MeshBasicMaterial({
      map: texture(stage),
      transparent: true,
      blending: THREE.MultiplyBlending,
      depthWrite: false,
      alphaTest: 0.01,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    for (const [x0, y0, z0, x1, y1, z1] of shapes) {
      // Follow voxel collision bounds (slabs, stairs, etc.), not a full cube.
      // Expansion and polygon offset keep cracks above the original surface.
      const geometry = new THREE.BoxGeometry(x1 - x0 + 0.002, y1 - y0 + 0.002, z1 - z0 + 0.002);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      group.add(mesh);
    }
    viewer.scene.add(group);
    overlays.set(id, { group, material, position, signature });
  }

  function blockUpdate({ pos }) {
    for (const [id, overlay] of overlays) {
      const p = overlay.position;
      if (p.x === pos.x && p.y === pos.y && p.z === pos.z) remove(id);
    }
  }

  function unloadChunk({ x, z }) {
    for (const [id, overlay] of overlays) {
      const p = overlay.position;
      if (Math.floor(p.x / 16) * 16 === x && Math.floor(p.z / 16) * 16 === z) remove(id);
    }
  }

  function release() {
    clear();
    for (const map of textures.values()) map.dispose();
    textures.clear();
    socket.off('adventureBreaking', receive);
    socket.off('blockUpdate', blockUpdate);
    socket.off('unloadChunk', unloadChunk);
    socket.off('disconnect', clear);
  }

  function attach() {
    socket.on('adventureBreaking', receive);
    socket.on('blockUpdate', blockUpdate);
    socket.on('unloadChunk', unloadChunk);
    socket.on('disconnect', clear);
  }

  function restore(event) {
    if (event.persisted) attach();
  }

  function dispose() {
    release();
    lifecycle.removeEventListener('pagehide', release);
    lifecycle.removeEventListener('pageshow', restore);
  }

  attach();
  lifecycle.addEventListener('pagehide', release);
  lifecycle.addEventListener('pageshow', restore);
  return { dispose };
}

export function patchViewerBreakingClient(source, clientSource) {
  const marker = 'const u=new r(l);';
  if (source.split(marker).length !== 2) throw new Error('Upstream breaking overlay integration changed');
  return source.replace(marker, `${marker}(${clientSource})(u,o,THREE);`);
}
