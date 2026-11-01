import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const screenshotDirectory = process.env.SCREENSHOT_DIR || '/tmp';
const now = new Date().toISOString();
const data = {
  publishedAt: now, observedAt: now,
  objective: 'Saml træ til fælleshuset', longTerm: 'Et smukt hjem og en fælles ekspedition til End.',
  serverVersion: 'Java 26.3',
  bots: ['Roy', 'Spruce', 'Flint', 'Moss'].map(name => ({ name, role: 'Ekspeditionsholdet', status: 'online', health: 20, food: 18, task: 'Samler ressourcer' })),
  milestones: [{ label: 'Et fælles hjem', completed: false }, { label: 'Jern og proviant', completed: false }, { label: 'Gennem Nether', completed: false }, { label: 'Ender-dragen', completed: false }],
  entries: [{ at: now, observedAt: now, title: 'Den første dag', summary: '<img src=x onerror="window.injected=true">', events: ['Roy: Fandt træ'], image: null, captureError: null }],
};
const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('http://diary.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (name === 'data.json') return route.fulfill({ json: data });
      if (name.startsWith('live/')) {
        const nameParts = name.split('/');
        const bot = nameParts[1] || 'Roy';
        return route.fulfill({ contentType: 'text/html', body: `<canvas></canvas><script>window.roycraftConnected=true;window.roycraftState=${JSON.stringify({ name: bot, status: 'online', at: Date.now(), health: 20, food: 18, position: { x: 1, y: 80, z: 3 }, action: 'idle', moving: false, digging: null, held: { name: bot === 'Roy' ? 'stone_sword' : 'iron_pickaxe', count: 1 }, offhand: null, inventory: [{ name: bot === 'Roy' ? 'oak_log' : 'coal', count: 7 }] })};</script>` });
      }
      if (name.startsWith('map/')) return route.fulfill({ contentType: 'text/html', body: '<p>Map fixture</p>' });
      const extension = name.split('.').at(-1);
      const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png' };
      const path = name.startsWith('item-assets/') ? `/var/www/roybot.se/minecraft/${name}` : new URL(name, import.meta.url);
      await route.fulfill({ contentType: types[extension], body: await readFile(path) });
    });
    await page.goto('http://diary.test/');
    await page.getByRole('heading', { name: 'Roy', exact: true }).waitFor();
    assert.equal(await page.locator('.bot').count(), 4);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${screenshotDirectory}/roycraft-diary-${width}.png`, fullPage: true });
    assert.equal(await page.locator('#camera-controls').isVisible(), false);
    await page.getByRole('button', { name: 'Watch live' }).click();
    await page.locator('#live-feed').waitFor();
    assert.equal(await page.locator('#live-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#image-time').isVisible(), false);
    await page.getByRole('img', { name: 'Main hand: stone sword ×1', exact: true }).waitFor();
    await page.getByRole('img', { name: 'Health 20/20', exact: true }).waitFor();
    assert.equal(await page.locator('#camera-vitals .mc-meter-cell').count(), 20);
    await page.locator('#camera-bot').selectOption('Moss');
    await page.getByRole('img', { name: 'Main hand: iron pickaxe ×1', exact: true }).waitFor();
    assert.equal(await page.locator('#live-feed').count(), 1);
    await page.locator('details').evaluate(element => { element.open = true; });
    await page.getByRole('img', { name: 'coal ×7', exact: true }).waitFor();
    assert.equal(await page.locator('#camera-inventory .mc-count').textContent(), '7');
    const coal = page.getByRole('img', { name: 'coal ×7', exact: true });
    await page.keyboard.press('Tab');
    await coal.focus();
    assert.equal(await coal.locator('.mc-tooltip').isVisible(), true);
    assert.equal(await coal.locator('.mc-tooltip').textContent(), 'coal ×7');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await coal.evaluate(element => element.blur());
    assert.equal(await page.locator('#camera-kit [aria-label="Main hand: stone sword ×1"]').count(), 0);
    assert.equal(await page.locator('#camera-controls img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const liveFrame = await (await page.locator('#live-feed').elementHandle()).contentFrame();
    await liveFrame.evaluate(() => {
      window.roycraftState.at = Date.now();
      window.roycraftState.inventory = [
        { name: 'crafting_table', count: 1 }, { name: 'stick', count: 3 },
        { name: 'wooden_pickaxe', count: 1 }, { name: 'brown_wool', count: 4 },
        { name: 'leather', count: 2 }, { name: 'gray_wool', count: 2 },
        { name: 'oak_log', count: 6 }, { name: 'white_wool', count: 3 },
        { name: 'oak_planks', count: 3 }, { name: 'oak_sapling', count: 2 },
        { name: 'mutton', count: 1 }, { name: 'porkchop', count: 6 },
      ];
    });
    await page.getByRole('img', { name: 'crafting table ×1', exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('#camera-controls img')].every(image => image.complete && image.naturalWidth > 0));
    await page.locator('#camera-controls').screenshot({ path: `${screenshotDirectory}/roycraft-inventory-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await liveFrame.evaluate(() => { window.roycraftState.status = 'offline'; });
    await page.getByText('Moss · Offline', { exact: true }).waitFor();
    assert.equal(await page.locator('#camera-kit').textContent(), '');
    await liveFrame.evaluate(() => { window.roycraftState.status = 'online'; window.roycraftState.at = 0; });
    await page.getByText('Moss · Waiting for live observations', { exact: true }).waitFor();
    assert.equal(await page.locator('#camera-kit').textContent(), '');
    assert.equal(await page.locator('#camera-vitals').textContent(), '');
    await liveFrame.evaluate(() => {
      window.roycraftState.at = Date.now();
      window.roycraftState.health = 7;
      window.roycraftState.food = 0;
      window.roycraftState.held = null;
      window.roycraftState.inventory = [];
    });
    await page.getByRole('img', { name: 'Health 7/20', exact: true }).waitFor();
    await page.getByRole('img', { name: 'Food 0/20', exact: true }).waitFor();
    await page.getByRole('img', { name: 'Main hand: Empty', exact: true }).waitFor();
    await page.getByText('Inventory is empty', { exact: true }).waitFor();
    assert.equal(await page.locator('#camera-inventory .mc-slot').count(), 0);
    await liveFrame.evaluate(() => { window.roycraftState.name = 'Roy'; });
    await page.getByText('Moss · Waiting for live observations', { exact: true }).waitFor();
    assert.equal(await page.locator('#camera-kit').textContent(), '');
    await page.getByRole('button', { name: 'Show latest snapshot' }).click();
    assert.equal(await page.locator('#live-feed').count(), 0);
    assert.equal(await page.locator('#camera-controls').isVisible(), false);
    assert.equal(await page.locator('#image-time').getAttribute('hidden'), null);
    data.observedAt = '2020-01-01T00:00:00Z';
    await page.reload();
    await page.getByText(/Stale status/).waitFor();
    assert.equal(await page.locator('.live.stale').count(), 1);
    data.observedAt = now;
    await page.close();
  }
  console.log('Diary mobile/desktop, stale-state and text-injection browser checks passed.');
} finally {
  await browser.close();
}
