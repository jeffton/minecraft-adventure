// Actual GPU pixels for the unchanged vanilla lightmap, not a brightness filter.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright-core';
import { createViewerLightMaterial } from '../bots/viewer-light.mjs';
import { minecraftLighting } from '../bots/viewer-lightmap.mjs';

if (process.getuid() === 0) throw new Error('Run renderer verification as minecraft-diary');
const html = `<body><script src="/three.js"></script><script>
const lighting = ${minecraftLighting.toString()};
const materialFor = ${createViewerLightMaterial.toString()};
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-0.5, 15.5, 3.5, -0.5, 0.1, 10);
camera.position.z = 2;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(960, 240);
document.body.style.margin = 0;
document.body.append(renderer.domElement);
const gray = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
gray.needsUpdate = true;
for (let row = 0; row < 4; row++) {
  const material = materialFor(THREE, lighting);
  material.map = gray;
  material.userData.setTime(row % 2 ? 18000 : 6000, 'overworld');
  for (let level = 0; level < 16; level++) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const count = geometry.attributes.position.count;
    const light = Array.from({ length: count }, () => row < 2 ? [0, level] : [level, 0]).flat();
    geometry.setAttribute('minecraftLight', new THREE.Float32BufferAttribute(light, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(Array(count * 3).fill(1), 3));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(level, 3 - row, 0);
    scene.add(mesh);
  }
}
window.measure = () => {
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  return Array.from({ length: 4 }, (_, row) => Array.from({ length: 16 }, (_, level) => {
    const pixel = new Uint8Array(4);
    gl.readPixels(level * 60 + 30, (3 - row) * 60 + 30, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return Array.from(pixel);
  }));
};
</script>`;
const server = createServer((request, response) => {
  if (request.url === '/three.js') {
    response.end(readFileSync('/opt/minecraft-mindcraft/node_modules/three/build/three.min.js'));
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(html);
  }
}).listen(0, '127.0.0.1');
const engines = [{ name: 'chromium', type: chromium, executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] }];
if (process.env.WEBKIT_EXECUTABLE) engines.push({ name: 'webkit', type: webkit, executablePath: process.env.WEBKIT_EXECUTABLE, args: [] });
try {
  for (const { name, type, executablePath, args } of engines) {
    const browser = await type.launch({ executablePath, args });
    try {
      const page = await browser.newPage({ viewport: { width: 960, height: 240 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const pixels = await page.evaluate(() => window.measure());
      for (let row = 0; row < 4; row++) {
        const map = minecraftLighting(row % 2 ? 18000 : 6000, 'overworld').lightmap;
        for (let level = 0; level < 16; level++) {
          const index = (row < 2 ? level * 16 : level) * 4;
          for (let channel = 0; channel < 3; channel++) {
            const expected = 128 * map[index + channel] / 255 * 0.8;
            assert.ok(Math.abs(pixels[row][level][channel] - expected) <= 2, `${name}: row ${row}, level ${level}, channel ${channel}`);
          }
          if (level) assert.ok(pixels[row][level][0] >= pixels[row][level - 1][0]);
        }
        assert.ok(pixels[row][0][0] > 0 && pixels[row][0][0] < 20, 'Unlit caves retain their low vanilla ambient floor');
      }
      assert.deepEqual(pixels[2], pixels[3], 'Torches/furnaces must not darken at night');
      assert.ok(pixels[0][11][0] > pixels[0][0][0] * 5, 'The actual staircase level 11 must not render as level 0');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/tmp/roycraft-light-levels-${name}.png` });
      // Mobile viewport uses the same GPU pipeline, without CSS brightness effects.
      await page.setViewportSize({ width: 390, height: 844 });
      assert.deepEqual(await page.evaluate(() => window.measure()), pixels);
      console.log(`${name}: actual GPU sky/block levels 0–15, day/night and mobile viewport passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
