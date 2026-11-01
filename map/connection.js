(() => {
  const app = window.bluemap;
  const status = document.createElement('output');
  status.id = 'roycraft-map-connection';
  status.setAttribute('role', 'status');
  document.body.append(status);

  function observe() {
    const source = app.mapEventSource;
    const connected = () => { status.textContent = 'Live positions'; };
    const interrupted = () => {
      status.textContent = navigator.onLine ? 'Reconnecting · positions may be stale' : 'Offline · positions paused';
    };
    source.addEventListener('open', connected);
    source.addEventListener('error', interrupted);
    if (source.readyState === EventSource.OPEN) connected();
    else interrupted();
  }

  // BlueMap closes the old stream after replacing/disposal of its map. Tile events
  // in that interval dereference the disposed map's null lowres tile managers.
  const switchMap = app.switchMap;
  app.switchMap = function (...args) {
    if (this.mapsMap.has(args[0])) this.mapEventSource.close();
    return switchMap.apply(this, args);
  };

  const initialize = app.initEventSource;
  app.initEventSource = function () {
    const result = initialize.call(this);
    observe();
    return result;
  };
  window.addEventListener('offline', () => { status.textContent = 'Offline · positions paused'; });
  window.addEventListener('online', () => {
    status.textContent = app.mapEventSource.readyState === EventSource.OPEN ? 'Live positions' : 'Reconnecting · positions may be stale';
  });
  observe();
})();
