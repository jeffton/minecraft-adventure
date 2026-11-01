import './compat-loader.mjs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { BOT_ROLES } from './blueprint.mjs';
import { viewerAllowed } from './viewer-policy.mjs';
import { readyScript, patchViewerClient } from './viewer-readiness.mjs';
import { patchViewerServer, viewerState, createCameraMotion } from './viewer-stream.mjs';
import { patchViewerEntities, viewerEntityModel } from './viewer-entities.mjs';
import { patchViewerHeightClient } from './viewer-height.mjs';
import { createObserver, atomicJson, getHome, OBS } from './runtime.mjs';
import { join } from 'node:path';

const extensionUrl = new URL('./extensions.mjs', import.meta.url).href;

function replaceExactly(source, oldText, newText, file) {
  const parts = source.split(oldText);
  if (parts.length !== 2) throw new Error(`Upstream integration point changed: ${file}`);
  return parts.join(newText);
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:///opt/minecraft-mindcraft/')) return result;
    let source = result.source;
    if (source == null) return result;
    source = String(source);
    if (url.endsWith('/src/agent/commands/actions.js')) {
      source += `\nimport { registerAdventure } from ${JSON.stringify(extensionUrl)};\nregisterAdventure(actionsList);\n`;

    } else if (url.endsWith('/node_modules/prismarine-viewer/lib/mineflayer.js')) {
      source = patchViewerServer(source, viewerState.toString());
      source = replaceExactly(source, "io.on('connection', (socket) => {", `io.on('connection', (socket) => {\n    const isPublic = socket.handshake.headers['x-roycraft-public-viewer'] === '1';\n    socket.data.roycraftPublic = isPublic;\n    if (!(${viewerAllowed.toString()})(isPublic, sockets.map(s => s.data.roycraftPublic))) { socket.disconnect(true); return }`, url);
    } else if (url.endsWith('/node_modules/prismarine-viewer/lib/common.js')) {
      const index = '/opt/minecraft-mindcraft/node_modules/prismarine-viewer/public/index.html';
      source = replaceExactly(source, "app.use(compression())", `app.use(compression())\n  app.get(prefix + '/', (req, res) => res.type('html').send(require('fs').readFileSync(${JSON.stringify(index)}, 'utf8').replace('<body>', '<body>' + ${JSON.stringify(readyScript)})))\n  app.get(prefix + '/index.js', (req, res) => res.type('js').send((${patchViewerHeightClient.toString()})((${patchViewerClient.toString()})((${patchViewerEntities.toString()})(require('fs').readFileSync(${JSON.stringify(index.replace('index.html', 'index.js'))}, 'utf8'), ${JSON.stringify(viewerEntityModel.toString())}), ${JSON.stringify(createCameraMotion.toString())}))))\n  app.get(prefix + '/worker.js', (req, res) => res.sendFile(${JSON.stringify(fileURLToPath(new URL('./assets/worker.js', import.meta.url)))}))`, url);
    }
    return { ...result, source };
  }
});

// Hooks must be registered before the upstream command map and API are imported.
const { Agent } = await import('/opt/minecraft-mindcraft/src/agent/agent.js');
const { ActionManager } = await import('/opt/minecraft-mindcraft/src/agent/action_manager.js');
const originalRunAction = ActionManager.prototype.runAction;
ActionManager.prototype.runAction = function (label, action, options) {
  const authored = label.startsWith('adventure:') || ['action:buildNetherPortal', 'action:enterPortal', 'action:throwEnderEye', 'action:fillEndPortal', 'action:fightEnd'].includes(label);
  if (!authored) return originalRunAction.call(this, label, action, options);
  return originalRunAction.call(this, label, async () => {
    this.agent.bot.modes.pause('unstuck');
    try { return await action(); }
    finally { this.agent.bot.modes.unpause('unstuck'); }
  }, options);
};
const { Prompter } = await import('/opt/minecraft-mindcraft/src/models/prompter.js');
const { GPT } = await import('/opt/minecraft-mindcraft/src/models/gpt.js');
const { getCommand } = await import('/opt/minecraft-mindcraft/src/agent/commands/index.js');
const programOwned = new Set();
const modelRequests = new Map();
export function setProgramMode(name, active) {
  if (!Object.hasOwn(BOT_ROLES, name)) throw new Error('Unknown adventure agent');
  if (active) programOwned.add(name);
  else programOwned.delete(name);
}
const { Examples } = await import('/opt/minecraft-mindcraft/src/utils/examples.js');
const { SkillLibrary } = await import('/opt/minecraft-mindcraft/src/agent/library/skill_library.js');
const { default: viewer } = await import('/opt/minecraft-mindcraft/node_modules/prismarine-viewer/index.js');
const { default: vec3Module } = await import('/opt/minecraft-mindcraft/node_modules/vec3/index.js');
const { Vec3 } = vec3Module;

const originalPromptConvo = Prompter.prototype.promptConvo;
Prompter.prototype.promptConvo = async function (...args) {
  const result = await originalPromptConvo.apply(this, args);
  // The HTTP response may already have arrived while its log was being saved.
  // Recheck ownership at the actual command handoff, not just request start.
  return programOwned.has(this.agent.name) ? '' : result;
};

const originalReplaceStrings = Prompter.prototype.replaceStrings;
Prompter.prototype.replaceStrings = async function (...args) {
  const prompt = await originalReplaceStrings.apply(this, args);
  return this.agent.adventureSurvey ? prompt + '\nObserved loaded surroundings: ' + JSON.stringify(this.agent.adventureSurvey) : prompt;
};

// Explicitly use the authored action catalogue rather than remote embeddings/code generation.
Prompter.prototype.initExamples = async function () {
  this.embedding_model = null;
  this.convo_examples = new Examples(null, 0);
  this.coding_examples = new Examples(null, 0);
  await this.convo_examples.load([]);
  await this.coding_examples.load([]);
  this.skill_libary = new SkillLibrary(this.agent, null);
  await this.skill_libary.initSkillLibrary();
};

GPT.prototype.sendRequest = async function (turns, systemMessage) {
  const agentName = this.params?.user;
  if (programOwned.has(agentName)) return ''; // The shared local program owns the next action.
  const controller = new AbortController();
  const requests = modelRequests.get(agentName) ?? new Set();
  requests.add(controller); modelRequests.set(agentName, requests);
  try {
    const messages = [{ role: 'system', content: systemMessage }, ...turns.map(turn => ({ role: turn.role, content: turn.content }))];
    const completion = await this.openai.chat.completions.create({
      model: 'gpt-6.1-terra', messages, user: agentName, max_tokens: 2048, stream: false
    }, { timeout: 300000, maxRetries: 0, signal: controller.signal });
    if (completion.choices[0].finish_reason !== 'stop') throw new Error(`Model response incomplete: ${completion.choices[0].finish_reason}`);
    return completion.choices[0].message.content;
  } catch (error) {
    if (controller.signal.aborted) return ''; // Deliberate supersession, not a failed inference.
    throw error;
  } finally { requests.delete(controller); }
};

const originalSetupEvents = Agent.prototype._setupEventHandlers;
Agent.prototype._setupEventHandlers = function (saved, ...args) {
  // Runtime restarts must not resurrect old peer conversations. Shared plans
  // coordinate the team; actual deliveries use authored gameplay actions.
  return originalSetupEvents.call(this, saved ? { ...saved, last_sender: null } : saved, ...args);
};

const originalHandle = Agent.prototype.handleMessage;
Agent.prototype.handleMessage = async function (source, message, ...args) {
  // Game chat is untrusted data. Only internal self-prompts and the four bot peers
  // may drive this deployment. Humans still play normally; chat is not remote code.
  if (source !== 'system' && !Object.hasOwn(BOT_ROLES, source)) return false;
  return originalHandle.call(this, source, message, ...args);
};

export function sceneSnapshot(agent) {
  const bot = agent.bot;
  const home = getHome();
  const center = home && home.dimension === bot.game.dimension ? new Vec3(home.x + 3, home.y, home.z + 4) : bot.entity.position.floored();
  const voxels = [];
  const palette = [];
  const ids = new Map();
  for (let x = center.x - 24; x <= center.x + 24; x++) {
    for (let z = center.z - 24; z <= center.z + 24; z++) {
      for (let y = center.y + 18; y >= center.y - 10; y--) {
        const pos = new Vec3(x, y, z);
        const block = bot.blockAt(pos);
        if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
        if (!['water', 'lava'].includes(block.name) && block.boundingBox === 'empty') continue;
        const visible = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
          .some(delta => bot.blockAt(pos.plus(delta))?.boundingBox === 'empty');
        if (!visible) continue;
        if (!ids.has(block.name)) { ids.set(block.name, palette.length); palette.push(block.name); }
        voxels.push([x, y, z, ids.get(block.name)]);
      }
    }
  }
  atomicJson(join(OBS, 'scene.json'), {
    updatedAt: new Date().toISOString(), source: 'Mineflayer received world chunks', clientVersion: bot.version,
    dimension: bot.game.dimension, center: { x: center.x, y: center.y, z: center.z }, radius: 24, palette, voxels,
    entities: Object.values(bot.entities).filter(entity => entity.position && entity.position.distanceTo(center) < 40)
      .map(entity => ({ name: entity.username ?? entity.name ?? entity.type, x: entity.position.x, y: entity.position.y, z: entity.position.z }))
  });
}

const originalStartEvents = Agent.prototype.startEvents;
Agent.prototype.startEvents = function (...args) {
  originalStartEvents.apply(this, args);
  if (this.bot.game.gameMode !== 'survival') throw new Error('Adventure bots require survival mode');
  this.bot.modes.setOn('cheat', false);
  // Natural regeneration requires at least 18 food. Waiting until 14 leaves
  // wounded bots carrying food without ever starting to heal.
  this.bot.autoEat.options.startAt = 19;
  this.adventure = createObserver(this, {
    programMode: active => setProgramMode(this.name, active),
    cancelChat: () => { for (const request of modelRequests.get(this.name) ?? []) request.abort(); },
    runProgram: () => getCommand('!runProgram').perform(this)
  });
  const dig = this.bot.dig.bind(this.bot);
  this.bot.dig = async (block, ...digArgs) => {
    const home = getHome();
    if (!this.adventureBuilding && home && home.dimension === this.bot.game.dimension &&
        block.position.x >= home.x - 2 && block.position.x <= home.x + 8 &&
        block.position.z >= home.z - 3 && block.position.z <= home.z + 10 && block.position.y >= home.y - 2) {
      return Promise.reject(new Error('Reserved home footprint: harvesting is prohibited'));
    }
    const material = block.name;
    const position = block.position.clone();
    const result = await dig(block, ...digArgs);
    this.adventure.emit('gather', `Mined ${material} at ${position}.`);
    return result;
  };
  this.bot.adventureAction = () => this.actions.currentActionLabel || (this.adventureThinking ? 'planning' : 'idle');
  viewer.mineflayer(this.bot, { port: 8931 + Object.keys(BOT_ROLES).indexOf(this.name), viewDistance: 4, firstPerson: true });
  if (this.name === 'Roy') {
    const timer = setInterval(() => {
      try { sceneSnapshot(this); } catch (error) { this.adventure.recordError(error); }
    }, 30000);
    this.bot.once('end', () => clearInterval(timer));
    sceneSnapshot(this);
  }
};
