import { buildViewerEntity, disposeViewerEntity } from './viewer-entity-mesh.mjs';

// Installed 1.21.4 model rotations extend at most 0.42388 blocks outside a cell.
export function visibleSectionsReady(viewer, THREE, padding, fogRadius) {
  // Meshing samples adjacent block data; complete visible coverage also needs
  // the models' overhang and one block of neighbour data around the fog sphere.
  const dataRadius = fogRadius + padding + 1;
  for (let x = Math.floor((viewer.camera.position.x - dataRadius) / 16); x <= Math.floor((viewer.camera.position.x + dataRadius) / 16); x++) {
    for (let z = Math.floor((viewer.camera.position.z - dataRadius) / 16); z <= Math.floor((viewer.camera.position.z + dataRadius) / 16); z++) {
      if (!viewer.world.loadedChunks[`${x * 16},${z * 16}`]) return false;
    }
  }
  const scratch = viewer.roycraftFrustumScratch ??= {
    frustum: new THREE.Frustum(), matrix: new THREE.Matrix4(), box: new THREE.Box3()
  };
  viewer.camera.updateMatrixWorld();
  scratch.matrix.multiplyMatrices(viewer.camera.projectionMatrix, viewer.camera.matrixWorldInverse);
  scratch.frustum.setFromProjectionMatrix(scratch.matrix);
  for (const key of viewer.world.sectionsOutstanding) {
    const [x, y, z] = key.split(',').map(Number);
    scratch.box.min.set(x - padding, y - padding, z - padding);
    scratch.box.max.set(x + 16 + padding, y + 16 + padding, z + 16 + padding);
    if (scratch.box.distanceToPoint(viewer.camera.position) <= fogRadius && scratch.frustum.intersectsBox(scratch.box)) return false;
  }
  return true;
}

export function radialFogVertex(source) {
  const marker = 'fogDepth = - mvPosition.z;';
  if (source.split(marker).length !== 2) throw new Error('Upstream fog integration changed');
  return source.replace(marker, 'fogDepth = length(mvPosition.xyz);');
}

// Prismarine's renderer has fixed daylight. Apply the observed overworld cycle
// to sky, fog and Lambert lighting; this is not vanilla's per-block light engine.
export function applyViewerDaylight(viewer, state) {
  if (!state.time) return;
  const angle = (state.time.timeOfDay - 6000) * Math.PI / 12000;
  const daylight = state.dimension === 'overworld'
    ? Math.max(0, Math.min(1, (Math.cos(angle) + 0.15) / 0.3))
    : 1; // Other dimensions have no day/night cycle; clear any previous night.
  viewer.scene.background.setRGB(0.012 + 0.666 * daylight, 0.018 + 0.829 * daylight, 0.055 + 0.847 * daylight);
  viewer.scene.fog.color.copy(viewer.scene.background);
  viewer.ambientLight.intensity = 0.22 + 0.78 * daylight;
  viewer.directionalLight.intensity = 0.05 + 0.45 * daylight;
}

export function patchViewerClient(source, cameraMotionSource) {
  const edits = [
    ['this.world=new a(this.scene)', 'this.world=new a(this.scene,2)'],
    ['const u=new r(l);', `const u=new r(l);THREE.ShaderChunk.fog_vertex=window.roycraftRadialFogVertex(THREE.ShaderChunk.fog_vertex);window.roycraftMotion=(${cameraMotionSource})();window.roycraftViewer=u;u.camera.far=48;u.camera.updateProjectionMatrix();u.scene.fog=new THREE.Fog(u.scene.background,24,44);o.on('adventureState',s=>{window.roycraftState=s;window.roycraftApplyDaylight(u,s)});o.on('adventureChunks',chunks=>{window.roycraftChunks=chunks});`],
    ['u.setFirstPersonCamera(t,r,o)', '(window.roycraftMotion.receive(u,t,r,o),window.roycraftCameraApplied=true)'],
    ['u.update(),l.render(u.scene,u.camera)', 'window.roycraftMotion.frame(u,performance.now()),u.update(),window.roycraftChunksReady=!!window.roycraftChunks?.length&&window.roycraftChunks.every(k=>u.world.loadedChunks[k])&&window.roycraftVisibleSectionsReady(u,THREE,0.425,44)&&window.roycraftTexturesReady(u),l.render(u.scene,u.camera),window.roycraftFrameRendered(l)']
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Upstream first-person camera integration changed');
    source = source.replace(before, after);
  }
  return source;
}

export const readyScript = `<script>
window.roycraftReady = false;
window.roycraftConnected = false;
window.roycraftCameraApplied = false;
window.roycraftChunksReady = false;
window.roycraftCapture = null;
window.roycraftBuildEntity = (${buildViewerEntity.toString()});
window.roycraftDisposeEntity = (${disposeViewerEntity.toString()});
window.roycraftVisibleSectionsReady = (${visibleSectionsReady.toString()});
window.roycraftRadialFogVertex = (${radialFogVertex.toString()});
window.roycraftApplyDaylight = (${applyViewerDaylight.toString()});
window.roycraftTexturesReady = viewer => {
  let ready = true;
  viewer.scene.traverse(object => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material?.map) continue;
      const image = material.map.image;
      if (!image || !(image instanceof HTMLCanvasElement || (image.complete && image.naturalWidth > 0))) ready = false;
    }
  });
  return ready && !!viewer.world.material.map;
};
(() => {
  let lastTraffic = 0;
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', () => {
        lastTraffic = Date.now();
        window.roycraftConnected = true;
      });
      this.addEventListener('close', () => {
        lastTraffic = 0;
        window.roycraftConnected = false;
        window.roycraftReady = false;
        window.roycraftCameraApplied = false;
        window.roycraftChunksReady = false;
        window.roycraftChunks = null;
        window.roycraftState = null;
      });
    }
  };
  window.roycraftFrameRendered = renderer => {
    window.roycraftReady = window.roycraftCameraApplied && window.roycraftChunksReady && lastTraffic > 0 && Date.now() - lastTraffic < 35000;
    if (window.roycraftReady && window.roycraftCaptureRequested && window.roycraftCapture === null) {
      // Export this completed frame synchronously, before later camera/chunk updates.
      window.roycraftCapture = renderer.domElement.toDataURL('image/webp', 0.85);
    }
  };
  setInterval(() => {
    if (Date.now() - lastTraffic > 35000) {
      window.roycraftReady = false;
      window.roycraftConnected = false;
    }
  }, 1000);
})();
</script>`;
