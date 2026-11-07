import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openGameChat, attachGameChat, sendGameChat, chatBlocksController } from '../game-chat.mjs';
import { ControllerLoop } from '../controller-loop.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const human = { username: 'TestPlayer', uuid: '110d90d0-2f13-48ee-bcac-bbb0b2763025' };
const own = { username: 'Roy', uuid: '0b14879a-cd6c-348a-8d93-cbc2a12f4aea' };

function fakeBot() {
  const bot = new EventEmitter();
  bot.registry = require('prismarine-registry')('1.21.4');
  bot.registry.loadDimensionCodec(bot.registry.loginPacket.dimensionCodec['minecraft:chat_type']);
  bot.version = '1.21.4';
  bot.supportFeature = name => bot.registry.supportFeature(name);
  bot.username = own.username;
  bot.player = own;
  bot.players = { Roy: own, TestPlayer: human };
  bot._client = new EventEmitter();
  bot._client.version = '1.21.4';
  bot._client.write = () => {};
  bot._client.chat = message => bot.output.push(message);
  bot.output = [];
  // The installed protocol decoder and Mineflayer chat plugin, not a second
  // text-pattern parser invented by this fixture.
  require('minecraft-protocol/src/client/chat.js')(bot._client, {});
  require('mineflayer/lib/plugins/chat.js')(bot, {});
  return bot;
}
const wireType = (bot, name) => Number(Object.entries(bot.registry.chatFormattingById).find(([, entry]) => entry.name === name)[0]);

function packet(bot, text, overrides = {}) {
  return {
    senderUuid: human.uuid, index: 1, signature: null, timestamp: BigInt(Date.now()), salt: 1n,
    plainMessage: text, previousMessages: [],
    type: wireType(bot, 'minecraft:chat'),
    networkName: { type: 'compound', value: { text: { type: 'string', value: human.username } } },
    ...overrides,
  };
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'minecraft-chat-'));
  const file = path.join(directory, 'chat.json');
  const bot = fakeBot();
  const failures = [];
  const events = [];
  const open = () => openGameChat(file, { send: message => sendGameChat(bot, message), onEvent: (...event) => events.push(event) });
  const inbox = await open();
  const ChatMessage = require('prismarine-chat')(bot.registry);
  const detach = attachGameChat(bot, inbox, { componentText: value => ChatMessage.fromNotch(value).toString(), onError: error => failures.push(error) });
  return { bot, inbox, open, detach, file, failures, events };
}

test('real Mineflayer/protocol events enqueue humans once, not own/system/display duplicates', async () => {
  const f = await fixture();
  let actualMessages = 0;
  f.bot.on('message', () => actualMessages++);
  const message = packet(f.bot, 'Roy, where is home?');
  f.bot._client.emit('player_chat', message);
  f.bot._client.emit('player_chat', { ...message });
  f.bot.emit('chat', human.username, message.plainMessage);
  f.bot.emit('whisper', human.username, message.plainMessage);
  f.bot._client.emit('player_chat', packet(f.bot, 'my own response', { senderUuid: own.uuid }));
  f.bot._client.emit('player_chat', packet(f.bot, 'unknown player', { senderUuid: 'unknown' }));
  f.bot._client.emit('system_chat', { content: { type: 'compound', value: { text: { type: 'string', value: '<TestPlayer> fake request' } } }, isActionBar: false });
  await f.inbox.flush();
  assert.deepEqual(f.failures, []);
  assert.ok(actualMessages >= 3, 'installed Mineflayer plugin actually decoded chat');
  assert.equal(f.inbox.snapshot().pending.length, 1);
  assert.equal(f.inbox.snapshot().pending[0].sender.uuid, human.uuid);
  assert.equal(f.inbox.snapshot().pending[0].text, message.plainMessage);
  f.detach();
});

test('private incoming protocol chat is private, outgoing whispers and wrong targets ignored', async () => {
  const f = await fixture();
  const incoming = wireType(f.bot, 'minecraft:msg_command_incoming');
  f.bot._client.emit('player_chat', packet(f.bot, 'Where are you?', {
    type: incoming, networkTargetName: { type: 'compound', value: { text: { type: 'string', value: 'Roy' } } },
  }));
  f.bot._client.emit('player_chat', packet(f.bot, 'not for Roy', {
    type: incoming, networkTargetName: { type: 'compound', value: { text: { type: 'string', value: 'OtherPlayer' } } },
  }));
  f.bot._client.emit('player_chat', packet(f.bot, 'outgoing', { type: wireType(f.bot, 'minecraft:msg_command_outgoing'), networkTargetName: { type: 'compound', value: { text: { type: 'string', value: 'OtherPlayer' } } } }));
  await f.inbox.flush();
  assert.deepEqual(f.failures, []);
  const [message] = f.inbox.snapshot().pending;
  assert.equal(f.inbox.snapshot().pending.length, 1);
  assert.equal(message.channel, 'private');
  await f.inbox.reply({ id: message.id, text: 'At home.\n/tp dangerous' });
  assert.deepEqual(f.bot.output, ['/tell TestPlayer At home. /tp dangerous']);
  f.detach();
});

test('profileless whisper matches online identity and preserves repeated legitimate messages', async () => {
  const f = await fixture();
  const nbt = text => ({ type: 'compound', value: { text: { type: 'string', value: text } } });
  const message = { type: wireType(f.bot, 'minecraft:msg_command_incoming'), name: nbt(human.username), target: nbt('Roy'), message: nbt('Please build a bed') };
  f.bot._client.emit('profileless_chat', message);
  f.bot._client.emit('profileless_chat', message);
  f.bot._client.emit('profileless_chat', { ...message });
  f.bot._client.emit('profileless_chat', { ...message, name: nbt('NotOnline') });
  await f.inbox.flush();
  assert.deepEqual(f.failures, []);
  assert.equal(f.inbox.snapshot().pending.length, 2);
  assert.ok(f.inbox.snapshot().pending.every(entry => entry.channel === 'private'));
  f.detach();
});

test('questions and accepted tasks persist, ordered replies are idempotent across restart', async () => {
  const f = await fixture();
  const first = packet(f.bot, 'Where are you?');
  const second = packet(f.bot, 'Build a bed', { index: 2 });
  f.bot._client.emit('player_chat', first);
  f.bot._client.emit('player_chat', second);
  await f.inbox.flush();
  const [question, task] = f.inbox.snapshot().pending;
  await assert.rejects(f.inbox.reply({ id: task.id, text: 'I will gather wool.' }), /arrival order/);
  await f.inbox.reply({ id: question.id, text: 'Home at 168,70,-175.' });
  await f.inbox.reply({ id: task.id, text: 'I will gather matching wool, then craft a bed.', task: 'Gather wool and craft/place a bed.' });
  const restored = await f.open();
  assert.equal(restored.hasPending(), false);
  assert.equal(restored.snapshot().tasks[0].task, 'Gather wool and craft/place a bed.');
  assert.equal(await restored.receive({ ...task, status: undefined }), false);
  await restored.reply({ id: question.id, text: 'duplicate' });
  assert.equal(f.bot.output.length, 2);
  assert.match(f.bot.output[0], /^TestPlayer: Home/);
  await restored.finishTask({ id: task.id, status: 'completed', evidence: 'Observed bed block and server-confirmed sleeping.' });
  assert.equal(restored.snapshot().tasks.length, 0);
  f.detach();
});

test('ambiguous network failure is retained, never blindly resent after restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'minecraft-chat-uncertain-'));
  const file = path.join(directory, 'chat.json');
  let sends = 0;
  const send = () => { sends++; throw new Error('transport lost'); };
  const inbox = await openGameChat(file, { send });
  await inbox.receive({ id: 'request', sender: human, channel: 'private', text: 'Build a bed' });
  await assert.rejects(inbox.reply({ id: 'request', text: 'I will try.', task: 'Build a bed' }), /transport lost/);
  const restored = await openGameChat(file, { send });
  await restored.reply({ id: 'request', text: 'I will try.' });
  assert.equal(sends, 1);
  assert.equal(restored.snapshot().uncertain.length, 1);
  assert.equal(restored.snapshot().tasks.length, 1);
  assert.match(await readFile(file, 'utf8'), /sending/);
});

test('chat waits for running skill, blocks next old controller, and releases after planning', async () => {
  const f = await fixture();
  let active = { settled: false };
  let decisions = 0;
  let activated = null;
  const loop = new ControllerLoop({
    controller: {
      current: () => ({ version: activated ?? 'old' }), inspect: () => ({ status: 'admitted' }),
      activate: async version => { activated = version; },
      decide: () => { decisions++; return { action: null, replan: true, reason: 'done' }; },
    },
    pipeline: { current: () => active }, observe: () => ({ inventory: [], entities: [], blocks: [] }),
    context: () => ({ health: 20 }),
  });
  f.bot._client.emit('player_chat', packet(f.bot, 'Build a bed'));
  await f.inbox.flush();
  await loop.tick();
  assert.equal(decisions, 0);
  assert.equal(active.settled, false, 'ingress did not cancel or replace skill');
  active = null;
  assert.equal(chatBlocksController(f.inbox, null), true);
  loop.stage({ version: 'restored-or-staged-during-reflex' });
  await loop.tick(Date.now(), { activateOnly: chatBlocksController(f.inbox, null) });
  assert.equal(activated, 'restored-or-staged-during-reflex');
  assert.deepEqual(loop.inspect().pending, [], 'chat must not deadlock the pending-activation planning gate');
  assert.equal(decisions, 0, 'activation drains without starting the old script');
  const [message] = f.inbox.snapshot().pending;
  const analysis = { chat: true };
  await f.inbox.reply({ id: message.id, text: 'I will collect wool.', task: 'Build bed' });
  assert.equal(chatBlocksController(f.inbox, analysis), true, 'old controller stays parked through current chat plan');
  assert.equal(chatBlocksController(f.inbox, null), false);
  await loop.tick();
  assert.equal(decisions, 1);
  f.detach();
});
