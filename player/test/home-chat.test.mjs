import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openPlayerAgent } from '../agent.mjs';
import { openPlanningMemory, planningMemoryTools } from '../planning-memory.mjs';
import { openGameChat, attachGameChat, gameChatTools, GAME_CHAT_INSTRUCTIONS } from '../game-chat.mjs';
import { planningObservation } from '../mission.mjs';

const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('human protocol chat reaches planner, updates reported home supplies, and later stock question receives an explicitly reported answer', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'home-chat-'));
  const memory = await openPlanningMemory(path.join(stateDir, 'notes.json'));
  await memory.selectHome({ dimension: 'overworld', position: { x: 5, y: 65, z: 9 }, reason: 'My base' });
  const sent = [];
  const inbox = await openGameChat(path.join(stateDir, 'chat.json'), { send: message => sent.push(message) });
  const human = { username: 'TestPlayer', uuid: 'human' };
  const bot = { _client: new EventEmitter(), username: 'Roy', player: { uuid: 'roy' }, players: { TestPlayer: human }, registry: { chatFormattingById: { 0: { name: 'minecraft:chat' } } } };
  const detach = attachGameChat(bot, inbox, { componentText: value => value, onError: error => { throw error; } });
  const packet = text => ({ senderUuid: 'human', type: 0, plainMessage: text, timestamp: 10n, salt: 1n, index: 1 });
  bot._client.emit('player_chat', packet('I put 12 iron ingots in the home chest.'));
  await inbox.flush();
  const report = inbox.snapshot().pending[0];
  const knowledge = { facilities: [{ name: 'chest', contents: { iron_ingot: 12 }, source: 'player-reported, unverified', sender: report.sender, messageId: report.id, reportedAt: report.receivedAt }] };
  const models = createModels();
  const provider = fauxProvider({ provider: 'openai-codex', tokensPerSecond: 1000000, models: ['gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id, reasoning: true, input: ['text'], contextWindow: 131072 })) });
  const requests = [];
  provider.setResponses([
    call('remember_home', { knowledge }),
    call('reply_to_player', { id: report.id, text: 'Noted: you report 12 iron ingots in the home chest.' }),
    fauxAssistantMessage('Continue the current mission.'),
    async context => {
      const payload = JSON.parse(context.messages.filter(message => message.role === 'user').at(-1).content).observation;
      assert.deepEqual(payload.homeState.knowledge, knowledge);
      return call('reply_to_player', { id: inbox.snapshot().pending[0].id, text: 'You reported 12 iron ingots at home; I have not checked them.' });
    },
    fauxAssistantMessage('Continue.'),
  ].map(response => async context => {
    requests.push(structuredClone(context));
    return typeof response === 'function' ? response(context) : response;
  }));
  models.setProvider(provider.provider);
  const agent = await openPlayerAgent({ stateDir, worldId: 'home-chat', models, tools: [...planningMemoryTools(memory), ...gameChatTools(inbox)], instructions: GAME_CHAT_INSTRUCTIONS });
  const observation = () => planningObservation({ notes: memory.notes, home: memory.home, playerChat: inbox.snapshot() });
  try {
    await agent.step(observation());
    assert.match(JSON.stringify(requests[0]), /I put 12 iron ingots/);
    assert.match(JSON.stringify(requests[0]), /player-reported\/unverified source/);
    assert.deepEqual((await openPlanningMemory(path.join(stateDir, 'notes.json'))).homeState.knowledge, knowledge);
    bot._client.emit('player_chat', packet('What supplies are in the chest at home?'));
    await inbox.flush();
    await agent.step(observation());
    assert.equal(sent.length, 2);
    assert.match(sent[1].response, /reported 12 iron.*not checked/);
    assert.equal(inbox.hasPending(), false);
  } finally { detach(); await agent.close(); }
});
