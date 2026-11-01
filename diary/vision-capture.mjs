import http from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const PORTS = { Roy: 8931, Spruce: 8932, Flint: 8933, Moss: 8934 };

export function selectBaseCamera(state, now = Date.now()) {
  if (!Number.isFinite(Date.parse(state.updatedAt)) || now - Date.parse(state.updatedAt) > 60000 || Date.parse(state.updatedAt) > now + 5000) throw new Error('Building camera observations are stale');
  const home = state.home;
  if (!home) throw new Error('No observed shared base');
  const bots = state.bots.filter(bot => Object.hasOwn(PORTS, bot.name) && bot.status === 'online' && bot.dimension === home.dimension &&
    Math.hypot(...['x', 'y', 'z'].map(axis => bot.position[axis] - home[axis])) <= 24);
  // Prefer the bot nearest the base so the observer camera remains inside loaded terrain.
  bots.sort((a, b) => Math.hypot(a.position.x - home.x, a.position.z - home.z) - Math.hypot(b.position.x - home.x, b.position.z - home.z));
  if (!bots.length) throw new Error('No online bot has the base in its loaded vicinity');
  const source = bots[0];
  // Seven streamed chunk columns give a 112-block square. Keep the observer
  // within eight blocks of its centre so the full 90-block readiness footprint fits.
  const viewpoint = { y: home.y + 10 };
  for (const axis of ['x', 'z']) {
    const centre = Math.floor(source.position[axis] / 16) * 16 + 8;
    viewpoint[axis] = Math.max(centre - 8, Math.min(centre + 8, home[axis] + 12));
  }
  return { home, bot: source.name, sourceSession: source.session, sourceDimension: source.dimension, observedAt: state.updatedAt, viewpoint };
}

export async function captureBase(state) {
  const selected = selectBaseCamera(state);
  const browser = await chromium.launch({
    executablePath: '/opt/google/chrome/chrome', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${PORTS[selected.bot]}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => window.roycraftMotion && window.roycraftViewer, null, { timeout: 15000 });
    await page.evaluate(({ home, viewpoint }) => {
      // Move only the renderer's observer camera. Never move or turn the game bot.
      window.roycraftMotion.receive = () => {};
      window.roycraftMotion.frame = viewer => {
        viewer.camera.position.set(viewpoint.x, viewpoint.y, viewpoint.z);
        viewer.camera.lookAt(home.x, home.y + 2, home.z);
      };
      window.roycraftCapture = null;
      window.roycraftCaptureRequested = true;
    }, selected);
    await page.waitForFunction(() => typeof window.roycraftCapture === 'string', null, { timeout: 30000 });
    const rendered = await page.evaluate(() => ({ data: window.roycraftCapture, state: window.roycraftState }));
    if (errors.length) throw new Error('Building renderer: ' + errors.join('; '));
    if (rendered.state?.name !== selected.bot || Date.now() - rendered.state.at > 10000) throw new Error('Building renderer telemetry is not current');
    if (Math.hypot(...['x', 'y', 'z'].map(axis => rendered.state.position[axis] - selected.home[axis])) > 24) throw new Error('Camera source left the base vicinity during capture');
    const bytes = Buffer.from(rendered.data.split(',')[1], 'base64');
    if (bytes.length > 1024 * 1024) throw new Error('Building camera exceeds 1 MiB');
    return {
      ...selected, capturedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      image: { type: 'image', mimeType: 'image/webp', data: bytes.toString('base64') },
    };
  } finally {
    await browser.close();
  }
}

export async function startCaptureServer({ capture = captureBase, port = 8935 } = {}) {
  let busy = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'POST' || request.url !== '/capture') return response.writeHead(404).end();
    if (busy) return response.writeHead(409).end(JSON.stringify({ error: 'Building capture already running' }));
    busy = true;
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 16384) throw new Error('Building camera observations exceed 16 KiB');
      }
      response.end(JSON.stringify(await capture(JSON.parse(body))));
    } catch (error) {
      console.error('Building capture failed:', error.message);
      response.writeHead(502).end(JSON.stringify({ error: error.message }));
    } finally {
      busy = false;
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

if (import.meta.url === 'file://' + process.argv[1]) await startCaptureServer();
