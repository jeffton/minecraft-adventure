import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (process.getuid() === 0) throw new Error('Run the game-camera verification as minecraft-diary');
const widths = process.env.CAMERA_TEST_WIDTHS ? process.env.CAMERA_TEST_WIDTHS.split(',').map(Number) : [1440, 390];
for (const width of widths) {
  // Release SwiftShader/GPU contexts between desktop and mobile runs.
  const browser = await chromium.launch({
    executablePath: '/opt/google/chrome/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    const activeSockets = new Set();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('websocket', socket => {
      activeSockets.add(socket);
      socket.on('close', () => activeSockets.delete(socket));
    });
    await page.goto('https://minecraft.roybot.se/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Roy', exact: true }).waitFor();
    await page.locator('#live-feed').waitFor();
    const positions = {};
    for (const name of ['Roy', 'Spruce', 'Flint', 'Moss']) {
      await page.locator(`[data-camera="${name}"]`).click();
      const frame = await (await page.locator('#live-feed').elementHandle()).contentFrame();
      await frame.waitForFunction(name => window.roycraftReady === true && window.roycraftState?.name === name, name, { timeout: 60000 });
      await page.getByText('LIVE BOT CAMERA', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('#camera-kit').textContent.includes('Main hand:'));
      const actual = await frame.evaluate(() => {
        const meshes = Object.values(window.roycraftViewer.entities.entities);
        return {
          state: window.roycraftState, chunks: Object.keys(window.roycraftViewer.world.loadedChunks).length,
          pending: window.roycraftViewer.world.sectionsOutstanding.size, far: window.roycraftViewer.camera.far,
          purple: meshes.filter(mesh => mesh.material?.color?.getHex() === 0xff00ff).length,
          custom: meshes.filter(mesh => mesh.userData.roycraftCustom).map(mesh => ({ kind: mesh.userData.roycraftKind, item: mesh.userData.itemKey })),
        };
      });
      assert.equal(actual.state.name, name);
      assert.ok(Array.isArray(actual.state.inventory));
      assert.equal(actual.far, 48);
      assert.equal(actual.purple, 0, `Purple placeholder meshes remain for ${name}`);
      assert.ok(actual.chunks > 25, `Loaded terrain for ${name}: ${actual.chunks}`);
      assert.ok((await page.locator('#camera-kit').textContent()).includes(actual.state.held ? actual.state.held.name.replaceAll('_', ' ') : 'Empty'));
      assert.equal(await page.locator('#live-feed').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (name === 'Moss') await page.screenshot({ path: `${process.env.SCREENSHOT_DIR || '/tmp'}/roycraft-live-${name}-${width}.png` });
      positions[name] = actual.state.position;
      console.log(`${width}px ${name}: ${JSON.stringify(actual)}`);
    }
    // Rapid switching must leave just the final actor's iframe/state, never an old inventory.
    await page.locator('[data-camera="Roy"]').click();
    await page.locator('[data-camera="Flint"]').click();
    await page.locator('[data-camera="Spruce"]').click();
    const finalFrame = await (await page.locator('#live-feed').elementHandle()).contentFrame();
    await finalFrame.waitForFunction(() => window.roycraftState?.name === 'Spruce', undefined, { timeout: 45000 });
    assert.equal(await page.locator('#live-feed').count(), 1);
    assert.equal(await page.locator('#live-toggle, #image-time, #hero-image').count(), 0);
    assert.equal(await page.locator('[data-camera]').count(), 4);
    assert.ok(await page.locator('#journal .entry img').count() > 0, 'Automatic diary images remain');
    // Navigation closes the selected live camera; there is no snapshot mode.
    const closed = Promise.all([...activeSockets].map(socket => socket.waitForEvent('close', { timeout: 10000 })));
    await page.goto('about:blank');
    await closed;
    assert.equal(activeSockets.size, 0);
    assert.deepEqual(errors, []);
    assert.ok(new Set(Object.values(positions).map(p => JSON.stringify(p))).size > 1, 'Feeds must be genuine distinct bot positions');
    await page.close();
  } finally {
    await browser.close();
  }
}
