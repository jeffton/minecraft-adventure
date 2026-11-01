import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const fixture = new URL('./startup-fixture.mjs', import.meta.url);
function start(stateDir, mode) {
  const child = fork(fixture, [stateDir, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const messages = [];
  child.on('message', value => messages.push(value));
  const exited = once(child, 'exit');
  return {
    child, messages, exited,
    async wait(predicate) {
      for (let i = 0; i < 250; i++) {
        const value = messages.find(predicate);
        if (value) return value;
        assert.equal(child.exitCode, null, output);
        assert.equal(child.signalCode, null, output);
        await sleep(20);
      }
      throw new Error(`Fixture timed out: ${output}`);
    },
    async stop(signal = 'SIGTERM') {
      child.kill(signal);
      const [code, received] = await exited;
      if (signal === 'SIGTERM') assert.deepEqual([code, received], [0, null], output);
    },
  };
}
const database = directory => path.join(directory, 'worlds/startup-test/agent.sqlite');
async function interrupted(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'minecraft-startup-'));
  const seed = start(directory, 'seed');
  t.after(() => { if (seed.child.exitCode === null) seed.child.kill('SIGKILL'); });
  await seed.wait(message => message.model === 'started');
  await seed.stop('SIGKILL');
  return directory;
}

test('a parked real Durable task is visible over early health and SIGTERM preserves it without retrying', { timeout: 15000 }, async t => {
  const directory = await interrupted(t);
  const db = new DatabaseSync(database(directory));
  // Simulate five process interruptions of the actual in-flight generation, not a fake status callback.
  const row = db.prepare("SELECT id, record FROM tasks WHERE status = 'running'").get();
  const record = JSON.parse(row.record);
  record.restarts = 5;
  db.prepare('UPDATE tasks SET record = ? WHERE id = ?').run(JSON.stringify(record), row.id);
  db.close();
  const recovering = start(directory, 'recover');
  t.after(() => { if (recovering.child.exitCode === null) recovering.child.kill('SIGKILL'); });
  const { port } = await recovering.wait(message => message.port);
  let health;
  for (let i = 0; i < 150; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    health = await response.json();
    assert.equal(response.status, 503);
    if (health.durable.phase === 'blocked') break;
    await sleep(20);
  }
  assert.equal(health.ready, false);
  assert.equal(health.phase, 'blocked');
  assert.ok(health.durable.tasks.some(task => task.reason === 'restart_limit' && task.id === row.id));
  assert.equal(recovering.messages.some(message => message.model), false);
  await recovering.stop();
  const saved = new DatabaseSync(database(directory));
  assert.equal(saved.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.ok(JSON.parse(saved.prepare('SELECT record FROM tasks WHERE id = ?').get(row.id).record).restarts >= 5);
  saved.close();
});

test('SIGTERM during actual replay closes SQLite cleanly, then the same task can resume normally', { timeout: 15000 }, async t => {
  const directory = await interrupted(t);
  const recovering = start(directory, 'recover-wait');
  t.after(() => { if (recovering.child.exitCode === null) recovering.child.kill('SIGKILL'); });
  const { port } = await recovering.wait(message => message.port);
  await recovering.wait(message => message.model === 'started');
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  const health = await response.json();
  assert.equal(response.status, 503);
  assert.equal(health.durable.phase, 'recovering');
  await recovering.stop();
  const next = start(directory, 'recover');
  t.after(() => { if (next.child.exitCode === null) next.child.kill('SIGKILL'); });
  const { port: nextPort } = await next.wait(message => message.port);
  await next.wait(message => message.ready);
  const ready = await fetch(`http://127.0.0.1:${nextPort}/healthz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).ready, true);
  await next.stop();
  const db = new DatabaseSync(database(directory));
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE status != 'terminal'").get().n, 0);
  const text = db.prepare('SELECT group_concat(record) AS text FROM entries').get().text;
  assert.match(text, /persistent-cave-marker/);
  assert.match(text, /Remember the safe cave entrance/);
  db.close();
});
