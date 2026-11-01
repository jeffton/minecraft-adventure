// Run as minecraft-diary inside a bounded transient systemd service. Fixture
// values are explicit test data, never injected into the live Minecraft world.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from '/opt/minecraft-adventure/diary/node_modules/playwright-core/index.mjs';
import { attachGeometryLight, createViewerLightMaterial } from './viewer-light.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const Chunk = require('prismarine-chunk')('1.21.4');
const { Vec3 } = require('vec3');
const output = process.env.LIGHT_PROOF_DIR;
assert.ok(output, 'Set LIGHT_PROOF_DIR to a writable artifact directory');
assert.notEqual(process.getuid(), 0, 'Run browser as nonroot');
const browser = await chromium.launch({
  executablePath: '/opt/google/chrome/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 240 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  if (process.argv.includes('--public')) {
    await page.goto('https://minecraft.roybot.se/live/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.roycraftCameraApplied && window.roycraftReady && Object.values(window.roycraftViewer.world.sectionMeshs).some(mesh => mesh.geometry.getAttribute('minecraftLight')?.count), undefined, { timeout: 60000 });
    const actual = await page.evaluate(() => {
      const viewer = window.roycraftViewer;
      const channels = [new Set(), new Set()];
      for (const mesh of Object.values(viewer.world.sectionMeshs)) {
        const values = mesh.geometry.getAttribute('minecraftLight').array;
        for (let i = 0; i < values.length; i++) channels[i % 2].add(values[i]);
      }
      return { state: window.roycraftState, chunks: Object.keys(viewer.world.loadedChunks).length,
        material: viewer.world.material.type, skyDarken: viewer.world.material.userData.skyDarken.value,
        blockLevels: [...channels[0]].sort((a, b) => a - b), skyLevels: [...channels[1]].sort((a, b) => a - b),
        programs: viewer.renderer?.info?.programs?.length ?? null };
    });
    assert.equal(actual.material, 'MeshBasicMaterial');
    assert.ok(actual.chunks > 0);
    await page.screenshot({ path: `${output}/public-light.png` });
    console.log(JSON.stringify({ public: actual, errors }));
  } else {
    const column = new Chunk({ minY: -64, worldHeight: 384 });
    const levels = [[0, 0], [14, 0], [13, 0], [0, 15]];
    const quads = levels.map(([block, sky], index) => {
      const x = 2 + index * 3;
      column.setBlockLight(new Vec3(x, 0, 1), block);
      column.setSkyLight(new Vec3(x, 0, 1), sky);
      return { sx: 0, sy: 0, sz: 0,
        positions: new Float32Array([x, 0, 1, x + 1, 0, 1, x, 1, 1, x + 1, 1, 1]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]) };
    });
    const world = { getColumn: (x, z) => x === 0 && z === 0 ? column : null };
    const geometry = quads.map(quad => Array.from(attachGeometryLight(quad, world).light));
    await page.route('http://light.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/three.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync('/opt/minecraft-mindcraft/node_modules/three/build/three.min.js') });
      return route.fulfill({ contentType: 'text/html', body: `<body style="margin:0;background:black"><script src="/three.js"></script><script>
        const renderer = new THREE.WebGLRenderer({preserveDrawingBuffer:true,antialias:false});
        renderer.setSize(480,240); document.body.append(renderer.domElement);
        const scene = new THREE.Scene(); scene.background = new THREE.Color(0);
        const camera = new THREE.OrthographicCamera(-0.5,3.5,0.75,-0.75,0.1,10); camera.position.z=2;
        const material=(${createViewerLightMaterial.toString()})(THREE);
        const meshes=[]; const data=${JSON.stringify(geometry)};
        for(let i=0;i<4;i++){
          const geometry=new THREE.PlaneGeometry(0.8,0.8);
          geometry.setAttribute('minecraftLight',new THREE.BufferAttribute(new Float32Array(data[i]),2));
          geometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(12).fill(1),3));
          const mesh=new THREE.Mesh(geometry,material);mesh.position.x=i;scene.add(mesh);meshes.push(mesh);
        }
        window.draw=(night,remove=false)=>{
          material.userData.skyDarken.value=night?11:0;
          if(remove)meshes[1].geometry.getAttribute('minecraftLight').array.fill(0);
          for(const mesh of meshes)mesh.geometry.getAttribute('minecraftLight').needsUpdate=true;
          renderer.render(scene,camera);
          const gl=renderer.getContext(),pixels=new Uint8Array(4),values=[];
          for(let i=0;i<4;i++){gl.readPixels(60+i*120,120,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);values.push(pixels[0]);}
          return {values,programs:renderer.info.programs.map(p=>({runnable:p.diagnostics?.runnable??true}))};
        };
        window.ready=true;
        </script>` });
    });
    await page.goto('http://light.test/');
    await page.waitForFunction(() => window.ready);
    const day = await page.evaluate(() => draw(false));
    await page.screenshot({ path: `${output}/fixture-day.png` });
    const night = await page.evaluate(() => draw(true));
    await page.screenshot({ path: `${output}/fixture-night.png` });
    const removed = await page.evaluate(() => draw(true, true));
    await page.screenshot({ path: `${output}/fixture-removed.png` });
    assert.ok(day.values[1] > day.values[0] * 10, 'Torch must light a cave');
    assert.ok(day.values[2] > day.values[0] * 10, 'Furnace must light a cave');
    assert.equal(day.values[1], night.values[1], 'Torch light must not dim at night');
    assert.equal(day.values[2], night.values[2], 'Furnace light must not dim at night');
    assert.equal(day.values[0], night.values[0], 'Unlit cave must not follow the sun');
    assert.ok(day.values[3] > night.values[3] * 5, 'Outdoor sky light must follow night');
    assert.equal(removed.values[1], removed.values[0], 'Removed source must become dark after light update');
    assert.equal(removed.values[2], night.values[2], 'Other sources must remain lit');
    assert.ok(day.programs.length && day.programs.every(program => program.runnable));
    console.log(JSON.stringify({ fixture: { labels: ['unlit cave', 'torch', 'furnace', 'open sky'], day, night, removed }, errors }));
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
