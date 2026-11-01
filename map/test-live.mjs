import assert from 'node:assert/strict';
import { chromium } from '/opt/minecraft-adventure/diary/node_modules/playwright-core/index.mjs';

if (process.getuid() === 0) throw new Error('Run this check as minecraft-diary, not root');
const browser = await chromium.launch({
  executablePath: '/opt/google/chrome/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
const origin = 'https://minecraft.roybot.se';
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const embed = page.locator('iframe[title="Isometric map and live player positions"]');
    await embed.scrollIntoViewIfNeeded();
    const frame = await (await embed.elementHandle()).contentFrame();
    await frame.waitForFunction(() => {
      const app = window.bluemap;
      const viewer = app?.mapViewer;
      return viewer?.controlsManager.position.y > -1000 &&
        viewer.controlsManager.ortho === 1 &&
        viewer.controlsManager.angle > 0.6 &&
        [...viewer.map.hiresTileManager.tiles.values()].some(tile => tile.loaded);
    }, undefined, { timeout: 90000 });

    const snapshot = await frame.evaluate(async () => {
      const app = window.bluemap;
      const feed = await (await fetch('maps/overworld/live/players.json')).json();
      return {
        positions: feed.players.map(player => ({
          name: player.name,
          source: player.position,
          marker: app.playerMarkerManager.getPlayerMarker(player.uuid)?.data.position,
        })),
        loadedTiles: [...app.mapViewer.map.hiresTileManager.tiles.values()].filter(tile => tile.loaded).length,
        map: app.mapViewer.map.data.id,
        camera: { ...app.mapViewer.controlsManager.position },
      };
    });
    assert.equal(snapshot.map, 'overworld');
    assert.ok(snapshot.positions.length >= 4);
    for (const name of ['Roy', 'Spruce', 'Flint', 'Moss']) {
      assert.ok(snapshot.positions.some(player => player.name === name));
    }
    for (const player of snapshot.positions) {
      assert.ok(player.marker, 'every actual player must have a marker');
      assert.ok(Math.hypot(player.marker.x - player.source.x, player.marker.z - player.source.z) < 10);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `/tmp/roycraft-map-${width}.png` });

    // Pan and zoom actual controls, then follow an actual live server marker.
    await frame.evaluate(() => {
      const app = window.bluemap;
      app.mapViewer.controlsManager.position.x += 20;
      app.mapViewer.controlsManager.distance -= 30;
    });
    await frame.waitForFunction(() => window.bluemap.mapViewer.controlsManager.position.y > -1000);
    const followed = await frame.evaluate(async () => {
      const app = window.bluemap;
      const feed = await (await fetch('maps/overworld/live/players.json')).json();
      const player = feed.players.find(player => player.name === 'Roy');
      app.mapControls.followPlayerMarker(app.playerMarkerManager.getPlayerMarker(player.uuid));
      return player;
    });
    await frame.waitForFunction(player => {
      const app = window.bluemap;
      const position = app.mapViewer.controlsManager.position;
      const marker = app.playerMarkerManager.getPlayerMarker(player.uuid).data.position;
      return Math.hypot(position.x - marker.x, position.z - marker.z) < 1;
    }, followed);
    for (const dimension of ['nether', 'end']) {
      await frame.evaluate(dimension => window.bluemap.switchMap(dimension), dimension);
      assert.equal(await frame.evaluate(() => window.bluemap.mapViewer.controlsManager.ortho), 1);
      const data = await frame.evaluate(() => ({
        id: window.bluemap.mapViewer.map.data.id,
        players: window.bluemap.playerMarkerManager.root.markers?.size,
      }));
      assert.equal(data.id, dimension);
      const foreign = await (await page.request.get(`${origin}/map/maps/${dimension}/live/players.json`)).json();
      assert.ok(foreign.players.every(player => player.foreign), 'Overworld players must not be plotted as local Nether/End players');
    }
    await page.context().setOffline(true);
    await frame.waitForFunction(() => document.querySelector('#roycraft-map-connection').textContent.startsWith('Offline'));
    await page.context().setOffline(false);
    await frame.waitForFunction(() => document.querySelector('#roycraft-map-connection').textContent === 'Live positions', undefined, { timeout: 30000 });
    assert.deepEqual(errors, []);
    console.log(`${width}px PASS ${JSON.stringify(snapshot)}`);
    await page.close();
  }
} finally {
  await browser.close();
}
