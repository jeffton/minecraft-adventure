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
    let frames = 0;
    page.on('websocket', socket => socket.on('framereceived', () => frames++));
    await page.goto('https://minecraft.roybot.se/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Roy', exact: true }).waitFor();
    await page.locator('#hero-image').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Watch live' }).click();
    const element = await page.locator('#live-feed').elementHandle();
    const frame = await element.contentFrame();
    await frame.waitForFunction(() => window.roycraftReady === true, undefined, { timeout: 45000 });
    await page.getByText('LIVE BOT CAMERA', { exact: true }).waitFor();
    assert.ok(frames > 3, `No actual live gameplay frames at viewport ${width}`);
    await page.screenshot({ path: `/tmp/roycraft-public-live-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Show latest snapshot' }).click();
    assert.equal(await page.locator('#live-feed').count(), 0);
    await page.close();
    console.log(`Public HTTPS live feed ${width}px: ${frames} WebSocket frames, actual world rendered.`);
  }
} finally {
  await browser.close();
}
