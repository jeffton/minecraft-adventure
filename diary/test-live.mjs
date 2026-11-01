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
    const frame = await (await page.locator('#live-feed').elementHandle()).contentFrame();
    await frame.waitForFunction(() => window.roycraftReady === true && window.roycraftState?.name === 'Roy', undefined, { timeout: 60000 });
    await page.getByText('LIVE BOT CAMERA', { exact: true }).waitFor();
    const actual = await frame.evaluate(() => ({
      state: window.roycraftState,
      chunks: Object.keys(window.roycraftViewer.world.loadedChunks).length,
      purple: Object.values(window.roycraftViewer.entities.entities)
        .filter(mesh => mesh.material?.color?.getHex() === 0xff00ff).length,
    }));
    assert.ok(Array.isArray(actual.state.inventory));
    assert.equal(actual.purple, 0, 'Purple placeholder meshes remain');
    assert.ok(actual.chunks > 0, 'Live terrain must be loaded');
    await page.waitForFunction(() => {
      const state = document.querySelector('#live-feed').contentWindow.roycraftState;
      const expected = `Main hand: ${state.held ? `${state.held.name.replaceAll('_', ' ')} ×${state.held.count}` : 'Empty'}`;
      return document.querySelector('#camera-kit [aria-label^="Main hand:"]')?.getAttribute('aria-label') === expected;
    });
    assert.equal(await page.locator('#live-feed').count(), 1);
    assert.equal(await page.locator('[data-camera], #live-toggle, #image-time, #hero-image').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(await page.locator('#journal .entry img').count() > 0, 'Automatic diary images remain');
    console.log(`${width}px Roy: ${JSON.stringify(actual)}`);
    const closed = Promise.all([...activeSockets].map(socket => socket.waitForEvent('close', { timeout: 10000 })));
    await page.goto('about:blank');
    await closed;
    assert.equal(activeSockets.size, 0);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
}
