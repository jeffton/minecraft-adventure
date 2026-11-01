export function patchViewerClient(source, cameraMotionSource) {
  const edits = [
    ['this.world=new a(this.scene)', 'this.world=new a(this.scene,2)'],
    ['const u=new r(l);', `const u=new r(l);window.roycraftMotion=(${cameraMotionSource})();window.roycraftViewer=u;u.camera.far=48;u.camera.updateProjectionMatrix();u.scene.fog=new THREE.Fog(u.scene.background,24,44);o.on('adventureState',s=>{window.roycraftState=s});o.on('adventureChunks',chunks=>{window.roycraftChunks=chunks});`],
    ['u.setFirstPersonCamera(t,r,o)', '(window.roycraftMotion.receive(u,t,r,o),window.roycraftCameraApplied=true)'],
    ['u.update(),l.render', 'window.roycraftMotion.frame(u,performance.now()),window.roycraftChunksReady=!!window.roycraftChunks?.length&&window.roycraftChunks.every(k=>u.world.loadedChunks[k])&&u.world.sectionsOutstanding.size===0&&window.roycraftTexturesReady(u),u.update(),l.render']
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
window.roycraftTexturesReady = viewer => {
  let ready = true;
  viewer.scene.traverse(object => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material?.map) continue;
      const image = material.map.image;
      if (!image || !(image.complete || image instanceof HTMLCanvasElement)) ready = false;
    }
  });
  return ready && !!viewer.world.material.map;
};
(() => {
  let draws = 0;
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
        draws = 0;
        window.roycraftConnected = false;
        window.roycraftReady = false;
        window.roycraftCameraApplied = false;
        window.roycraftChunksReady = false;
        window.roycraftChunks = null;
        window.roycraftState = null;
      });
    }
  };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const draw = C.prototype.drawElements;
    C.prototype.drawElements = function(mode, count, ...args) {
      const result = draw.call(this, mode, count, ...args);
      if (window.roycraftCameraApplied && count > 2048) draws++;
      window.roycraftReady = window.roycraftCameraApplied && window.roycraftChunksReady && draws >= 3 && lastTraffic > 0 && Date.now() - lastTraffic < 35000;
      return result;
    };
  }
  setInterval(() => {
    if (Date.now() - lastTraffic > 35000) {
      window.roycraftReady = false;
      window.roycraftConnected = false;
    }
  }, 1000);
})();
</script>`;
