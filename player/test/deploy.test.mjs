import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkState, checkFeed, readHealth } from '../check-deploy.mjs';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'player-deploy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['player', 'bots/test', 'bin', 'target/player/node_modules', 'target/bots/assets/entities', 'trash', 'ui']) {
    await mkdir(path.join(dir, name), { recursive: true });
  }
  await copyFile(new URL('../deploy.sh', import.meta.url), path.join(dir, 'player/deploy.sh'));
  await copyFile(new URL('../../diary/publish-ui.sh', import.meta.url), path.join(dir, 'publish-ui.sh'));
  for (const name of ['player/runtime.mjs', 'player/sandbox-install.mjs', 'player/check-deploy.mjs', 'player/package.json', 'player/package-lock.json', 'bots/viewer-light.mjs', 'bots/compat-loader.mjs', 'bots/chunk-light.mjs', 'bots/build-viewer.mjs', 'bots/test/viewer-light.test.mjs']) {
    await writeFile(path.join(dir, name), 'fixture');
  }
  for (const name of await readdir(new URL('../../bots/', import.meta.url))) {
    if ((name.startsWith('viewer') && name.endsWith('.mjs')) || ['compat-loader.mjs', 'inventory-controller.mjs', 'chunk-light.mjs'].includes(name)) {
      await copyFile(new URL(`../../bots/${name}`, import.meta.url), path.join(dir, 'bots', name));
    }
  }
  await writeFile(path.join(dir, 'observation.json'), JSON.stringify({ bots: [{ session: 'old' }] }));
  const commands = {
    npm: `echo "npm $*" >> "$LOG"
if [[ "$*" == ci* ]]; then mkdir -p "$3/node_modules"; fi`,
    node: `echo "node $*" >> "$LOG"
if [[ "$1" == -e ]]; then exec "$REAL_NODE" "$@"; fi
if [[ "$1" == *build-viewer.mjs ]]; then
  [[ "\u0024{FAIL:-}" != build ]] || exit 17
  mkdir -p "\u0024{1%/*}/assets"
  echo worker > "\u0024{1%/*}/assets/worker.js"
fi
if [[ "$1" == *sandbox-install.mjs && "\u0024{FAIL:-}" == install ]]; then exit 18; fi
if [[ "$1" == *check-deploy.mjs && "\u0024{FAIL:-}" == readiness ]]; then exit 19; fi`,
    systemctl: 'echo "systemctl $*" >> "$LOG"',
    trash: 'mv "$2" "$FAKE_TRASH/$(basename "$2")"',
  };
  for (const [name, script] of Object.entries(commands)) {
    await writeFile(path.join(dir, 'bin', name), '#!/usr/bin/env bash\nset -euo pipefail\n' + script + '\n', { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, LOG: `${dir}/log`, REAL_NODE: process.execPath, FAKE_TRASH: `${dir}/trash`, PLAYER_DEPLOY_ROOT: `${dir}/target`, PLAYER_OBSERVATION_FILE: `${dir}/observation.json`, DIARY_UI_ROOT: `${dir}/ui` };
  return { dir, env, run: fail => spawnSync('bash', [`${dir}/player/deploy.sh`], { env: { ...env, FAIL: fail ?? '' }, encoding: 'utf8' }) };
}

const rootOnly = { skip: process.getuid() !== 0 ? 'Deploy requires root' : false };
test('deploy stages tests/dependencies/build before stopping only the player', rootOnly, async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const log = await readFile(`${f.dir}/log`, 'utf8');
  assert.ok(log.indexOf('npm ci') < log.indexOf('systemctl stop'));
  assert.ok(log.indexOf('/bots/build-viewer.mjs') < log.indexOf('systemctl stop'));
  assert.ok(log.indexOf('systemctl stop') < log.indexOf('/target/player/sandbox-install.mjs'));
  assert.ok(log.indexOf('/target/player/sandbox-install.mjs') < log.indexOf('systemctl start'));
  assert.ok(log.indexOf('systemctl start') < log.lastIndexOf('/player/check-deploy.mjs'));
  assert.deepEqual(log.split('\n').filter(line => line.startsWith('systemctl')), ['systemctl stop minecraft-player.service', 'systemctl start minecraft-player.service']);
  assert.equal(await readFile(`${f.dir}/target/bots/assets/worker.js`, 'utf8'), 'worker\n');
  // Check the installed import closure, not only the script's explicit file list.
  for (const name of await readdir(`${f.dir}/target/bots`)) {
    if (!name.endsWith('.mjs')) continue;
    const source = await readFile(`${f.dir}/target/bots/${name}`, 'utf8');
    for (const [, dependency] of source.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) {
      await readFile(path.resolve(f.dir, 'target/bots', dependency));
    }
  }
});

for (const [failure, status, stopped, started] of [['build', 17, false, false], ['install', 18, true, false], ['readiness', 19, true, true]]) {
  test(`deploy exposes ${failure} failure without automatic recovery`, rootOnly, async t => {
    const f = await fixture(t);
    const result = f.run(failure);
    assert.equal(result.status, status, result.stderr);
    const log = await readFile(`${f.dir}/log`, 'utf8');
    assert.equal(log.includes('systemctl stop'), stopped);
    assert.equal(log.includes('systemctl start'), started);
    assert.ok(!result.stdout.includes('Player deployed;'));
  });
}

test('static publishing preserves journal data without npm or service changes', async t => {
  const f = await fixture(t);
  for (const file of ['index.html', 'style.css', 'app.js', 'map.css', 'map.js', 'inventory.css', 'inventory.js', 'world-clock.js']) await writeFile(`${f.dir}/${file}`, 'new static');
  await writeFile(`${f.dir}/ui/data.json`, 'journal');
  const result = spawnSync('bash', [`${f.dir}/publish-ui.sh`], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(`${f.dir}/ui/index.html`, 'utf8'), 'new static');
  assert.equal(await readFile(`${f.dir}/ui/data.json`, 'utf8'), 'journal');
  assert.doesNotMatch(await readFile(`${f.dir}/log`, 'utf8'), /npm|systemctl/);
});

test('readiness rejects old sessions, stale observations and parked startup', () => {
  const now = Date.now();
  const health = { ready: true, online: true, error: null, worldId: 'world' };
  const state = { worldId: 'world', updatedAt: new Date(now).toISOString(), bots: [{ status: 'online', session: 'new' }] };
  const context = { previousSession: 'old', startedAt: now - 1000, now };
  checkState(health, state, context);
  assert.throws(() => checkState({ ...health, ready: false, durable: { phase: 'parked' } }, state, context), /not ready/);
  assert.throws(() => checkState(health, state, { ...context, previousSession: 'new' }), /previous/);
  assert.throws(() => checkState(health, { ...state, updatedAt: new Date(now - 20_000).toISOString() }, context), /stale/);
});

test('parked 503 health preserves Durable diagnostics', async t => {
  const server = createServer((request, response) => {
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ready: false, durable: { phase: 'parked', tasks: [{ id: 2342 }] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(readHealth(`http://127.0.0.1:${server.address().port}/healthz`), /Health HTTP 503: .*parked.*2342/);
});

test('feed check requires live socket state and always disconnects', async t => {
  const server = createServer((request, response) => response.end('feed'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let disconnected = 0;
  const io = status => () => {
    const socket = new EventEmitter();
    socket.connect = () => socket.emit('adventureState', { status, at: Date.now() });
    socket.disconnect = () => disconnected++;
    return socket;
  };
  const url = `http://127.0.0.1:${server.address().port}/`;
  await checkFeed(io('online'), url);
  await assert.rejects(checkFeed(io('offline'), url), /offline/);
  assert.equal(disconnected, 2);
});

test('cold feed startup can publish its first real state after five seconds without reconnecting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => new Response('feed'));
  let connected = 0;
  let disconnected = 0;
  const pending = checkFeed(() => {
    const socket = new EventEmitter();
    socket.connect = () => {
      connected++;
      setTimeout(() => socket.emit('adventureState', { status: 'online', at: Date.now() }), 6000);
    };
    socket.disconnect = () => disconnected++;
    return socket;
  }, 'http://feed.test/');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(6000);
  await pending;
  assert.equal(connected, 1);
  assert.equal(disconnected, 1);
});
