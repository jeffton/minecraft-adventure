import { trackViewerLightColumns } from './viewer.mjs';
import { startPlayerLifecycle } from './lifecycle.mjs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openPlayerAgent } from './agent.mjs';
import { BackgroundAgent } from './background-agent.mjs';
import { SkillSandbox } from './sandbox.mjs';
import { createMinecraftRpc, RPC_DESCRIPTION } from './rpc.mjs';
import { SkillLibrary } from './skills.mjs';
import { atomicJson, optionalJson, playerState, skillEvidence } from './observations.mjs';
import { installReflexes, nearbyThreats } from './reflexes.mjs';
import { ActionPipeline } from './pipeline.mjs';
import { PersistentController } from './controller.mjs';
import { ControllerLoop } from './controller-loop.mjs';
import { createWorldKnowledge } from './world-knowledge.mjs';
import { actionFeedback, observationFeedback } from './feedback.mjs';
import { VisionLoop } from './vision-loop.mjs';
import { ProgressHistory } from './progress.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const viewer = require('prismarine-viewer');

const OBJECT = properties => ({ type: 'object', properties, additionalProperties: false });
const STRING = { type: 'string' };
const INTEGER = { type: 'integer' };

export async function runPlayer(env = process.env) {
  if (process.getuid() === 0) throw new Error('The Minecraft player must never run as root');
  const worldId = env.PLAYER_WORLD_ID;
  if (!worldId || !/^[a-z0-9-]+$/.test(worldId)) throw new Error('PLAYER_WORLD_ID must identify the fresh world');
  const stateDir = path.join(env.PLAYER_STATE_DIR ?? '/var/lib/minecraft-player', worldId);
  const observationFile = env.PLAYER_OBSERVATION_FILE ?? '/var/lib/minecraft-adventure/observations/state.json';
  const token = env.PLANNER_RELAY_TOKEN;
  if (!token || token.length < 24) throw new Error('Missing diary relay credential');
  const lifecycle = await startPlayerLifecycle({ worldId });
  const { signal } = lifecycle;
  const cleanup = [];
  let stopActions;
  let stopRuntime;
  let flushProgress;
  try {
    signal.throwIfAborted();
    await mkdir(stateDir, { recursive: true });
    const gameplayLedger = path.join(path.dirname(observationFile), `gameplay-${worldId}.jsonl`);
    await appendFile(gameplayLedger, '', { mode: 0o640 });
    const GAMEPLAY = new Set(['spawn', 'respawn', 'gather', 'build', 'craft', 'eat', 'death', 'delivery', 'milestone', 'action', 'reflex', 'error']);
    const session = randomUUID();
    let sequence = 0;
    const events = [];
    const notesFile = path.join(stateDir, 'notes.json');
    let notes = await optionalJson(notesFile, {});
    const progressFile = path.join(stateDir, 'progress.json');
    const progress = new ProgressHistory(await optionalJson(progressFile, undefined));
    let progressWrite = Promise.resolve();
    flushProgress = () => progressWrite;
    const saveProgress = () => {
      const snapshot = structuredClone(progress.state);
      progressWrite = progressWrite.then(() => atomicJson(progressFile, snapshot));
      return progressWrite.catch(fail);
    };
    let life = 0;
    let reflexOwner = null;
    let thinking = false;
    let error = null;
    let stopping = false;
    stopRuntime = () => { stopping = true; };
    signal.addEventListener('abort', () => { stopping = true; }, { once: true });
    let visionError = null;
    const metrics = { startedAt: new Date().toISOString(), actionActiveMs: 0, withoutActionMs: 0, longestWithoutActionMs: 0, planningDuringActionMs: 0, modelMs: 0, modelRuns: 0 };
    let previousHeartbeat = Date.now();
    let idleSince = Date.now();
    const emit = (type, message, data = {}) => {
      const event = { session, sequence: ++sequence, worldId, at: new Date().toISOString(), bot: 'Roy', type, message: String(message).slice(0, 2000), data };
      events.push(event);
      if (events.length > 100) events.shift();
      console.log(JSON.stringify(event));
      void appendFile(path.join(stateDir, 'events.jsonl'), JSON.stringify(event) + '\n').catch(fail);
      if (GAMEPLAY.has(type)) void appendFile(gameplayLedger, JSON.stringify(event) + '\n').catch(fail);
    };
    const fail = failure => { error = failure.message; console.error(failure); };
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25567, username: 'Roy', auth: 'offline', version: '1.21.4', viewDistance: 'short' });
    cleanup.push(async () => { stopping = true; bot.quit(); });
    signal.throwIfAborted();
    trackViewerLightColumns(bot);
    bot.loadPlugin(pathfinder);
    bot.on('error', fail);
    bot.on('kicked', reason => { emit('error', `Disconnected: ${JSON.stringify(reason)}`); });
    bot.on('end', () => { if (!stopping) { console.error('Minecraft connection ended; restarting player'); process.exit(1); } });
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      const spawn = () => { signal.removeEventListener('abort', abort); resolve(); };
      signal.addEventListener('abort', abort, { once: true });
      bot.once('spawn', spawn);
      bot.once('error', reject);
      bot.once('end', () => reject(new Error('Minecraft ended before spawn')));
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    if (bot.game.gameMode !== 'survival') throw new Error('Player requires survival mode');
    const movements = new Movements(bot);
    movements.allow1by1towers = false;
    movements.canDig = false;
    movements.allowSprinting = false;
    movements.allowParkour = false;
    movements.maxDropDown = 3;
    movements.infiniteLiquidDropdownDistance = false;
    movements.scafoldingBlocks = [];
    bot.pathfinder.setMovements(movements);
    const knowledge = await createWorldKnowledge({ directory: stateDir, worldId });
    const rpc = createMinecraftRpc(bot, { Vec3, goals, knowledge, onEvent: event => {
      emit('minecraft_rpc', event.method ?? event.type, { method: event.method });
      if (event.type === 'block-mined') {
        emit('gather', `Mined ${event.block.name} at ${JSON.stringify(event.block.position)}.`, { material: event.block.name, position: event.block.position, verified: true });
      }
      if (event.method === 'placeBlock' && event.result && !['air', 'cave_air', 'void_air'].includes(event.result.name)) {
        emit('build', `Placed ${event.result.name} at ${JSON.stringify(event.result.position)}.`, { material: event.result.name, position: event.result.position, verified: true });
        progress.placed();
        void saveProgress();
      }
    } });
    const sandbox = new SkillSandbox({ rpc, onEvent: event => {
      if (event.type === 'action-end') {
        const result = event.action;
        const effects = result.before && result.after ? skillEvidence(result.before, result.after) : null;
        progress.completed(result);
        void saveProgress();
        emit('action', `${result.name}: ${result.state}${result.error ? ': ' + result.error.split('\n')[0] : ''}. Observed changes: ${JSON.stringify(effects)}`, { actionId: result.id, skillName: result.name, state: result.state, verified: Boolean(effects && (Object.keys(effects.inventoryDelta).length || effects.foodDelta)), effects });
        pipeline.completed(result);
      } else if (event.type === 'rpc-result') {
        emit('rpc', `${event.actionName}: ${event.call.method}: ${event.call.error?.split('\n')[0] ?? 'returned'}`, { actionId: event.actionId, skillName: event.actionName, method: event.call.method, error: event.call.error });
      }
    } });
    const pipeline = new ActionPipeline({ sandbox, worldId, context: () => ({ session, life, reflexOwner, stopping, health: bot.health }), onEvent: emit });
    const action = () => pipeline.current();
    const label = () => {
      if (reflexOwner) return reflexOwner;
      const current = action();
      return current?.state === 'running' ? current.name : null;
    };
    const state = () => ({ ...playerState(bot, { worldId, session, events, action: label(), thinking, error: error ?? visionError, life, notes }), gameplayLedger: true, actionId: pipeline.latestId, nextSkill: pipeline.next?.name ?? null });
    let controllerLoop;
    const interrupt = async reason => {
      controllerLoop?.invalidate(reason);
      pipeline.clear();
      if (pipeline.latestId) {
        sandbox.cancel(pipeline.latestId);
        await sandbox.wait(pipeline.latestId);
      }
      rpc.cancel();
      await rpc.waitForIdle();
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      emit('interrupted', reason);
    };
    bot.adventureAction = () => label() ?? (thinking ? 'planning' : 'observing');
    stopActions = () => interrupt('player shutdown');
    lifecycle.details(() => ({
      online: !bot._client.ended, thinking, action: actionFeedback(action()), error: error ?? visionError,
      controller: controllerLoop ? { version: controller.current()?.version, ...controllerLoop.inspect() } : null,
    }));
    viewer.mineflayer(bot, { port: 8931, viewDistance: 4, firstPerson: true });
    cleanup.push(async () => { bot.viewer.close(); });
    bot.on('death', () => { life++; progress.died(); void saveProgress(); emit('death', 'Died; inventory and location must be observed again.'); void interrupt('death').catch(fail); });
    bot.on('respawn', () => { emit('respawn', 'Respawned in the current world.'); });
    const stopReflexes = installReflexes(bot, {
      acquire: async reason => { reflexOwner = reason; await interrupt(reason); },
      release: () => { reflexOwner = null; },
      goals, emit, onError: fail,
    });
    cleanup.push(async () => { stopReflexes(); });
    const skillsDir = env.PLAYER_SKILL_DIR ?? '/var/lib/minecraft-player/skills';
    await mkdir(skillsDir, { recursive: true });
    const skills = new SkillLibrary({ directory: skillsDir });
    const controller = new PersistentController({
      directory: path.join(stateDir, 'controllers'), worldId,
      isActionActive: () => Boolean(sandbox.activeId) || Boolean(reflexOwner),
      onEvent: event => emit('controller', event.type ?? 'Controller event', event),
    });
    await controller.open();
    controllerLoop = new ControllerLoop({
      controller, pipeline, observe: () => rpc.observe(),
      context: () => ({ worldId, session, life, reflexOwner, stopping, health: bot.health }),
      onEvent: (type, message, data) => {
        if (type === 'controller_action') error = null;
        emit(type, message, data);
      },
    });
    for (const candidate of controller.inspect().versions.filter(record => ['candidate', 'validated'].includes(record.status))) {
      controllerLoop.stage(candidate);
    }
    cleanup.push(async () => { await knowledge.flush(); });
    const controllerFeedback = version => {
      if (version) {
        const { fixtures, ...record } = controller.inspect(version);
        return record;
      }
      const view = controller.inspect();
      const active = controller.current();
      return {
        worldId, active: active && { version: active.version, name: active.name, code: active.code },
        state: view.state, error: view.error, lastDecision: view.lastDecision,
        versions: view.versions.slice(-5).map(({ version, name, status, error, validation }) => ({ version, name, status, error, validation })),
      };
    };
    const tool = (name, description, properties, required, execute) => ({ name, description, parameters: { ...OBJECT(properties), required }, execute });
    const tools = [
      tool('observe', 'Read current server-backed state and loaded surroundings. Use after failure/death; inventory is authoritative.', {}, [], async () => ({ worldId, session, life, reflexOwner, ...observationFeedback(rpc.observe()), threats: nearbyThreats(bot).map(e => ({ id: e.id, name: e.name, position: e.position })), notes, progress: progress.observation(), lastEvents: events.slice(-15), action: actionFeedback(action()) })),
      tool('controller_inspect', 'Read the active persistent controller, durable state, candidate source and validation results. Inspect before improving it.', { version: STRING }, [], async ({ version }) => ({ controller: controllerFeedback(version), scheduler: controllerLoop.inspect() })),
      tool('controller_candidate', 'Save a complete controller ES module and 2–8 offline fixtures. Host tests and activates it between actions; this call does not control Minecraft or prove success. Each fixture is {observation:{worldId,...},state,lastResult}. Return ends this model turn so local play continues.', { name: STRING, code: STRING, fixtures: { type: 'array', items: { type: 'object' }, minItems: 2, maxItems: 8 } }, ['name', 'code', 'fixtures'], async args => {
        const observation = controllerLoop.snapshot();
        const fixtures = [...args.fixtures.slice(0, 6),
          { observation, state: controller.inspect().state },
          { observation: { ...observation, life: life + 1, inventory: [], heldItem: null }, state: {} },
        ];
        const record = await controller.candidate({ ...args, fixtures });
        return controllerLoop.stage(record);
      }),
      tool('remember', 'Store current-world planning notes, including goal, home coordinates/dimension, discoveries and failure lessons. Not proof of completion.', { notes: { type: 'object' } }, ['notes'], async ({ notes: next }) => { notes = next; await atomicJson(notesFile, notes); return notes; }),
      tool('skills', 'List reusable JavaScript skills, fetch one by name, save source, or verify it against a completed action and explicit expected postconditions. Source is reusable; evidence is world-scoped, not current inventory. expected supports inventory minimum counts, inventoryDelta minimum increases, position {x,y,z,within}, health {min}, blocks [{x,y,z,name}]. Verification requires host-observed change, not returned claims.', { name: STRING, description: STRING, code: STRING, actionId: STRING, expected: { type: 'object' } }, [], async args => {
        if (!args.name) return skills.list();
        if (args.code) await skills.save({ name: args.name, description: args.description ?? '', code: args.code });
        if (args.actionId) return skills.verify(args.name, { worldId, action: sandbox.status(args.actionId), expected: args.expected });
        return skills.get(args.name);
      }),
    ];
    const instructions = `You maintain Roy's persistent Minecraft player controller. You are NOT the realtime player. The controller continues observing, choosing and executing locally while you improve it in the background. Preserve Roy's goals: survive, food/tools, attractive practical home with storage and bed, exploration and eventual dragon.
Use controller_candidate to submit a complete ES module exporting async function decide(observation,state,lastResult). It receives fresh authoritative observations, durable world-scoped state and the last host action outcome. Return {state,action:{name,code,input}} for one useful bounded skill, or {state,action:null,reason,wakeAfterMs}. Code bodies get mc.call, mc.observe, input; controller decisions have no mc or external I/O. Retain actionable goals, exploration frontiers, resource dependencies and failure lessons in state. Select actions by consulting those goals/dependencies/sites; writing goal strings that never affect control flow is not planning. Never reset persistent goals, learned routes or frontiers when life changes; invalidate only transient equipment/action/entity assumptions and reobserve inventory. Do not put large immutable code strings in state. Use local feedback and bounded loops, not a fixed list exhausted after a few turns. New candidate is tested offline and activated only between actions. A candidate admission is not activation or gameplay success; inspect feedback.
Provide 2–6 representative fixtures {observation,state,lastResult}, including a selected bed goal with missing wool and a known plains site, another resource goal such as iron pickaxe, and actual read-only query-result shapes. The same controller must choose different dependency/resource routes for different goals, not always timber scouting. Also test death preserving goals and a failed route selecting a different frontier. Fixtures execute controller decisions only; do not pretend they verify action effects. Never use waits or repeated scans as fabricated progress. Useful idle is allowed with explicit reason, but unknown resources require purposeful exploration or a different achievable subgoal. Plan dependencies spatially: recipe → actual missing materials → plausible sources/biomes → observed routes and exploration frontiers. Wool/sheep/plains and iron/stone/caves are examples of reasoning, not fixed scripts. Biome registry is semantic knowledge, NOT locations; unknown terrain coordinates must be explored physically. Preserve long-term goals while repairing local failure. Repeated navigation failure calls for a changed route or objective; do not repeat the same unreachable destination.
Controller action results include value (your structured query/result), verified effects and errors. Controller state is capped at 8 KiB; total decision input is 16 KiB, so use compact summaries and bounded query results (not copies of full observations). Query registryInfo, recipesAll, biomeAt and knownLocations inside bounded skill actions to obtain semantic/observed world knowledge, then incorporate it in the next local decision. Use skills for reusable source; embed fetched source as the returned action code, with parameters in input. No host gameplay policy or model approval is needed per decision.
Controller audit reports are version-scoped evidence; compare them with current source and repair demonstrated defects rather than treating a report as proof that an action succeeded. Use actual POV images for terrain/build quality and host observations for exact inventory. Do not change the world through model tools: your only gameplay authority is the versioned controller. Improve existing controller rather than replacing successful behavior for novelty. Candidate source and validation errors are visible.\n\nMinecraft RPC:\n${RPC_DESCRIPTION}`;
    const capture = async () => {
      const generation = life;
      const observed = state();
      const metadata = { updatedAt: observed.updatedAt, bots: observed.bots.map(({ name, status, session: sourceSession, dimension, position }) => ({ name, status, session: sourceSession, dimension, position })), povBot: 'Roy', includeBase: false };
      const response = await fetch('http://127.0.0.1:8935/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
      const result = await response.json();
      if (!response.ok) throw new Error('Player vision failed: ' + result.error);
      if (generation !== life) throw new Error('Life changed while capturing the camera');
      const frame = result.frames[0];
      if (frame.sourceSession !== session || frame.sourceDimension !== bot.game.dimension) throw new Error('Camera actor context changed during capture');
      const { image: _imageContent, ...source } = frame;
      return { at: Date.parse(frame.capturedAt), life: generation, frame, source };
    };
    const vision = new VisionLoop({
      capture,
      contextKey: () => `${session}:${life}:${bot.game.dimension}`,
      onFrame: (frame, timing) => {
        visionError = null;
        emit('vision', 'Received current first-person image.', { source: frame.source, bytes: Buffer.byteLength(frame.frame.image.data, 'base64'), ...timing });
      },
      onError: failure => { visionError = failure.message; emit('error', failure.message); },
    });
    cleanup.push(async () => { vision.close(); });
    vision.start();
    const modelObservation = visual => ({
      worldId, session, life, reflexOwner, ...observationFeedback(rpc.observe()), notes, progress: progress.observation(),
      controller: controllerFeedback(), scheduler: controllerLoop.inspect(),
      action: actionFeedback(action()),
      events: events.filter(event => !['rpc', 'minecraft_rpc', 'model', 'latency', 'vision'].includes(event.type)).slice(-12),
      image: visual.source, imageAgeMs: Date.now() - visual.at, reusableSkills: skills.list(),
    });
    const engineer = new BackgroundAgent({ open: engineerSignal => openPlayerAgent({
      signal: AbortSignal.any([signal, engineerSignal]),
      onStatus: durable => lifecycle.update({ durable }),
      stateDir, worldId, socketPath: env.PLANNER_AUTH_SOCKET ?? '/run/minecraft-planner-auth/auth.sock', tools, instructions,
      onEvent: event => emit('model', event.type ?? 'Player model event', event),
    }), onError: failure => { fail(failure); emit('engineer_error', failure.message); } });
    cleanup.push(() => engineer.close());
    signal.throwIfAborted();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      if (label()) {
        metrics.actionActiveMs += now - previousHeartbeat;
        if (thinking) metrics.planningDuringActionMs += now - previousHeartbeat;
        idleSince = now;
      }
      else { metrics.withoutActionMs += now - previousHeartbeat; metrics.longestWithoutActionMs = Math.max(metrics.longestWithoutActionMs, now - idleSince); }
      previousHeartbeat = now;
      void atomicJson(observationFile, { ...state(), metrics, controller: { version: controller.current()?.version, scheduler: controllerLoop.inspect() } }).catch(fail);
      void knowledge.flush().catch(fail);
    }, 2000);
    cleanup.push(async () => { clearInterval(heartbeat); await progressWrite; });
    await atomicJson(observationFile, state());
    lifecycle.handler(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const supplied = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return response.writeHead(401).end('{}');
      if (request.method !== 'POST' || request.url !== '/diary') return response.writeHead(404).end('{}');
      try {
        let body = '';
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 131072) throw new Error('Diary input exceeds 128 KiB'); }
        const facts = JSON.parse(body);
        if (facts.worldId !== worldId) throw new Error('Diary world mismatch');
        if (!engineer.agent) throw new Error(`Background engineer unavailable: ${engineer.error?.message ?? 'recovering'}`);
        const result = await engineer.agent.narrate(facts);
        response.end(JSON.stringify({ ...result, worldId }));
      } catch (failure) { fail(failure); response.writeHead(500).end(JSON.stringify({ error: failure.message })); }
    });
    lifecycle.update({ phase: 'ready', ready: true });
    emit('spawn', 'Roy connected to the current survival world.', { worldId });
    let nextImprovement = 0;
    let background;
    const improve = async () => {
      thinking = true;
      try {
        const visual = await vision.current();
        if (visual.life !== life || stopping) return;
        const controllerAudit = await optionalJson(path.join(stateDir, 'controller-audit.json'), null);
        const observed = { ...modelObservation(visual), controllerAudit, decision: controller.current()
          ? 'The persistent controller is playing independently. Inspect its outcomes and improve a real weakness only; save a candidate if needed. Do not wait for an action to finish or drive individual moves.'
          : 'No controller is active. Write a general persistent controller now, with offline fixtures. It must keep choosing useful actions locally without further model requests.' };
        emit('perception', 'Background engineer received state and actual POV image.', { imageAgeMs: observed.imageAgeMs, imageSha256: visual.source.sha256 });
        const started = Date.now();
        const answer = await engineer.agent.step(observed, { images: [visual.frame.image] });
        metrics.modelMs += Date.now() - started;
        metrics.modelRuns++;
        emit('latency', 'Background controller improvement finished; local play did not await it.', { cycleMs: Date.now() - started, modelCalls: answer.modelCalls, toolCalls: answer.toolCalls });
        await atomicJson(path.join(stateDir, 'last-step.json'), { at: new Date().toISOString(), observation: observed, answer });
      } catch (failure) {
        if (!stopping) { fail(failure); emit('error', failure.message); }
      } finally {
        thinking = false;
        nextImprovement = Date.now() + (controller.current() ? 60000 : 5000);
      }
    };
    while (!stopping) {
      if (engineer.agent && !thinking && Date.now() >= nextImprovement && !reflexOwner && bot.health > 0) {
        background = improve();
      }
      try {
        await controllerLoop.tick();
      } catch (failure) {
        fail(failure);
        emit('controller_error', failure.message);
        // Failed decisions are visible and retried on a bounded cadence, not a hot loop.
        controllerLoop.nextAt = Date.now() + 5000;
      }
      await sleep(100, undefined, { signal });
    }
    await background;

  } catch (failure) {
    if (!signal.aborted) throw failure;
    console.log(signal.reason.message);
  } finally {
    const failures = [];
    lifecycle.update({ phase: 'stopping', ready: false });
    stopRuntime?.();
    try { await stopActions?.(); } catch (failure) { failures.push(failure); }
    for (const dispose of cleanup.reverse()) {
      try { await dispose(); } catch (failure) { failures.push(failure); }
    }
    try { await flushProgress?.(); } catch (failure) { failures.push(failure); }
    try { await lifecycle.close(); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError(failures, 'Player shutdown failed');
  }
}

if (import.meta.url === 'file://' + process.argv[1]) await runPlayer();
