import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillSandbox, rpcFailureKey } from '../sandbox.mjs';
import { readFrames, sendFrame } from '../sandbox-protocol.mjs';
import { shouldDrainForRepair } from '../control-drain.mjs';

async function fixture(t, handle, rpc) {
  const directory = mkdtempSync(join(tmpdir(), 'minecraft-history-test-'));
  const socketPath = join(directory, 'broker.sock');
  const server = createServer(socket => {
    readFrames(socket, message => handle(socket, message), error => socket.destroy(error));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const sandbox = new SkillSandbox({ rpc, socketPath, historyDirectory: join(directory, 'actions') });
  return { sandbox, directory, socketPath };
}

const observation = () => ({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [] });

test('all action/RPC originals survive beyond former quotas without resident completed records', async t => {
  const large = 'large-original-reply-'.repeat(12_000);
  let next = 0;
  const { sandbox } = await fixture(t, (socket, message) => {
    if (message.type === 'start' && message.input.calls) {
      next = 1;
      sendFrame(socket, { type: 'rpc', id: next, method: 'collect', args: [next] });
    } else if (message.type === 'reply') {
      assert.equal(sandbox.actions.size, 1);
      const active = sandbox.status(sandbox.activeId);
      assert.deepEqual(active.calls, []);
      assert.ok(!JSON.stringify(active).includes(large));
      if (next++ < 40) sendFrame(socket, { type: 'rpc', id: next, method: 'collect', args: [next] });
      else {
        const original = sandbox.inspect(active.id);
        assert.equal(original.calls.length, 40);
        assert.equal(original.calls[0].value, large);
        sendFrame(socket, { type: 'result', value: large });
        socket.end();
      }
    } else if (message.type === 'start') {
      sendFrame(socket, { type: 'result', value: message.input });
      socket.end();
    }
  }, { observe: observation, call: async (_, args) => args[0] === 1 ? large : args[0], cancel() {} });

  const first = sandbox.start('return input;', { name: 'Many calls', worldId: 'test-world', input: { calls: true } });
  const full = await sandbox.wait(first);
  assert.equal(full.calls.length, 40);
  assert.equal(full.calls[0].value, large);
  assert.equal(full.value, large);
  assert.equal(full.waitingOnly, false);
  assert.equal(sandbox.actions.size, 0);
  assert.equal(sandbox.status(first).value, large);
  assert.equal((await sandbox.wait(first, { details: false })).value, large);
  assert.deepEqual((await sandbox.wait(first, { details: false })).calls, []);
  assert.deepEqual(sandbox.status(first).before.inventory, []);
  assert.deepEqual(sandbox.status(first).after.position, { x: 0, y: 64, z: 0 });
  assert.match(sandbox.status(first).history.projection, /complete original/);
  assert.equal(JSON.parse(readFileSync(join(full.history.directory, 'request.json'), 'utf8')).code, 'return input;');
  for (let index = 0; index < 36; index++) {
    const id = sandbox.start('return input;', { name: 'Next action', worldId: 'test-world', input: index });
    assert.equal((await sandbox.wait(id)).value, index);
    assert.equal(sandbox.actions.size, 0);
  }
  assert.equal(sandbox.inspect(first).calls[0].value, large);
  const reopened = new SkillSandbox({ rpc: {}, historyDirectory: sandbox.historyDirectory });
  assert.equal(reopened.status(first).settled, true);
  assert.equal((await reopened.wait(first)).value, large);
  assert.equal(reopened.inspect(first).calls[39].value, 40);
});

test('cancel waits for both broker exit and in-flight host RPC before persisting final evidence', async t => {
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  let finishRpc;
  let count = 0;
  const { sandbox } = await fixture(t, (socket, message) => {
    if (message.type === 'start') sendFrame(socket, { type: 'rpc', id: 1, method: 'collect', args: [1] });
    if (message.type === 'cancel') socket.end();
  }, {
    observe: () => ({ ...observation(), inventory: [{ name: 'oak_log', count }] }),
    async call() { begin(); await new Promise(resolve => { finishRpc = resolve; }); count++; return 'settled-original'; },
    cancel() {},
  });
  const id = sandbox.start('await mc.call("collect",1);', { name: 'Delayed host call', worldId: 'test-world' });
  await started;
  assert.equal(sandbox.inspect(id).calls[0].method, 'collect');
  sandbox.cancel(id, 'death');
  let settled = false;
  const waiting = sandbox.wait(id).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(sandbox.status(id).settled, false);
  assert.throws(() => sandbox.start('return 1;', { name: 'Overlap', worldId: 'test-world' }), /still running/);
  finishRpc();
  const full = await waiting;
  assert.equal(full.state, 'cancelled');
  assert.equal(full.settled, true);
  assert.equal(full.after.inventory[0].count, 1);
  assert.equal(full.calls[0].value, 'settled-original');
  assert.equal(sandbox.actions.size, 0);
  assert.equal(sandbox.cancel(id).state, 'cancelled');
});

test('running repeated RPC failures retain only a matching streak while originals remain inspectable', async t => {
  let index = 0;
  const args = [{ x: 10, y: 64, z: 0, original: 'large-argument-'.repeat(5_000) }];
  const { sandbox } = await fixture(t, (socket, message) => {
    if (message.type === 'start' || message.type === 'reply' && index < 40) {
      sendFrame(socket, { type: 'rpc', id: ++index, method: 'goto', args });
    } else if (message.type === 'reply') {
      const status = sandbox.status(sandbox.activeId);
      assert.equal(status.failureStreak.count, 40);
      assert.equal(status.failureStreak.key, rpcFailureKey('goto', args));
      assert.deepEqual(status.calls, []);
      assert.ok(!JSON.stringify(status).includes('large-argument-'));
      sendFrame(socket, { type: 'result', value: 'stopped retrying' });
      socket.end();
    }
  }, { observe: observation, async call() { throw new Error('No path'); }, cancel() {} });
  const id = sandbox.start('return input;', { name: 'Failed routes', worldId: 'test-world' });
  const result = await sandbox.wait(id);
  assert.equal(result.calls.length, 40);
  assert.deepEqual(result.calls[39].args, args);
  assert.equal(result.calls[39].error, 'No path');
  assert.ok(result.calls[39].completedAt);
  assert.equal(sandbox.actions.size, 0);
});

test('repair cancellation uses a lean matching failure streak, not accumulated raw calls', () => {
  const args = [{ x: 10, y: 64, z: 0 }];
  const action = { id: 'current', state: 'running', before: observation(), calls: [], failureStreak: { key: rpcFailureKey('goto', args), count: 40 } };
  const analysis = { worldEffect: 1, reasons: [{ kind: 'rpc_failure', details: { actionId: 'current', method: 'goto', args } }] };
  assert.equal(shouldDrainForRepair({ analysis, action, observed: observation(), worldEffect: 1 }), true);
  analysis.reasons[0].details.args[0].x++;
  assert.equal(shouldDrainForRepair({ analysis, action, observed: observation(), worldEffect: 1 }), false);
});
