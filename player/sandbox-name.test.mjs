import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillSandbox, validateSkillRequest } from './sandbox.mjs';
import { readFrames, sendFrame } from './sandbox-protocol.mjs';

const rpc = {
  observe: () => ({ health: 20, inventory: [] }),
  call: async () => ({ collected: 3 }),
  cancel() {}
};

test('shared request validation normalizes queue labels and applies the broker input budget without allocating an action', () => {
  const result = validateSkillRequest('return input;', { name: '  Gather oak logs  ', worldId: 'fresh' });
  assert.deepEqual(result, {
    name: 'Gather oak logs',
    request: { type: 'start', code: 'return input;', input: {}, worldId: 'fresh' }
  });
  for (const invoke of [
    (code, options) => validateSkillRequest(code, options),
    (code, options) => new SkillSandbox({ rpc }).start(code, options)
  ]) {
    assert.throws(() => invoke('return input;', { name: 'Gather logs', worldId: 'fresh', input: 'x'.repeat(1_048_576) }), /frame limit/);
    assert.throws(() => invoke('\n'.repeat(524_288), { name: 'Gather logs', worldId: 'fresh' }), /frame limit/);
    const circular = {};
    circular.self = circular;
    assert.throws(() => invoke('return input;', { name: 'Gather logs', worldId: 'fresh', input: circular }), /circular/i);
  }
});

test('names reject missing, blank and control-character labels before creating an action', () => {
  const sandbox = new SkillSandbox({ rpc });
  for (const name of [undefined, null, 42, '', '   ', 'Mine\nwood', 'Mine\twood', 'Mine\0wood', 'Mine\x7fwood', 'Mine\x85wood', '\nMine wood']) {
    assert.throws(() => sandbox.start('return 1;', { name, worldId: 'fresh' }), /Skill name is required/);
    assert.equal(sandbox.activeId, null);
    assert.equal(sandbox.actions.size, 0);
  }
});

test('trimmed names survive status and cancellation without changing identity or source hashes', () => {
  const events = [];
  const sandbox = new SkillSandbox({ rpc, onEvent: event => events.push(event) });
  const id = sandbox.start('return 1;', { name: '  Gather oak logs  ', worldId: 'fresh' });
  const first = sandbox.status(id);
  assert.equal(first.name, 'Gather oak logs');
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  first.name = 'Mutated copy';
  assert.equal(sandbox.status(id).name, 'Gather oak logs');
  const cancelled = sandbox.cancel(id);
  assert.equal(cancelled.name, 'Gather oak logs');
  assert.equal(events[0].action.name, 'Gather oak logs');
  const next = sandbox.start('return 1;', { name: ' '.repeat(5) + 'x'.repeat(80) + ' '.repeat(5), worldId: 'fresh' });
  assert.equal(sandbox.status(next).name.length, 80);
  assert.notEqual(next, id);
  assert.equal(sandbox.status(next).sourceHash, first.sourceHash);
  sandbox.cancel(next);
});

test('start, RPC and completion events carry readable names without changing broker messages', async () => {
  const events = [];
  const socketPath = join(mkdtempSync(join(tmpdir(), 'minecraft-skill-names-')), 'broker.sock');
  const server = createServer(socket => {
    readFrames(socket, message => {
      if (message.type === 'start') {
        assert.equal(Object.hasOwn(message, 'name'), false);
        sendFrame(socket, { type: 'rpc', id: 1, method: 'collect', args: [3] });
      } else if (message.type === 'reply') {
        sendFrame(socket, { type: 'result', value: message.value });
        socket.end();
      }
    }, error => { throw error; });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    const sandbox = new SkillSandbox({ rpc, socketPath, onEvent: event => events.push(event) });
    const id = sandbox.start('return await mc.call("collect",3);', { name: '  Gather three logs  ', worldId: 'fresh' });
    const result = await sandbox.wait(id);
    assert.equal(result.state, 'completed');
    assert.equal(result.name, 'Gather three logs');
    assert.equal(events.find(event => event.type === 'action-start').action.name, result.name);
    assert.equal(events.find(event => event.type === 'rpc-result').actionName, result.name);
    assert.equal(events.find(event => event.type === 'action-end').action.name, result.name);
    assert.deepEqual(result.value, { collected: 3 });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
