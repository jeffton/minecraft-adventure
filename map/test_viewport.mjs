import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('map stays unloaded outside viewport and releases its document after leaving', () => {
  const attributes = new Map();
  let observer;
  const frame = {
    dataset: { src: '/map/' },
    hasAttribute: name => attributes.has(name),
    removeAttribute: name => attributes.delete(name),
    set src(value) { attributes.set('src', value); },
  };
  class IntersectionObserver {
    constructor(callback, options) { observer = { callback, options }; }
    observe(target) { assert.equal(target, frame); }
  }
  vm.runInNewContext(readFileSync(new URL('../diary/map.js', import.meta.url), 'utf8'), {
    document: { querySelector: () => frame },
    IntersectionObserver,
  });
  assert.equal(attributes.has('src'), false);
  assert.equal(observer.options.rootMargin, '0px');
  observer.callback([{ isIntersecting: false, intersectionRatio: 0 }]);
  assert.equal(attributes.has('src'), false);
  observer.callback([{ isIntersecting: true, intersectionRatio: 0 }]); // Touching the viewport edge.
  assert.equal(attributes.has('src'), false);
  observer.callback([{ isIntersecting: true, intersectionRatio: 0.1 }]);
  assert.equal(attributes.get('src'), '/map/');
  observer.callback([{ isIntersecting: false, intersectionRatio: 0 }]);
  assert.equal(attributes.has('src'), false, 'hidden WebGL and SSE must be destroyed');
});
