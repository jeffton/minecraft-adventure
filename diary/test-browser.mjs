import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const screenshotDirectory = process.env.SCREENSHOT_DIR || '/tmp';
const now = new Date().toISOString();
const data = {
  publishedAt: now, observedAt: now,
  objective: 'Gather wood for the lodge', longTerm: 'A beautiful home and a shared expedition to the End.',
  serverVersion: 'Java 26.3',
  bots: ['Roy', 'Spruce', 'Flint', 'Moss'].map(name => ({ name, role: 'Expedition crew', status: 'online', health: 20, food: 18, task: 'Gathering resources' })),
  milestones: [{ label: 'A shared home', completed: false }, { label: 'Iron and provisions', completed: false }, { label: 'Through the Nether', completed: false }, { label: 'The Ender Dragon', completed: false }],
  entries: [{ at: now, observedAt: now, title: 'The first day', summary: '<img src=x onerror="window.injected=true">', events: ['Roy: Found wood'], image: null, captureError: null }],
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
        return route.fulfill({ contentType: 'text/html', body: `<canvas></canvas><script>window.roycraftConnected=true;window.roycraftState=${JSON.stringify({ name: bot, status: 'online', at: Date.now(), health: 20, food: 18, position: { x: 1, y: 80, z: 3 }, action: 'idle', moving: false, digging: null, held: { name: bot === 'Roy' ? 'stone_sword' : 'iron_pickaxe', count: 1 }, offhand: bot === 'Roy' ? null : { name: 'shield', count: 1 }, inventory: [{ name: bot === 'Roy' ? 'oak_log' : 'coal', count: 7 }] })};</script>` });
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
    assert.equal(await page.locator('#camera-controls').isVisible(), true);
    assert.equal(await page.locator('#camera-controls details').count(), 0);
    assert.equal(await page.locator('select').count(), 0);
    assert.equal(await page.locator('[data-camera]').count(), 4);
    assert.equal(await page.getByText('Four bots.', { exact: true }).count(), 0);
    await page.locator('#live-feed').waitFor();
    assert.equal(await page.locator('#live-toggle, #image-time, #hero-image').count(), 0);
    await page.getByRole('img', { name: 'Main hand: stone sword ×1', exact: true }).waitFor();
    await page.getByRole('img', { name: 'Health 20/20', exact: true }).waitFor();
    assert.equal(await page.locator('#camera-vitals .mc-meter-cell').count(), 20);
    const initialFrame = await (await page.locator('#live-feed').elementHandle()).contentFrame();
    for (const actor of ['Spruce', 'Flint', 'Moss']) {
      await page.locator(`[data-camera="${actor}"]`).click();
      await page.waitForFunction(name => document.querySelector('#live-feed')?.contentWindow.roycraftState?.name === name, actor);
      assert.equal(await page.locator('#live-feed').count(), 1);
      assert.equal(await page.locator('[data-camera][aria-pressed="true"]').getAttribute('data-camera'), actor);
    }
    assert.equal(initialFrame.isDetached(), true);
    await page.getByRole('img', { name: 'Main hand: iron pickaxe ×1', exact: true }).waitFor();
    const shield = page.getByRole('img', { name: 'Off hand: shield ×1', exact: true });
    await shield.waitFor();
    assert.equal(await shield.locator('img').getAttribute('src'), 'item-assets/shield.png');
    assert.equal(await shield.locator('.mc-unmapped').count(), 0);
    assert.equal(await page.locator('#live-feed').count(), 1);
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
    const hud = await page.locator('#camera-controls').boundingBox();
    assert.ok(hud.height < (width < 720 ? 240 : 180), `Compact HUD height: ${hud.height}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await liveFrame.evaluate(() => { window.roycraftState.status = 'offline'; });
    await page.getByText('Moss · Offline', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-camera="Moss"]').getAttribute('data-status'), 'offline');
    await page.getByText('Live inventory unavailable', { exact: true }).waitFor();
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
    await page.locator('[data-camera="Roy"]').click();
    await page.getByRole('img', { name: 'Main hand: stone sword ×1', exact: true }).waitFor();
    await page.locator('[data-camera="Moss"]').click();
    await page.getByRole('img', { name: 'Main hand: iron pickaxe ×1', exact: true }).waitFor();
    assert.equal(await page.locator('#live-feed').count(), 1);
    data.observedAt = '2020-01-01T00:00:00Z';
    await page.reload();
    await page.getByText(/Stale status/).waitFor();
    assert.equal(await page.locator('.live.stale').count(), 1);
    data.observedAt = now;
    data.entries[0].image = 'item-assets/coal.png';
    await page.reload();
    await page.locator('#journal .entry img').waitFor();
    assert.equal(await page.locator('.hero > img').count(), 0);
    assert.equal(await page.locator('[data-camera]').count(), 4);
    data.entries[0].image = null;
    await page.close();
  }
  console.log('Diary mobile/desktop, stale-state and text-injection browser checks passed.');
} finally {
  await browser.close();
}
