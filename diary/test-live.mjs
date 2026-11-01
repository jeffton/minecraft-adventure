import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (process.getuid() === 0) throw new Error('Run the game-camera verification as minecraft-diary');
const browser = await chromium.launch({
  executablePath: '/opt/google/chrome/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
try {
  for (const width of [1440, 390]) {
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
      const actual = await frame.evaluate(() => ({ state: window.roycraftState, chunks: Object.keys(window.roycraftViewer.world.loadedChunks).length, pending: window.roycraftViewer.world.sectionsOutstanding.size, far: window.roycraftViewer.camera.far }));
      assert.equal(actual.state.name, name);
      assert.ok(Array.isArray(actual.state.inventory));
      assert.equal(actual.far, 48);
      assert.ok(actual.chunks > 25, `Loaded terrain for ${name}: ${actual.chunks}`);
      assert.ok((await page.locator('#camera-kit').textContent()).includes(actual.state.held ? actual.state.held.name.replaceAll('_', ' ') : 'Empty'));
      assert.equal(await page.locator('#live-feed').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR || '/tmp'}/roycraft-live-${name}-${width}.png`, fullPage: true });
      positions[name] = actual.state.position;
      console.log(`${width}px ${name}: ${JSON.stringify(actual)}`);
    }
    // Rapid switching must leave just the final actor's iframe/state, never an old inventory.
    await page.locator('[data-camera="Roy"]').click();
    await page.locator('[data-camera="Flint"]').click();
    await page.locator('[data-camera="Spruce"]').click();
    const finalFrame = await (await page.locator('#live-feed').elementHandle()).contentFrame();
    await finalFrame.waitForFunction(() => window.roycraftState?.name === 'Spruce', undefined, { timeout: 45000 });
    await page.getByRole('button', { name: 'Show latest snapshot' }).click();
    assert.equal(await page.locator('#live-feed').count(), 0);
    assert.equal(await page.locator('#camera-controls').isVisible(), true);
    await page.getByText('Live inventory paused', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#live-feed'));
    // A new browser round-trip lets transport teardown complete without keeping a renderer alive.
    await page.goto('about:blank');
    assert.equal(activeSockets.size, 0);
    assert.deepEqual(errors, []);
    assert.ok(new Set(Object.values(positions).map(p => JSON.stringify(p))).size > 1, 'Feeds must be genuine distinct bot positions');
    await page.close();
  }
} finally {
  await browser.close();
}
