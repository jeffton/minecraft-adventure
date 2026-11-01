(() => {
  const app = window.bluemap;
  const controls = app.mapControls;
  const update = controls.update;

  // BlueMap 5.29 resets Y but skips terrain height for tilted orthographic views.
  controls.update = function (delta, map) {
    update.call(this, delta, map);
    if (this.manager.ortho !== 0 && this.manager.angle !== 0) {
      this.mapHeight.update(delta, map);
    }
  };

  function isometric(viewer) {
    const camera = viewer.mapViewer.controlsManager;
    camera.rotation = Math.PI / 4;
    camera.angle = Math.atan(1 / Math.sqrt(2));
    camera.ortho = 1;
    camera.distance = 420;
    viewer.appState.controls.state = 'flat';
    viewer.updatePageAddress();
  }

  // BlueMap loads custom scripts after the first map; preserve its initial deep link.
  const resetCamera = app.resetCamera;
  app.resetCamera = function () {
    resetCamera.call(this);
    isometric(this);
  };
})();
