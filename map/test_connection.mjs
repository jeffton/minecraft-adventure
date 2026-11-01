import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('live stream closes before map disposal and status survives offline/reconnect', () => {
  class Source extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    close() { this.readyState = 2; }
  }
  const source = new Source();
  const output = { textContent: '', setAttribute() {} };
  const navigator = { onLine: true };
  const app = {
    mapsMap: new Map([['nether', {}]]),
    mapEventSource: source,
    initEventSource() { this.mapEventSource = new Source(); },
    switchMap() {
      assert.equal(source.readyState, 2, 'old stream must be closed before disposed map becomes observable');
      this.initEventSource();
      return 'new-map';
    }
  };
  const window = new EventTarget();
  window.bluemap = app;
  vm.runInNewContext(readFileSync(new URL('./connection.js', import.meta.url), 'utf8'), {
    window, navigator, EventSource: Source,
    document: { createElement: () => output, body: { append() {} } },
  });
  assert.equal(output.textContent, 'Live positions');
  assert.equal(app.switchMap('nether'), 'new-map');
  navigator.onLine = false;
  window.dispatchEvent(new Event('offline'));
  app.mapEventSource.dispatchEvent(new Event('error'));
  assert.equal(output.textContent, 'Offline · positions paused');
  navigator.onLine = true;
  window.dispatchEvent(new Event('online'));
  app.mapEventSource.dispatchEvent(new Event('open'));
  assert.equal(output.textContent, 'Live positions');
});
