import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOT_ROLES } from './blueprint.mjs';
import { aggregateState } from './runtime.mjs';
import { botWorldConfig } from '../planner/world-scope.mjs';
import * as Mindcraft from '/opt/minecraft-mindcraft/src/mindcraft/mindcraft.js';
import defaults from '/opt/minecraft-mindcraft/settings.js';

if (process.getuid() === 0) throw new Error('Run the bots as minecraft-bots, never root');
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY must contain the private local-relay bearer token');
if (!process.env.NODE_OPTIONS?.includes('bootstrap.mjs')) throw new Error('NODE_OPTIONS must preload the adventure bootstrap');

await botWorldConfig(process.env);
const data = process.env.BOT_DATA_DIR ?? '/var/lib/minecraft-adventure/bots';
mkdirSync(data, { recursive: true });
process.chdir(data);
if (!existsSync('src')) symlinkSync('/opt/minecraft-mindcraft/src', 'src');
mkdirSync('bots', { recursive: true });

const conversation = `You are $NAME, one of four cooperative Minecraft survival agents. Act, do not roleplay progress. Select ONE concrete command each response and use only documented commands. Keep prose under one sentence.\n$SELF_PROMPT\n$STATS\n$INVENTORY\n$MEMORY\n$COMMAND_DOCS\nRecent conversation: $CONVO\nPrioritize food, tools, safety, useful gathering and shared construction. No creative mode, cheats, arbitrary code or server commands. Ask another bot only for a concrete resource or coordination decision; avoid social conversation loops. When a command fails, inspect its concrete error and choose a different useful action. Building utilities and materials must be earned. Roy alone owns !buildLodge. Never attack human players or harvest the reserved home. Full Ender Dragon victory requires actual preparation and observed kill; do not claim success merely because the goal mentions it.`;

await Mindcraft.init(false, 8930, false);
for (const [name, role] of Object.entries(BOT_ROLES)) {
  const settings = {
    ...defaults,
    host: '127.0.0.1', port: 25567, minecraft_version: '1.21.4', auth: 'offline',
    mindserver_port: 8930, auto_open_ui: false, base_profile: 'survival', load_memory: true,
    init_message: null, render_bot_view: false, allow_vision: false, allow_insecure_coding: false,
    speak: false, language: 'en', chat_ingame: false, chat_bot_messages: false,
    only_chat_with: [], num_examples: 0, max_messages: 16, max_commands: 1,
    block_place_delay: 250, spawn_timeout: 60,
    blocked_actions: ['!newAction', '!setMode', '!attackPlayer', '!restart', '!stfu', '!endGoal', '!startConversation', '!endConversation'],
    profile: {
      name, role, cooldown: 20000, conversing: conversation,
      model: { api: 'openai', model: 'gpt-6.1-terra', url: 'http://127.0.0.1:8766/v1', params: { user: name } },
      modes: { self_preservation: true, unstuck: true, cowardice: true, self_defense: true,
        hunting: false, item_collecting: true, torch_placing: true, elbow_room: false, idle_staring: false, cheat: false }
    }
  };
  const result = await Mindcraft.createAgent(settings);
  if (!result.success) throw new Error(`Cannot create ${name}: ${result.error}`);
}

function publish() {
  try { aggregateState(); }
  catch (error) { console.error('Cannot publish adventure state:', error); }
}
publish();
setInterval(publish, 10000);
process.on('SIGTERM', () => Mindcraft.shutdown());
process.on('SIGINT', () => Mindcraft.shutdown());
