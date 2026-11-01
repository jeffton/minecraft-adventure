import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const now = new Date().toISOString();
const oldActionId = '81f1fd1b-032a-40cb-8ea4-7df7761d38d9';
const skillName = 'Gather nearby timber';
const data = {
  worldId: 'player-20261101', publishedAt: now, observedAt: now,
  objective: 'Gather wood', longTerm: 'Reach the End.', serverVersion: 'Java 26.3',
  bots: [{ name: 'Roy', role: 'Autonomous player', status: 'online', health: 20, food: 18, task: oldActionId }],
  milestones: [{ label: 'A home', completed: false }],
  archives: [{ worldId: 'legacy-expedition', path: 'archives/legacy-expedition/data.json' }],
  entries: [{ at: now, title: 'The first day', summary: '<img src=x onerror="window.injected=true">', events: [], image: null, captureError: null }],
};
const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('http://diary.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (name === 'data.json') return route.fulfill({ json: data });
      if (name === 'archives/legacy-expedition/data.json') {
        return route.fulfill({ json: { entries: [{ ...data.entries[0], summary: 'My old expedition.', image: 'item-assets/coal.png' }] } });
      }
      if (name === 'live/') {
        return route.fulfill({ contentType: 'text/html', body: `<script>window.roycraftConnected=true;window.roycraftState=${JSON.stringify({ name: 'Roy', status: 'online', at: Date.now(), health: 20, food: 18, time: { timeOfDay: 6000, isDay: true }, dimension: 'overworld', position: { x: 1, y: 80, z: 3 }, action: skillName, moving: false, digging: null, held: { name: 'stone_sword', count: 1 }, offhand: { name: 'shield', count: 1 }, inventory: [{ name: 'oak_log', count: 7 }] })};</script>` });
      }
      if (name.startsWith('map/')) return route.fulfill({ contentType: 'text/html', body: '<p>Map fixture</p>' });
      const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png' };
      const path = name.startsWith('item-assets/') ? `/var/www/roybot.se/minecraft/${name}` : new URL(name, import.meta.url);
      await route.fulfill({ contentType: types[name.split('.').at(-1)], body: await readFile(path) });
    });
    await page.goto('http://diary.test/');
    await page.getByRole('heading', { name: 'Roy', exact: true }).waitFor();
    assert.equal(await page.locator('.bot').count(), 1);
    assert.equal(await page.locator('[data-camera], #live-toggle, select, details').count(), 0);
    assert.equal(await page.locator('#live-feed').count(), 1);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.getByRole('img', { name: 'Main hand: stone sword ×1', exact: true }).waitFor();
    await page.getByRole('img', { name: 'Off hand: shield ×1', exact: true }).waitFor();
    await page.getByRole('img', { name: 'Health 20/20', exact: true }).waitFor();
    assert.equal(await page.locator('#camera-vitals .mc-meter-cell').count(), 20);
    await page.getByRole('img', { name: 'oak log ×7', exact: true }).waitFor();
    const frame = await (await page.locator('#live-feed').elementHandle()).contentFrame();
    const task = page.locator('.bot[data-name="Roy"] .task');
    await task.getByText(skillName, { exact: true }).waitFor();
    assert.ok((await page.locator('#camera-state').textContent()).includes(skillName));
    const clock = page.locator('#world-clock');
    await clock.getByText('12:00', { exact: true }).waitFor();
    for (const [ticks, isDay, label, time] of [[12999, true, 'Day', '18:59'], [13000, false, 'Night', '19:00'], [17999, false, 'Night', '23:59'], [18000, false, 'Night', '00:00'], [23000, true, 'Day', '05:00']]) {
      await frame.evaluate(({ ticks, isDay }) => Object.assign(window.roycraftState, { at: Date.now(), time: { timeOfDay: ticks, isDay } }), { ticks, isDay });
      await clock.getByText(time, { exact: true }).waitFor();
      assert.equal(await clock.locator('.world-clock-label').textContent(), label);
      assert.equal(await clock.getAttribute('data-phase'), label.toLowerCase());
    }
    assert.equal((await page.locator('body').textContent()).includes(oldActionId), false);
    for (const action of ['planning', 'observing', 'idle', '<img src=x onerror="window.skillInjected=true">']) {
      await frame.evaluate(action => Object.assign(window.roycraftState, { action, at: Date.now() }), action);
      await task.getByText(action, { exact: true }).waitFor();
      assert.ok((await page.locator('#camera-state').textContent()).includes(action));
    }
    assert.equal(await task.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.skillInjected), undefined);
    await frame.evaluate(action => Object.assign(window.roycraftState, { action, at: Date.now() }), skillName);
    await task.getByText(skillName, { exact: true }).waitFor();
    await frame.evaluate(() => { window.roycraftState.status = 'offline'; });
    await page.getByText('Roy · Offline', { exact: true }).waitFor();
    assert.equal(await task.textContent(), 'Offline');
    await clock.getByText('—', { exact: true }).waitFor();
    assert.equal(await clock.getAttribute('data-phase'), 'unavailable');
    assert.equal(await page.locator('#camera-kit').textContent(), '');
    await frame.evaluate(() => { window.roycraftState.status = 'online'; window.roycraftState.at = 0; });
    await page.getByText('Roy · Waiting for live observations', { exact: true }).waitFor();
    assert.equal(await task.textContent(), 'Waiting for live observations');
    assert.equal(await clock.locator('.world-clock-time').textContent(), '—');
    await frame.evaluate(() => {
      Object.assign(window.roycraftState, { at: Date.now(), health: 7, food: 0, held: null, offhand: null, inventory: [] });
    });
    await page.getByRole('img', { name: 'Health 7/20', exact: true }).waitFor();
    assert.equal(await task.textContent(), skillName);
    assert.equal(await page.locator('.bot .vitals').textContent(), 'Health 20/20Food 18/20');
    await page.getByText('Inventory is empty', { exact: true }).waitFor();
    await frame.evaluate(() => { window.roycraftState.name = 'SomeoneElse'; });
    await page.getByText('Roy · Waiting for live observations', { exact: true }).waitFor();
    assert.equal(await page.locator('#camera-vitals').textContent(), '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('link', { name: 'legacy-expedition', exact: true }).click();
    await page.getByText('My old expedition.', { exact: true }).waitFor();
    assert.equal(await page.locator('#journal-title').textContent(), 'Field notes · legacy-expedition');
    assert.equal(await page.locator('#objective').textContent(), data.objective);
    await page.locator('.bot .task').getByText(skillName, { exact: true }).waitFor();
    assert.equal((await page.locator('body').textContent()).includes(oldActionId), false);
    assert.equal(await page.locator('#journal img').getAttribute('src'), 'item-assets/coal.png');
    assert.equal(await page.locator('#live-feed').getAttribute('src'), 'live/');
    await page.getByRole('link', { name: 'Current world', exact: true }).click();
    await page.getByText(data.entries[0].summary, { exact: true }).waitFor();
    assert.equal(await page.locator('#journal img').count(), 0);
    data.observedAt = '2020-01-01T00:00:00Z';
    await page.reload();
    await page.getByText(/Stale status/).waitFor();
    data.observedAt = now;
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Single-player desktop/mobile, inventory, stale-state, injection and archived-world checks passed.');
} finally {
  await browser.close();
}
