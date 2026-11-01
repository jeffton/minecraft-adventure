import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_ROLES, INITIAL_TASKS, missionPrompt, validateMission } from './blueprint.mjs';

export const ROOT = process.env.ADVENTURE_ROOT ?? '/var/lib/minecraft-adventure';
export const OBS = join(ROOT, 'observations');
export const CONTROL = join(ROOT, 'control');
export const NAMES = Object.keys(BOT_ROLES);

export function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o640 });
  renameSync(temp, path);
}

export function readJson(path, maxBytes = 65536) {
  const data = readFileSync(path);
  if (data.length > maxBytes) throw new Error(`${path}: maximum ${maxBytes} bytes exceeded`);
  return JSON.parse(data.toString('utf8'));
}

export function getHome() {
  const path = join(CONTROL, 'home.json');
  return existsSync(path) ? readJson(path) : null;
}

export function getMission() {
  const path = join(CONTROL, 'mission.json');
  return existsSync(path) ? validateMission(readJson(path)) : null;
}

export function surveySurroundings(bot) {
  const position = bot.entity.position;
  const names = Object.keys(bot.registry.blocksByName);
  const nearbyResources = { loadedChunksOnly: true, range: 96 };
  for (const [kind, filter] of Object.entries({
    wood: name => name.endsWith('_log') || name.endsWith('_stem'),
    coal: name => name === 'coal_ore' || name === 'deepslate_coal_ore',
    iron: name => name === 'iron_ore' || name === 'deepslate_iron_ore'
  })) {
    const ids = names.filter(filter).map(name => bot.registry.blocksByName[name].id);
    nearbyResources[kind] = bot.findBlocks({ matching: ids, maxDistance: 96, count: 3 }).map(p => ({
      name: bot.blockAt(p).name, x: p.x, y: p.y, z: p.z, distance: Math.round(p.distanceTo(position))
    }));
  }
  nearbyResources.food = Object.values(bot.entities)
    .filter(entity => ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].includes(entity.name) && entity.position?.distanceTo(position) <= 96)
    .sort((a, b) => a.position.distanceTo(position) - b.position.distanceTo(position)).slice(0, 4)
    .map(entity => ({ name: entity.name, x: entity.position.x, y: entity.position.y, z: entity.position.z }));
  const terrain = [];
  for (const [heading, dx, dz] of [['north', 0, -1], ['east', 1, 0], ['south', 0, 1], ['west', -1, 0],
    ['northeast', 1, -1], ['southeast', 1, 1], ['southwest', -1, 1], ['northwest', -1, -1]]) {
    for (const distance of [12, 24, 48]) {
      const x = Math.floor(position.x + dx * distance);
      const z = Math.floor(position.z + dz * distance);
      for (let y = Math.floor(position.y + 20); y >= position.y - 40; y--) {
        const p = position.offset(x - position.x, y - position.y, z - position.z);
        const block = bot.blockAt(p);
        if (block?.boundingBox === 'block' && bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty') {
          terrain.push({ heading, distance, x, y: y + 1, z, block: block.name, elevationChange: Math.round(y + 1 - position.y) });
          break;
        }
      }
    }
  }
  const biomeId = bot.world.getBiome(position);
  return { nearbyResources, terrain, biome: bot.registry.biomes[biomeId]?.name ?? null };
}

export function createObserver(agent, controls = {}) {
  mkdirSync(OBS, { recursive: true });
  const events = [];
  let lastMissionId;
  let lastSurvey = 0;
  let error = null;
  let errorCount = 0;
  let programRunning = false;
  let repairRunning = false;
  let programId = null;
  let programFailed = false;
  let finishedAt = 0;
  let programMessage = '';
  const emit = (type, message) => {
    if (type === 'error') { errorCount++; error = String(message); }
    events.push({ at: new Date().toISOString(), bot: agent.name, type, message: String(message).slice(0, 1200) });
    if (events.length > 60) events.shift();
  };
  const recordError = e => { error = String(e.message ?? e); emit('error', error); console.error(`[${agent.name}]`, e); };
  const bot = agent.bot;
  let physicsTicks = 0;
  let serverCorrections = 0;
  bot.on('physicsTick', () => { physicsTicks++; });
  bot.on('forcedMove', () => { serverCorrections++; });
  bot.on('death', () => emit('death', 'Died in survival; items remain in the world.'));
  bot.on('respawn', () => emit('respawn', 'Respawned.'));
  bot.on('entityDead', entity => {
    if (entity.name === 'ender_dragon' && String(bot.game.dimension).includes('end')) {
      atomicJson(join(CONTROL, 'dragon-defeated.json'), { at: new Date().toISOString(), source: 'observed entityDead', entityId: entity.id, dimension: bot.game.dimension });
      emit('milestone', 'Observed the Ender Dragon die in the End.');
    }
  });
  bot.on('blockPlaced', block => emit('build', `Placed ${block.name} at ${block.position}`));
  bot.on('error', recordError);
  bot.on('kicked', reason => emit('disconnected', JSON.stringify(reason)));
  bot.on('end', reason => {
    emit('disconnected', reason);
    atomicJson(join(OBS, `${agent.name}.json`), { name: agent.name, status: 'offline', updatedAt: new Date().toISOString(), error: String(reason), events });
  });

  function missionUpdate() {
    try {
      const mission = getMission();
      const home = getHome();
      const id = `${mission?.id ?? 'initial'}:${home ? `${home.x},${home.z}` : 'unsettled'}`;
      if (lastMissionId !== id) {
        lastMissionId = id;
        const prompt = missionPrompt(agent.name, mission, home);
        agent.self_prompter.prompt = prompt;
        emit('mission', mission?.bots[agent.name].task ?? INITIAL_TASKS[agent.name]);
      }
      if (mission?.bots[agent.name].program?.length && controls.runProgram) {
        controls.programMode(!repairRunning);
        if (!agent.self_prompter.isStopped()) {
          agent.self_prompter.stop(false);
          controls.cancelChat();
        }
        if (!programRunning && !repairRunning && programId !== mission.id && agent.isIdle()) {
          programId = mission.id;
          programRunning = true;
          const errorsBefore = errorCount;
          Promise.resolve(controls.runProgram()).then(message => {
            programMessage = String(message);
            programFailed = errorCount !== errorsBefore || bot.interrupt_code;
            emit('program_result', programMessage);
          }).catch(e => { programFailed = true; recordError(e); }).finally(() => {
            programRunning = false; finishedAt = Date.now();
          });
        } else if (programFailed && !programRunning && !repairRunning && Date.now() - finishedAt >= 45000 && agent.isIdle()) {
          repairRunning = true;
          agent.adventureThinking = true;
          controls.programMode(false);
          agent.handleMessage('system', `Shared program is blocked: ${programMessage}. Choose ONE useful authored command to resolve the concrete prerequisite. If wood is absent, use !scoutForResource("wood", 96). Do not negotiate for items peers do not have.`, 1)
            .catch(recordError).finally(() => {
              repairRunning = false; agent.adventureThinking = false;
              controls.programMode(true); programId = null;
            });
        }
        return;
      }
      controls.programMode?.(false);
      if (agent.self_prompter.isStopped()) agent.self_prompter.start(agent.self_prompter.prompt);
    } catch (e) { recordError(e); }
  }

  function publish() {
    try {
      const p = bot.entity.position;
      const mission = getMission();
      if (Date.now() - lastSurvey >= 30000) {
        agent.adventureSurvey = surveySurroundings(bot);
        lastSurvey = Date.now();
      }
      const state = {
        name: agent.name,
        role: BOT_ROLES[agent.name],
        status: bot._client.state === 'play' ? 'online' : bot._client.state,
        updatedAt: new Date().toISOString(),
        health: bot.health,
        food: bot.food,
        position: { x: p.x, y: p.y, z: p.z },
        dimension: bot.game.dimension,
        task: agent.actions.currentActionLabel || (agent.adventureThinking || agent.self_prompter.isActive() ? 'planning' : 'waiting for shared plan'),
        shortPlan: mission?.bots[agent.name].task ?? INITIAL_TASKS[agent.name],
        ...agent.adventureSurvey,
        navigation: {
          moving: bot.pathfinder.isMoving(), mining: bot.pathfinder.isMining(), building: bot.pathfinder.isBuilding(),
          onGround: bot.entity.onGround, horizontalCollision: bot.entity.isCollidedHorizontally,
          verticalCollision: bot.entity.isCollidedVertically, physicsEnabled: bot.physicsEnabled, physicsTicks, serverCorrections,
          localBlocks: [-1, 0, 1].map(dy => {
            const block = bot.blockAt(p.offset(0, dy, 0));
            return block ? { dy, name: block.name, stateId: block.stateId, shapes: block.shapes } : { dy, name: null };
          }),
          velocity: { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z },
          controls: Object.fromEntries(['forward', 'back', 'jump', 'sneak', 'sprint'].map(key => [key, bot.getControlState(key)])),
          digging: bot.targetDigBlock ? { name: bot.targetDigBlock.name, position: bot.targetDigBlock.position } : null
        },
        inventory: bot.inventory.items().map(item => ({ name: item.name, count: item.count })),
        events,
        error
      };
      atomicJson(join(OBS, `${agent.name}.json`), state);
    } catch (e) { recordError(e); }
  }

  missionUpdate(); publish();
  const missionTimer = setInterval(missionUpdate, 15000);
  const timer = setInterval(publish, 5000);
  bot.once('end', () => { clearInterval(timer); clearInterval(missionTimer); });
  return { emit, recordError, publish };
}

export function aggregateState() {
  mkdirSync(OBS, { recursive: true });
  const now = Date.now();
  const mission = getMission();
  const bots = NAMES.map(name => {
    const file = join(OBS, `${name}.json`);
    const empty = { name, role: BOT_ROLES[name], status: 'starting', task: 'Connecting', health: null, food: null, position: null, dimension: null, inventory: [], events: [] };
    if (!existsSync(file)) return empty;
    const state = { ...empty, ...readJson(file, 131072) };
    if (now - Date.parse(state.updatedAt) > 30000) state.status = 'offline';
    if (state.status !== 'online') {
      state.health = null;
      state.food = null;
      state.inventory = [];
      state.task = state.status === 'offline' ? 'Disconnected' : 'Connecting';
    }
    return state;
  });
  const inventoryHas = item => bots.some(bot => bot.status === 'online' && bot.inventory.some(stack => stack.name === item));
  const home = getHome();
  const milestones = [
    { id: 'settled', label: 'Choose a shared home', completed: Boolean(home) },
    { id: 'stone', label: 'Craft stone tools', completed: inventoryHas('stone_pickaxe') || inventoryHas('iron_pickaxe') },
    { id: 'iron', label: 'Forge iron equipment', completed: inventoryHas('iron_pickaxe') },
    { id: 'lodge', label: 'Finish the timber lodge', completed: existsSync(join(CONTROL, 'lodge-complete.json')) },
    { id: 'nether', label: 'Explore the Nether', completed: bots.some(bot => bot.status === 'online' && String(bot.dimension).includes('nether')) },
    { id: 'eyes', label: 'Prepare Eyes of Ender', completed: inventoryHas('ender_eye') },
    { id: 'dragon', label: 'Defeat the Ender Dragon', completed: existsSync(join(CONTROL, 'dragon-defeated.json')) }
  ];
  const events = bots.flatMap(bot => bot.events ?? []).sort((a, b) => a.at.localeCompare(b.at)).slice(-100);
  atomicJson(join(OBS, 'state.json'), {
    updatedAt: new Date().toISOString(),
    serverVersion: 'Paper 26.3 (ViaBackwards client 1.21.4)',
    longTerm: 'Build a beautiful shared survival home, establish renewable supplies, explore the Nether and defeat the Ender Dragon.',
    phase: mission?.phase ?? 'settling',
    objective: mission?.objective ?? 'Secure food, tools and build a shared timber lodge',
    home, bots, milestones, events,
    capabilities: { survival: true, cooperativeBuilding: true, generatedCode: false,
      dragon: 'Dragon victory is an expedition objective, not a guaranteed solved controller.' }
  });
}
