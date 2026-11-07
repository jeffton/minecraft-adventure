// Isolated real WebGL rendering: no game connection, entities or world changes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { patchViewerEntities, viewerEntityModel } from '../bots/viewer-entities.mjs';
import { buildViewerEntity } from '../bots/viewer-entity-mesh.mjs';

if (process.getuid() === 0) throw new Error('Run renderer verification as minecraft-diary');
const upstream = '/opt/minecraft-mindcraft/node_modules/prismarine-viewer';
const assets = process.env.ENTITY_ASSETS || '/opt/minecraft-adventure/bots/assets/entities';
const bundle = patchViewerEntities(readFileSync(`${upstream}/public/index.js`, 'utf8'), viewerEntityModel.toString());
const start = bundle.indexOf('823:(t,e,i)=>{');
const end = bundle.indexOf(',1644:', start);
assert.ok(start > 0 && end > start, 'Actual upstream Entity module must be present');
const source = bundle.slice(start + 4, end);
const models = readFileSync(`${upstream}/viewer/lib/entity/entities.json`, 'utf8');
const custom = readFileSync(`${assets}/models.json`, 'utf8');
const html = `<body><script src="/three.js"></script><script>
const module = { exports: {} };
(${source})(module, {}, id => id === 628 ? ${models} : {
  loadTexture: (path, apply) => new THREE.TextureLoader().load('/' + path, apply)
});
window.roycraftEntityAssets = ${custom};
window.roycraftBuildEntity = ${buildViewerEntity.toString()};
const scene = new THREE.Scene();
scene.background = new THREE.Color('#a9cbdf');
scene.add(new THREE.AmbientLight(0xffffff, 1));
const camera = new THREE.PerspectiveCamera(45, 960 / 540, 0.1, 100);
camera.position.set(3, 2.6, 10);
camera.lookAt(3, 1.2, 0);
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(960, 540);
document.body.style.margin = 0;
document.body.append(renderer.domElement);
const names = ['zombie', 'husk', 'witch', 'camel'];
const meshes = names.map((name, index) => {
  const mesh = name === 'camel' ? window.roycraftBuildEntity({ name }, THREE)
    : new module.exports('1.16.4', name, scene).mesh;
  mesh.position.x = index * 2;
  scene.add(mesh);
  return mesh;
});
window.fixtureLoaded = () => meshes.every(mesh => mesh.children.every(child => child.material.map?.image?.complete));
window.verifyBodies = () => {
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  return meshes.map((mesh, index) => {
    const point = new THREE.Vector3(index * 2, 0.9, 0).project(camera);
    const pixel = new Uint8Array(4);
    gl.readPixels(Math.round((point.x + 1) * 480), Math.round((point.y + 1) * 270), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return { name: names[index], pixel: Array.from(pixel) };
  });
};
</script>`;
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(html);
    return;
  }
  const path = request.url === '/three.js'
    ? '/opt/minecraft-mindcraft/node_modules/three/build/three.min.js'
    : request.url.startsWith('/entity-assets/')
      ? `${assets}/${request.url.slice('/entity-assets/'.length)}`
      : `${upstream}/public${request.url}`;
  try {
    response.end(readFileSync(path));
  } catch {
    response.statusCode = 404;
    response.end();
  }
}).listen(0, '127.0.0.1');
const browser = await chromium.launch({
  executablePath: '/opt/google/chrome/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.fixtureLoaded());
  const bodies = await page.evaluate(() => window.verifyBodies());
  for (const { name, pixel } of bodies) {
    assert.notDeepEqual(pixel.slice(0, 3), [169, 203, 223], `${name} body must not disappear into background`);
  }
  assert.deepEqual(errors, []);
  await page.screenshot({ path: process.env.ENTITY_SCREENSHOT || '/tmp/roycraft-entity-models.png' });
  console.log(JSON.stringify(bodies));
} finally {
  await browser.close();
  server.close();
}
