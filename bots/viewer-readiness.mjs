export function patchViewerClient(source) {
  const call = 'u.setFirstPersonCamera(t,r,o)';
  if (source.split(call).length !== 2) throw new Error('Upstream first-person camera integration changed');
  return source.replace(call, `(window.roycraftCameraApplied ? ${call} : (u.camera.position.set(t.x,t.y+u.playerHeight,t.z),u.setFirstPersonCamera(null,r,o),window.roycraftCameraApplied=true))`);
}

export const readyScript = `<script>
window.roycraftReady = false;
window.roycraftConnected = false;
window.roycraftCameraApplied = false;
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
      });
    }
  };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const draw = C.prototype.drawElements;
    C.prototype.drawElements = function(mode, count, ...args) {
      const result = draw.call(this, mode, count, ...args);
      if (window.roycraftCameraApplied && count > 2048) draws++;
      window.roycraftReady = window.roycraftCameraApplied && draws >= 3 && lastTraffic > 0 && Date.now() - lastTraffic < 35000;
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
