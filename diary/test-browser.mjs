import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

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
        return route.fulfill({ contentType: 'text/html', body: `<canvas></canvas><script>window.roycraftConnected=true;window.roycraftState=${JSON.stringify({ name: bot, at: Date.now(), health: 20, food: 18, position: { x: 1, y: 80, z: 3 }, action: 'idle', moving: false, digging: null, held: { name: bot === 'Roy' ? 'stone_sword' : 'iron_pickaxe', count: 1 }, offhand: null, inventory: [{ name: bot === 'Roy' ? 'oak_log' : 'coal', count: 7 }] })};</script>` });
      }
      const types = { 'index.html': 'text/html', 'app.js': 'text/javascript', 'style.css': 'text/css' };
      await route.fulfill({ contentType: types[name], body: await readFile(new URL(name, import.meta.url)) });
    });
    await page.goto('http://diary.test/');
    await page.getByRole('heading', { name: 'Roy', exact: true }).waitFor();
    assert.equal(await page.locator('.bot').count(), 4);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `/tmp/roycraft-diary-${width}.png`, fullPage: true });
    assert.equal(await page.locator('#camera-controls').isVisible(), false);
    await page.getByRole('button', { name: 'Watch live' }).click();
    await page.locator('#live-feed').waitFor();
    assert.equal(await page.locator('#live-toggle').getAttribute('aria-pressed'), 'true');
    await page.getByText('Main hand: stone sword ×1', { exact: true }).waitFor();
    await page.locator('#camera-bot').selectOption('Moss');
    await page.getByText('Main hand: iron pickaxe ×1', { exact: true }).waitFor();
    assert.equal(await page.locator('#live-feed').count(), 1);
    assert.equal(await page.locator('#camera-inventory').textContent(), 'coal ×7');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const liveFrame = await (await page.locator('#live-feed').elementHandle()).contentFrame();
    await liveFrame.evaluate(() => { window.roycraftState.at = 0; });
    await page.getByText('Moss · Waiting for live observations', { exact: true }).waitFor();
    assert.equal(await page.locator('#camera-kit').textContent(), '');
    await page.getByRole('button', { name: 'Show latest snapshot' }).click();
    assert.equal(await page.locator('#live-feed').count(), 0);
    assert.equal(await page.locator('#camera-controls').isVisible(), false);
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
