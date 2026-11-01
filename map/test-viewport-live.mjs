import assert from 'node:assert/strict';
import { chromium } from '/opt/minecraft-adventure/diary/node_modules/playwright-core/index.mjs';

if (process.getuid() === 0) throw new Error('Run as minecraft-diary, not root');
const browser = await chromium.launch({
  executablePath: '/opt/google/chrome/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const requests = [];
    const failures = [];
    page.on('request', request => {
      if (request.url().includes('/map/')) requests.push(request.url());
    });
    page.on('response', response => {
      if (response.url().includes('/map/') && response.status() >= 400) failures.push([response.status(), response.url()]);
    });
    await page.goto('https://minecraft.roybot.se/', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#world-map').getAttribute('src'), null);
    assert.equal(requests.length, 0, 'Chrome proximity loading must not start the map');
    const map = page.locator('#world-map');
    await map.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('#world-map').getAttribute('src') === '/map/');
    const frame = await (await map.elementHandle()).contentFrame();
    await frame.waitForFunction(() => {
      const viewer = window.bluemap?.mapViewer;
      return viewer?.map?.hiresTileManager?.tiles && viewer.controlsManager.position.y > -1000 &&
        [...viewer.map.hiresTileManager.tiles.values()].some(tile => tile.loaded);
    }, undefined, { timeout: 90000 });
    const icons = await frame.evaluate(async () => {
      const players = (await (await fetch('maps/overworld/live/players.json')).json()).players;
      return Promise.all(players.map(player => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ name: player.name, width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error('Missing player marker: ' + player.name));
        image.src = 'maps/overworld/assets/playerheads/' + player.uuid + '.png';
      })));
    });
    assert.equal(icons.length, 4);
    assert.ok(icons.every(icon => icon.width === 32 && icon.height === 32));
    assert.deepEqual(failures, []);
    await page.screenshot({ path: `/tmp/roycraft-map-viewport-${width}.png` });
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => !document.querySelector('#world-map').hasAttribute('src'));
    await page.waitForFunction(() => !document.querySelector('#world-map').contentWindow.bluemap);
    console.log(`${width}px PASS: abovefold no map requests; visible map loaded; 4 decoded PNG markers; map destroyed offscreen.`);
    await page.close();
  }
} finally {
  await browser.close();
}
