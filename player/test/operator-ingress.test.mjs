import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openGameChat, chatBlocksController } from '../game-chat.mjs';
import { playerRequestHandler } from '../player-http.mjs';
import { startPlayerLifecycle } from '../lifecycle.mjs';
import { ControllerLoop } from '../controller-loop.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'minecraft-operator-'));
  const file = path.join(directory, 'chat.json');
  const events = [];
  const sends = [];
  const open = () => openGameChat(file, { send: message => sends.push(message), onEvent: (...event) => events.push(event) });
  const chat = await open();
  const token = 'local-test-credential-not-production';
  const server = await startPlayerLifecycle({ worldId: 'fixture-world', port: 0, signals: new EventEmitter() });
  t.after(() => server.close());
  const failures = [];
  server.handler(playerRequestHandler({ token, worldId: 'fixture-world', chat, narrate: async facts => ({ paragraph: facts.summary }), onError: error => failures.push(error) }));
  server.update({ phase: 'ready', ready: true });
  const post = (input, authorization = `Bearer ${token}`, route = '/operator/task') => fetch(`http://127.0.0.1:${server.address.port}${route}`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  return { chat, file, open, events, sends, post, failures };
}

test('local auth and world are required; caller cannot impersonate a Minecraft player', async t => {
  const f = await fixture(t);
  const input = { worldId: 'fixture-world', id: 'bed', text: 'Move bed upstairs' };
  assert.equal((await f.post(input, '')).status, 401);
  assert.equal((await f.post(input, 'Bearer wrong')).status, 401);
  assert.equal((await f.post({ ...input, worldId: 'other-world' })).status, 409);
  assert.equal((await f.post({ ...input, text: '' })).status, 400);
  assert.equal(f.chat.hasPending(), false);
  const response = await f.post({ ...input, sender: { username: 'Louis' }, channel: 'public' });
  assert.equal(response.status, 202);
  const [message] = f.chat.snapshot().pending;
  assert.deepEqual(message.sender, { username: 'RoyOperator', uuid: null, origin: 'operator-relayed-user-request' });
  assert.equal(message.channel, 'operator');
  assert.equal(f.events[0][0], 'operator_message');
  assert.equal((await f.post(input)).status, 200);
  assert.equal(f.chat.snapshot().pending.length, 1);
  assert.equal((await f.open()).snapshot().pending[0].id, message.id);
  const diary = await f.post({ worldId: 'fixture-world', summary: 'Still working' }, undefined, '/diary');
  assert.equal(diary.status, 200);
  assert.equal((await diary.json()).paragraph, 'Still working');
  assert.deepEqual(f.failures, []);
});

test('live receipt preserves the running skill and uses the chat planning boundary without game output', async t => {
  const f = await fixture(t);
  let active = { settled: false };
  let decisions = 0;
  const loop = new ControllerLoop({
    controller: { current: () => ({ version: 'old' }), inspect: () => ({ status: 'admitted' }), decide: () => { decisions++; return { action: null, replan: true, reason: 'done' }; } },
    pipeline: { current: () => active }, observe: () => ({ inventory: [], entities: [], blocks: [] }), context: () => ({ health: 20 }),
  });
  await f.post({ worldId: 'fixture-world', id: 'bed', text: 'Drop basement; move bed upstairs; build a usable ladder.' });
  assert.equal(f.chat.hasPending(), true, 'runtime player_chat trigger sees the request immediately');
  await loop.tick(Date.now(), { activateOnly: chatBlocksController(f.chat, null) });
  assert.equal(active.settled, false);
  assert.equal(decisions, 0);
  active = null;
  await loop.tick(Date.now(), { activateOnly: chatBlocksController(f.chat, null) });
  assert.equal(decisions, 0, 'old controller waits for request planning');
  const [message] = f.chat.snapshot().pending;
  await f.chat.reply({ id: message.id, text: 'I will move the bed and build access.', task: message.text });
  assert.deepEqual(f.sends, [], 'operator acknowledgment never goes to a player');
  assert.equal(f.chat.hasPending(), false);
  const restored = await f.open();
  assert.equal(restored.snapshot().tasks[0].sender.origin, 'operator-relayed-user-request');
  assert.equal(restored.snapshot().tasks[0].task, message.text);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).messages[0].status, 'handled');
  await loop.tick(Date.now(), { activateOnly: chatBlocksController(f.chat, null) });
  assert.equal(decisions, 1);
});
