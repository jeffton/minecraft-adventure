import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { SkillSandbox } from './sandbox.mjs';
import { createSandboxBroker } from './sandbox-broker.mjs';
import { prepareSandboxRoot } from './sandbox-install.mjs';

const canRun = process.getuid?.() === 0;
let broker;
let directory;
let socketPath;
const run = promisify(execFile);

before(async () => {
  if (!canRun) return;
  directory = mkdtempSync('/var/lib/minecraft-sandbox-test-');
  chmodSync(directory, 0o755);
  prepareSandboxRoot(join(directory, 'root'));
  socketPath = join(directory, 'broker.sock');
  broker = createSandboxBroker({ root: join(directory, 'root'), timeoutMs: 15_000 });
  await new Promise(resolve => broker.listen(socketPath, resolve));
});

after(async () => {
  try {
    if (broker) await new Promise(resolve => broker.close(resolve));
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function fakeRpc() {
  let count = 0;
  let cancels = 0;
  return {
    observe: () => ({ health: 20, inventory: [{ name: 'oak_log', count }], position: { x: 0, y: 64, z: 0 }, blocks: [] }),
    async call(method, args) {
      if (method === 'observe') return this.observe();
      if (method !== 'collect') throw new Error('Method is not allowed');
      count += args[0];
      return count;
    },
    cancel() { cancels++; },
    get cancels() { return cancels; }
  };
}

// Each test waits for the previous transient cgroup to disappear before opening a new action.
async function drained() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const { stdout } = await run('/usr/bin/systemctl', ['list-units', '--no-legend', '--plain', 'minecraft-skill-*']);
    if (!stdout.trim()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test sandbox cgroup did not drain');
}

test('real DynamicUser sandbox has only runtime files, no environment, host files, or IP sockets', { skip: !canRun }, async () => {
  const sandbox = new SkillSandbox({ rpc: fakeRpc(), socketPath });
  process.env.MINECRAFT_TEST_SECRET = 'must-not-cross-boundary';
  const id = sandbox.start(`
    const fs = await import('node:fs/promises');
    const net = await import('node:net');
    const errors = {};
    for (const [key, path] of [['secret','/root/.ssh/id_rsa'],['host','/etc/hostname'],['rootProcess','/proc/1/root/etc/hostname']]) {
      try { await fs.readFile(path); errors[key] = 'READABLE'; } catch (e) { errors[key] = e.code; }
    }
    try { await fs.writeFile('/worker.mjs','bad'); errors.write = 'WRITABLE'; } catch (e) { errors.write = e.code; }
    const network = await new Promise(resolve => {
      const socket = net.connect({host:'127.0.0.1',port:25565});
      socket.on('connect', () => { resolve('CONNECTED'); socket.destroy(); });
      socket.on('error', e => resolve(e.code));
    });
    return { uid:process.getuid(), env:process.env, root:await fs.readdir('/'), errors, network };
  `, { name: 'Run sandbox checks', worldId: 'isolation-test' });
  assert.equal(typeof id, 'string');
  const result = await sandbox.wait(id);
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.notEqual(result.value.uid, 0);
  assert.deepEqual(result.value.env, {});
  assert.notEqual(result.value.errors.secret, 'READABLE');
  assert.notEqual(result.value.errors.host, 'READABLE');
  assert.notEqual(result.value.errors.rootProcess, 'READABLE');
  assert.notEqual(result.value.errors.write, 'WRITABLE');
  assert.notEqual(result.value.network, 'CONNECTED');
  assert.ok(result.value.root.includes('worker.mjs'));
  assert.ok(result.value.root.includes('usr'));
  delete process.env.MINECRAFT_TEST_SECRET;
  await drained();
});

test('real worker composes RPC, returns an immediate handle, and records trusted before/after', { skip: !canRun }, async () => {
  const rpc = fakeRpc();
  const events = [];
  const sandbox = new SkillSandbox({ rpc, socketPath, onEvent: event => events.push(event) });
  const id = sandbox.start('await mc.call("collect", input.count); return await mc.observe();', { name: 'Collect oak logs', input: { count: 3 }, worldId: 'fresh' });
  assert.equal(sandbox.status(id).state, 'running');
  assert.throws(() => sandbox.start('return 1', { name: 'Run sandbox checks', worldId: 'fresh' }), /still running/);
  const result = await sandbox.wait(id);
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.before.inventory[0].count, 0);
  assert.equal(result.after.inventory[0].count, 3, JSON.stringify(result));
  assert.equal(result.calls[0].value, 3);
  assert.equal(result.value.inventory[0].count, 3);
  assert.ok(events.some(event => event.type === 'rpc-result'));
  assert.ok(rpc.cancels > 0);
  await drained();
});

test('cancelling an infinite skill kills its cgroup and invokes host-side Minecraft cancellation', { skip: !canRun }, async () => {
  const rpc = fakeRpc();
  const sandbox = new SkillSandbox({ rpc, socketPath });
  const id = sandbox.start('while(true) {}', { name: 'Run sandbox checks', worldId: 'fresh' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const cancelled = sandbox.cancel(id, 'death');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await sandbox.wait(id)).error, 'death');
  assert.ok(rpc.cancels > 0);
  await drained();
});

test('normal completion permits immediate successor actions without broker-busy races', { skip: !canRun }, async () => {
  const sandbox = new SkillSandbox({ rpc: fakeRpc(), socketPath });
  for (let index = 0; index < 4; index++) {
    const id = sandbox.start('return input;', { name: 'Run sandbox checks', worldId: 'fresh', input: index });
    const result = await sandbox.wait(id);
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.value, index);
    assert.equal(result.settled, true);
  }
});

test('cancellation preserves overlap lock until broker drain and wait permits immediate successor', { skip: !canRun }, async () => {
  const sandbox = new SkillSandbox({ rpc: fakeRpc(), socketPath });
  for (const delay of [1, 100]) {
    const id = sandbox.start('while(true) {}', { name: 'Run sandbox checks', worldId: 'fresh' });
    await new Promise(resolve => setTimeout(resolve, delay));
    sandbox.cancel(id);
    assert.throws(() => sandbox.start('return 1;', { name: 'Run sandbox checks', worldId: 'fresh' }), /still running/);
    assert.equal((await sandbox.wait(id)).settled, true);
    const next = sandbox.start('return 42;', { name: 'Run sandbox checks', worldId: 'fresh' });
    assert.equal((await sandbox.wait(next)).value, 42);
  }
  await drained();
});

test('worker protocol failure drains before wait resolves and immediate successor starts', { skip: !canRun }, async () => {
  const sandbox = new SkillSandbox({ rpc: fakeRpc(), socketPath });
  const id = sandbox.start('console.log("hello"); while(true) {}', { name: 'Run sandbox checks', worldId: 'fresh' });
  const failed = await sandbox.wait(id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.settled, true);
  const next = sandbox.start('return 43;', { name: 'Run sandbox checks', worldId: 'fresh' });
  const result = await sandbox.wait(next);
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.value, 43);
});

test('protocol rejects oversized skill before opening a socket', () => {
  const sandbox = new SkillSandbox({ rpc: fakeRpc() });
  assert.throws(() => sandbox.start('x'.repeat(1_048_576), { name: 'Run sandbox checks', worldId: 'fresh' }), /frame limit/);
  assert.throws(() => sandbox.start('return 1', { name: 'Check world identity' }), /worldId/);
});
