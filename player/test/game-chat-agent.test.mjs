import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openPlayerAgent } from '../agent.mjs';
import { openGameChat, gameChatTools, GAME_CHAT_INSTRUCTIONS } from '../game-chat.mjs';

const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

test('native Pi planner answers question, accepts task, then carries task into fresh mission after reopen', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'minecraft-chat-agent-'));
  const sent = [];
  const inbox = await openGameChat(path.join(stateDir, 'chat.json'), { send: message => sent.push(message) });
  const sender = { username: 'TestPlayer', uuid: 'human-player' };
  await inbox.receive({ id: 'question', sender, channel: 'private', text: 'Where is home?' });
  await inbox.receive({ id: 'task', sender, channel: 'public', text: 'Please build a bed.' });
  const models = createModels();
  const provider = fauxProvider({
    provider: 'openai-codex', tokensPerSecond: 1000000,
    models: ['gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id, reasoning: true, input: ['text', 'image'], contextWindow: 131072 })),
  });
  const requests = [];
  provider.setResponses([
    call('reply_to_player', { id: 'question', text: 'Home is at 168,70,-175.' }),
    call('reply_to_player', { id: 'task', text: 'I will collect wool, then craft and place a bed.', task: 'Collect matching wool; craft and place bed.' }),
    call('mission', { objective: 'Collect wool' }),
    call('mission', { objective: 'Continue accepted bed task' }),
  ].map(response => async context => {
    requests.push(structuredClone(context));
    return response;
  }));
  models.setProvider(provider.provider);
  let missions = 0;
  const tools = [...gameChatTools(inbox), {
    name: 'mission', description: 'Begin next strategic episode.',
    parameters: { type: 'object', properties: { objective: { type: 'string' } }, required: ['objective'], additionalProperties: false },
    execute: async () => ({ status: 'active', version: String(++missions) }),
  }];
  const open = () => openPlayerAgent({ stateDir, worldId: 'chat-world', models, tools, instructions: GAME_CHAT_INSTRUCTIONS });
  let agent = await open();
  try {
    const result = await agent.step({ home: { x: 168, y: 70, z: -175 }, playerChat: inbox.snapshot() });
    assert.equal(result.toolCalls, 3);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].channel, 'private');
    assert.equal(sent[1].channel, 'public');
    assert.equal(inbox.hasPending(), false);
    assert.equal(inbox.snapshot().tasks.length, 1);
    assert.match(JSON.stringify(requests[0]), /Where is home\?|Please build a bed/);
  } finally { await agent.close(); }
  agent = await open();
  try {
    await agent.step({ playerChat: inbox.snapshot() });
    assert.match(JSON.stringify(requests.at(-1)), /Collect matching wool; craft and place bed/);
    assert.equal(sent.length, 2, 'reopening and creating a fresh mission did not resend replies');
    assert.equal(missions, 2);
  } finally { await agent.close(); }
});
