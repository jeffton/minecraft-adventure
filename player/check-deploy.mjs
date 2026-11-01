import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export function checkState(health, state, { previousSession, startedAt, now = Date.now() }) {
  if (!health.online || health.error || health.ready !== true) throw new Error(`Player not ready: ${JSON.stringify(health)}`);
  const actor = state.bots[0];
  if (state.worldId !== health.worldId || actor.status !== 'online') throw new Error('Observation is not from the online world');
  if (actor.session === previousSession) throw new Error('Observation still belongs to the previous player session');
  const observedAt = Date.parse(state.updatedAt);
  if (!Number.isFinite(observedAt) || observedAt < startedAt || now - observedAt > 10_000) throw new Error('Observation is stale');
}

export async function checkFeed(io, url) {
  const page = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!page.ok) throw new Error(`Feed HTTP ${page.status}`);
  await page.body.cancel();
  const socket = io(url, { transports: ['websocket'], reconnection: false, autoConnect: false, timeout: 5000 });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Feed state timed out')), 5000);
      const finish = callback => value => { clearTimeout(timer); callback(value); };
      socket.once('connect_error', finish(reject));
      socket.once('adventureState', finish(state => {
        if (state.status !== 'online' || Date.now() - state.at > 10_000) reject(new Error('Feed state is offline or stale'));
        else resolve();
      }));
      socket.connect();
    });
  } finally {
    socket.disconnect();
  }
}

export async function readHealth(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const health = await response.json();
  if (!response.ok) throw Object.assign(new Error(`Health HTTP ${response.status}: ${JSON.stringify(health)}`), { health });
  return health;
}

async function main() {
  const [observation, previousFile, started] = process.argv.slice(2);
  const previousSession = await readFile(previousFile, 'utf8');
  const startedAt = Date.parse(started);
  const deadline = Date.now() + 120_000;
  let failure;
  while (Date.now() < deadline) {
    try {
      const health = await readHealth('http://127.0.0.1:8766/healthz');
      const state = JSON.parse(await readFile(observation, 'utf8'));
      checkState(health, state, { previousSession, startedAt });
      failure = null;
      break;
    } catch (error) {
      if (error.health?.durable?.phase === 'blocked') throw error;
      failure = error;
      console.error(`Waiting for player: ${error.message}`);
      await sleep(2000);
    }
  }
  if (failure) throw failure;
  const require = createRequire('/opt/minecraft-mindcraft/package.json');
  await checkFeed(require('socket.io-client').io, 'http://127.0.0.1:8931/');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
