import { trackViewerLightColumns } from './viewer.mjs';
import { withDoorPassage } from './door-navigation.mjs';
import { startPlayerLifecycle } from './lifecycle.mjs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openPlayerAgent } from './agent.mjs';
import { BackgroundAgent } from './background-agent.mjs';
import { EngineeringSignals } from './engineering-signals.mjs';
import { readPlayerEvents } from './event-log.mjs';
import { ControlDrain } from './control-drain.mjs';
import { readEngineeringPerception } from './perception.mjs';
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
import { openPlanningMemory, planningMemoryTools } from './planning-memory.mjs';
import { missionController, planningObservation } from './mission.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const DoorMovements = withDoorPassage(Movements);
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
    const memory = await openPlanningMemory(path.join(stateDir, 'notes.json'), data => {
      emit('home_selected', 'Explicitly selected the permanent home.', data);
    });
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
    let reflexes;
    let thinking = false;
    let error = null;
    let stopping = false;
    stopRuntime = () => { stopping = true; };
    signal.addEventListener('abort', () => { stopping = true; }, { once: true });
    let visionError = null;
    let engineering;
    let controller;
    let activeAnalysis = null;
    let deliveredFeedbackKey = null;
    let lastWorldEffect = 0;
    let retryAt = null;
    let engineerFailures = 0;
    let idleEvidence = null;
    let environment = null;
    const controlDrain = new ControlDrain();
    const metrics = { startedAt: new Date().toISOString(), actionActiveMs: 0, withoutActionMs: 0, longestWithoutActionMs: 0, planningDuringActionMs: 0, modelMs: 0, modelRuns: 0 };
    let previousHeartbeat = Date.now();
    let idleSince = Date.now();
    let modelEventSequence = 0;
    const emit = (type, message, data = {}) => {
      if (type === 'skill_started') reflexes?.releaseIdle();
      const event = { session, sequence: ++sequence, worldId, at: new Date().toISOString(), bot: 'Roy', type, message: String(message), data };
      // High-volume RPC/model events remain in the complete on-disk event log.
      if (!['rpc', 'minecraft_rpc', 'model', 'latency', 'vision'].includes(type)) events.push(event);
      console.log(JSON.stringify(event));
      void appendFile(path.join(stateDir, 'events.jsonl'), JSON.stringify(event) + '\n').catch(fail);
      if (GAMEPLAY.has(type)) void appendFile(gameplayLedger, JSON.stringify(event) + '\n').catch(fail);
      if (type === 'gather' || type === 'build') lastWorldEffect = sequence;
      if (engineering && ['death', 'error', 'controller_error', 'reflex', 'reflex_blocked'].includes(type)) {
        engineering.notify({ kind: type, key: message, details: data, version: controller.current()?.version ?? null, life, sequence, at: event.at });
      }
      if (engineering && type === 'controller' && data.type === 'controller-error') {
        engineering.notify({ kind: 'candidate_rejected', key: data.error, details: data, version: controller.current()?.version ?? null, life, sequence, at: event.at });
      }
      if (engineering && type === 'controller' && data.type === 'controller-activated') {
        const activated = controller.current();
        engineering.activated(activated.version);
        emit('engineering_patch_applied', 'Hot-reloaded controller edit is active.', {
          version: activated.version, baseVersion: activated.baseVersion, analysis: activated.analysis,
          evidenceToPatchMs: activated.analysis ? Date.now() - new Date(activated.analysis.requestedAt).getTime() : null,
          candidateToPatchMs: Date.now() - Date.parse(activated.createdAt),
        });
      }
    };
    const fail = failure => { error = failure.message; console.error(failure); };
    const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25567, username: 'Roy', auth: 'offline', version: '1.21.4' });
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
    const movements = new DoorMovements(bot);
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
    const sandbox = new SkillSandbox({ rpc, historyDirectory: path.join(stateDir, 'action-history'), onEvent: event => {
      if (event.type === 'action-end') {
        const result = event.action;
        const effects = result.before && result.after ? skillEvidence(result.before, result.after) : null;
        progress.completed({ ...result, session });
        void saveProgress();
        emit('action', `${result.name}: ${result.state}${result.error ? ': ' + result.error.split('\n')[0] : ''}. Observed changes: ${JSON.stringify(effects)}`, { actionId: result.id, skillName: result.name, state: result.state, verified: Boolean(effects && (Object.keys(effects.inventoryDelta).length || effects.foodDelta)), effects });
        engineering?.actionOutcome(result, { version: controller?.current()?.version ?? null, life, sequence, placedBlocks: progress.state.placedBlocks });
        engineering?.hostProgress(progress.state, { version: controller?.current()?.version ?? null, life, sequence });
        const recent = progress.state.actions.slice(-6);
        const sinceProgress = Date.now() - Date.parse(progress.state.lastMaterialProgressAt ?? metrics.startedAt);
        if (recent.length === 6 && sinceProgress >= 120000 &&
            recent.every(entry => !entry.effects || (!Object.values(entry.effects.inventoryDelta).some(value => value > 0) && entry.effects.foodDelta <= 0))) {
          engineering?.notify({ kind: 'resource_stagnation', key: 'work_without_retained_supplies',
            version: controller?.current()?.version ?? null, life, sequence,
            details: { sinceProgressMs: sinceProgress, actions: recent } });
        }
        pipeline.completed(result);
      } else if (event.type === 'rpc-result') {
        if (event.call.error) engineering?.notify({
          kind: 'rpc_failure', key: `${event.actionName}:${event.call.method}:${JSON.stringify(event.call.args)}:${event.call.error.split('\n')[0]}`,
          version: controller?.current()?.version ?? null, life, sequence,
          details: { actionId: event.actionId, name: event.actionName, method: event.call.method, args: event.call.args, error: event.call.error },
        });
        emit('rpc', `${event.actionName}: ${event.call.method}: ${event.call.error?.split('\n')[0] ?? 'returned'}`, { actionId: event.actionId, skillName: event.actionName, method: event.call.method, error: event.call.error });
      }
    } });
    const pipeline = new ActionPipeline({ sandbox, worldId, context: () => ({ session, life, reflexOwner, stopping, draining: controlDrain.active, health: bot.health }), onEvent: emit });
    const action = () => pipeline.current();
    const label = () => {
      if (reflexOwner) return reflexOwner;
      const current = action();
      return current?.state === 'running' ? current.name : null;
    };
    const state = () => ({ ...playerState(bot, { worldId, session, events, action: label(), thinking, error: error ?? visionError, life, notes: memory.notes }), gameplayLedger: true, actionId: pipeline.latestId, nextSkill: pipeline.next?.name ?? null });
    let controllerLoop;
    const interrupt = reason => controlDrain.run(async () => {
      if (reason === 'Controller hot reload' && reflexOwner) return;
      controllerLoop?.invalidate(reason);
      pipeline.clear();
      if (pipeline.latestId) {
        sandbox.cancel(pipeline.latestId, reason);
        await sandbox.wait(pipeline.latestId, { details: false });
      }
      // Safety can acquire ownership while sandbox/RPC cancellation is awaiting.
      // A late mission handoff must not clear the survival action's new goal.
      if (reason === 'Controller hot reload' && reflexOwner) return;
      rpc.cancel();
      await rpc.waitForIdle();
      if (reason === 'Controller hot reload' && reflexOwner) return;
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      emit('interrupted', reason);
    });
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
    reflexes = installReflexes(bot, {
      acquire: async reason => { reflexOwner = reason; await interrupt(reason); },
      release: () => { reflexOwner = null; },
      canFloat: () => !stopping && !controlDrain.active && action()?.settled !== false,
      goals, emit, onError: fail,
    });
    cleanup.push(async () => { reflexes.close(); });
    const skillsDir = env.PLAYER_SKILL_DIR ?? '/var/lib/minecraft-player/skills';
    await mkdir(skillsDir, { recursive: true });
    const skills = new SkillLibrary({ directory: skillsDir });
    controller = new PersistentController({
      directory: path.join(stateDir, 'controllers'), worldId,
      isActionActive: () => Boolean(sandbox.activeId) || Boolean(reflexOwner) || controlDrain.active,
      onEvent: event => emit('controller', event.type ?? 'Controller event', event),
    });
    await controller.open();
    engineering = new EngineeringSignals({ onEvent: emit });
    engineering.notify({ kind: 'startup', key: controller.current() ? 'evaluate_current_controller' : 'missing_controller',
      version: controller.current()?.version ?? null, life, sequence, details: { progress: progress.observation({ session }) } });
    controllerLoop = new ControllerLoop({
      controller, pipeline, observe: () => rpc.observe(),
      context: () => ({ worldId, session, life, reflexOwner, stopping, draining: controlDrain.active, health: bot.health }),
      onEvent: (type, message, data) => {
        if (type === 'controller_action') { error = null; idleEvidence = null; }
        if (type === 'controller_replan') {
          engineering.notify({ kind: 'mission_outcome', key: data.version, version: data.version, life, sequence,
            details: { reason: message, action: actionFeedback(action()) } });
        }
        if (type === 'controller_idle') {
          if (idleEvidence?.reason !== message) idleEvidence = { reason: message, since: Date.now() };
          if (Date.now() - idleEvidence.since >= 120000) {
            engineering.notify({ kind: 'idle_stagnation', key: message, version: controller.current()?.version ?? null, life, sequence,
              details: { reason: message, since: idleEvidence.since } });
          }
        }
        emit(type, message, data);
      },
    });
    for (const candidate of controller.inspect().versions.filter(record => record.status === 'admitted')) {
      controllerLoop.stage(candidate);
    }
    cleanup.push(async () => { await knowledge.flush(); });
    const controllerFeedback = version => {
      if (version) {
        return controller.inspect(version);
      }
      const view = controller.inspect();
      const active = controller.current();
      return {
        worldId, active: active && { version: active.version, baseVersion: active.baseVersion, name: active.name, code: active.code },
        state: view.state, error: view.error, lastDecision: view.lastDecision, feedbackFailure: view.feedbackFailure,
        versionCount: view.versions.length,
        versions: view.versions.filter(record => record.status === 'admitted').map(({ version, baseVersion, name, status, error }) => ({ version, baseVersion, name, status, error })),
        history: 'Prior versions remain on disk; controller_inspect({version}) retrieves original source and evidence.',
      };
    };
    const tool = (name, description, properties, required, execute) => ({ name, description, parameters: { ...OBJECT(properties), required }, execute });
    const submitControllerCandidate = async args => {
      const currentVersion = controller.current()?.version ?? null;
      if (args.baseVersion !== currentVersion) throw new Error(`Stale controller baseVersion: inspect current ${currentVersion} before submitting another patch.`);
      const analysis = activeAnalysis && {
        id: activeAnalysis.id, feedbackKey: deliveredFeedbackKey, startedAt: activeAnalysis.startedAt,
        requestedAt: activeAnalysis.requestedAt, reasons: activeAnalysis.reasons.map(({ kind, revision, requestedAt, sequence }) => ({ kind, revision, requestedAt, sequence })),
      };
      const record = await controller.candidate({ ...args, analysis });
      emit('engineering_candidate', 'Background engineer submitted a controller candidate.', {
        analysisId: activeAnalysis?.id, version: record.version, baseVersion: record.baseVersion,
        analysisMs: activeAnalysis ? Date.now() - activeAnalysis.startedAt : null, reasons: analysis?.reasons,
      });
      if (activeAnalysis) activeAnalysis.patched = true;
      return controllerLoop.hotReload(record, interrupt);
    };
    const tools = [
      tool('mission', 'Choose the next finite gameplay episode. Code is a skill body with mc.call/mc.observe and input, runs once within the 120-second action deadline, then returns to strategic planning with actual outcomes. Include an observable success criterion. Use a coherent route and related productive operations, not tiny waypoint polling. The world, inventory, controller history and notes persist.', { objective: STRING, expectedOutcome: STRING, code: STRING, input: { type: 'object' }, baseVersion: { type: ['string', 'null'] } }, ['objective', 'expectedOutcome', 'code', 'baseVersion'], async args => submitControllerCandidate({
        name: args.objective, baseVersion: args.baseVersion, code: missionController(args),
      })),
      tool('observe', 'Read fresh server state immediately, plus a valid recent POV when available. Capture runs independently; imagePending means no image is attached. Includes current baseVersion and engineering evidence. Never infer unseen terrain.', {}, [], async () => {
        const visual = perceptionImage();
        const observed = { ...modelObservation(visual), baseVersion: controller.current()?.version ?? null, engineering: engineering.feedback() };
        return { output: [{ type: 'text', text: JSON.stringify(observed) }, ...(visual ? [visual.frame.image] : [])] };
      }),
      tool('controller_inspect', 'Read the active persistent controller, durable state, candidate source and admission/runtime results. Inspect before improving it. Supply feedbackId to read the complete retained original of transport-rejected action feedback.', { version: STRING, feedbackId: STRING }, [], async ({ version, feedbackId }) => feedbackId ? controller.inspectFeedback(feedbackId) : ({ controller: controllerFeedback(version), scheduler: controllerLoop.inspect() })),
      tool('controller_candidate', 'Submit a complete replacement controller module against inspected baseVersion (null for bootstrap). Admission checks only syntax, imports, async decide entrypoint and transport feasibility. It hot-reloads after safe control/RPC drain; no offline gameplay fixtures or approval gate. Runtime failures go directly back to engineering feedback. Prefer controller_edit for small repairs.', { name: STRING, code: STRING, baseVersion: { type: ['string', 'null'] } }, ['name', 'code', 'baseVersion'], submitControllerCandidate),
      tool('controller_edit', 'Hot-reload a small exact edit against inspected active baseVersion. Every oldText matches uniquely in original source; edits must not overlap. Only syntax/import/entrypoint checks precede safe cancellation, RPC drain and activation. No offline fixtures or gameplay approval. Observe actual outcomes and iterate.', { name: STRING, baseVersion: STRING, edits: { type: 'array', minItems: 1, items: { ...OBJECT({ oldText: { type: 'string', minLength: 1 }, newText: STRING }), required: ['oldText', 'newText'] } } }, ['name', 'baseVersion', 'edits'], submitControllerCandidate),
      tool('action_inspect', 'Read a complete retained action record including all original RPC calls/results, errors and before/after observations. Useful for investigating any outcome projection.', { actionId: STRING }, ['actionId'], async ({ actionId }) => sandbox.inspect(actionId)),
      tool('read_events', 'Read complete persisted event records, including original errors and RPC/model events. Defaults to this player session; supply another session to inspect its history. afterSequence and types select evidence without byte/line truncation.', { session: STRING, afterSequence: { type: 'integer', minimum: 0 }, types: { type: 'array', items: STRING } }, [], async args => readPlayerEvents(path.join(stateDir, 'events.jsonl'), { ...args, session: args.session ?? session })),
      ...planningMemoryTools(memory),
      tool('skills', 'List reusable JavaScript skills, fetch one by name, save source, or verify it against a completed action and explicit expected postconditions. Source is reusable; evidence is world-scoped, not current inventory. expected supports inventory minimum counts, inventoryDelta minimum increases, position {x,y,z,within}, health {min}, blocks [{x,y,z,name}]. Verification requires host-observed change, not returned claims.', { name: STRING, description: STRING, code: STRING, actionId: STRING, expected: { type: 'object' } }, [], async args => {
        if (!args.name) return skills.list();
        if (args.code) await skills.save({ name: args.name, description: args.description ?? '', code: args.code });
        if (args.actionId) return skills.verify(args.name, { worldId, action: sandbox.inspect(args.actionId), expected: args.expected });
        return skills.get(args.name);
      }),
    ];
    const instructions = `All gameplay runs through the versioned isolated controller. mission creates a one-shot controller automatically; controller_candidate/edit remain available for reusable local behavior. For an explicit planning boundary a controller returns {state,action:null,replan:true,reason}. Supply the active inspected baseVersion. State and skills remain world-scoped. Do not replay obsolete routes from legacy controller state. Full source/outcomes remain available through inspect tools.\n\nMinecraft RPC:\n${RPC_DESCRIPTION}`;
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
        if (timing.fulfillsMissingImage) {
          engineering.notify({ kind: 'image_ready', key: frame.source.sha256, version: controller.current()?.version ?? null, life, sequence,
            details: { source: frame.source, capturedAt: frame.at } });
        }
      },
      onError: failure => { visionError = failure.message; emit('error', failure.message); },
    });
    cleanup.push(async () => { vision.close(); });
    vision.start();
    const perceptionImage = () => vision.sample();
    const modelEventDelta = () => {
      const delta = events.filter(event => event.sequence > modelEventSequence);
      modelEventSequence = sequence;
      return delta;
    };
    const modelObservation = visual => planningObservation({
      worldId, session, life, reflexOwner, ...observationFeedback(rpc.observe()),
      notes: memory.notes, home: memory.home,
      progress: progress.observation({ session, since: controller.current()?.activatedAt }),
      controller: controllerFeedback(), scheduler: controllerLoop.inspect(),
      action: actionFeedback(action()),
      events: modelEventDelta(), eventLog: { session, throughSequence: sequence, tool: 'read_events' },
      image: visual ? visual.source : null, imageAgeMs: visual ? Date.now() - visual.at : null,
      imagePending: !visual, imageRefreshPending: Boolean(vision.pending), imageStatus: visual ? 'Actual matching-context camera frame attached with capture age; server facts are current. A newer render can arrive independently.' : 'Capture is running independently; no current image is attached. Use server observations, not an imagined view.',
      reusableSkills: skills.list(), baseVersion: controller.current()?.version ?? null,
    });
    const freshFeedback = async ({ phase } = {}) => {
      const feedback = engineering.feedback();
      if (stopping || bot.health <= 0 || (phase === 'onYield' && action()?.settled === false)) return null;
      if (phase !== 'beforeRequest' && (!feedback || feedback.key === deliveredFeedbackKey)) return null;
      if (!feedback && !activeAnalysis) return null;
      return readEngineeringPerception(
        () => optionalJson(path.join(stateDir, 'controller-audit.json'), null),
        controllerAudit => {
          if (stopping || bot.health <= 0) return null;
          const visual = perceptionImage();
          const pendingFeedback = engineering.feedback();
          const latest = pendingFeedback ?? (activeAnalysis && {
            key: deliveredFeedbackKey, requestedAt: activeAnalysis.requestedAt, reasons: activeAnalysis.reasons,
          });
          if (!latest) return null;
          deliveredFeedbackKey = latest.key;
          if (pendingFeedback) engineering.delivered(latest.key);
          if (activeAnalysis) activeAnalysis.reasons = [...new Map([...activeAnalysis.reasons, ...latest.reasons].map(reason => [reason.identity, reason])).values()];
          emit('engineering_feedback', 'Refreshed evidence and available camera data during background analysis.', {
            analysisId: activeAnalysis?.id, feedbackKey: latest.key, baseVersion: controller.current()?.version ?? null,
            imageAgeMs: visual ? Date.now() - visual.at : null, imagePending: !visual,
            reasons: latest.reasons.map(({ kind, key, count, revision, requestedAt }) => ({ kind, key, count, revision, requestedAt })),
          });
          return { ...latest, needsEngineering: true, baseVersion: controller.current()?.version ?? null,
            observation: { ...modelObservation(visual), controllerAudit, engineering: latest }, images: visual ? [visual.frame.image] : [] };
        });

    };
    const engineeringFailure = failure => {
      if (stopping) return;
      fail(failure);
      emit('engineer_error', failure.message);
      engineerFailures++;
      retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(engineerFailures, 5));
      emit('engineering_retry', 'Engineering failed; bounded error backoff, not gameplay cadence.', { retryAt, failure: failure.message });
    };
    const engineer = new BackgroundAgent({ open: engineerSignal => openPlayerAgent({
      signal: AbortSignal.any([signal, engineerSignal]),
      onStatus: durable => lifecycle.update({ durable }),
      stateDir, worldId, socketPath: env.PLANNER_AUTH_SOCKET ?? '/run/minecraft-planner-auth/auth.sock', tools, instructions,
      onEvent: event => emit('model', event.type ?? 'Player model event', { ...event, analysisId: activeAnalysis?.id }),
      getFeedback: freshFeedback,
    }), onError: engineeringFailure });
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
      const observedEnvironment = rpc.observe();
      const nextEnvironment = { dimension: observedEnvironment.dimension, biome: observedEnvironment.biome?.name ?? null, isDay: observedEnvironment.time?.isDay ?? null };
      if (environment) {
        for (const field of ['dimension', 'biome', 'isDay']) {
          if (nextEnvironment[field] !== environment[field]) engineering.notify({
            kind: 'environment_changed', key: `${field}:${nextEnvironment[field]}`, version: controller.current()?.version ?? null, life, sequence,
            details: { field, before: environment[field], after: nextEnvironment[field], position: observedEnvironment.position },
          });
        }
      }
      environment = nextEnvironment;
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
        for await (const chunk of request) body += chunk;
        const facts = JSON.parse(body);
        if (facts.worldId !== worldId) throw new Error('Diary world mismatch');
        if (!engineer.agent) throw new Error(`Background engineer unavailable: ${engineer.error?.message ?? 'recovering'}`);
        const result = await engineer.agent.narrate(facts);
        response.end(JSON.stringify({ ...result, worldId }));
      } catch (failure) { fail(failure); response.writeHead(500).end(JSON.stringify({ error: failure.message })); }
    });
    lifecycle.update({ phase: 'ready', ready: true });
    emit('spawn', 'Roy connected to the current survival world.', { worldId });
    let background;
    const improve = async batch => {
      thinking = true;
      deliveredFeedbackKey = batch.key;
      activeAnalysis = {
        ...batch, id: randomUUID(), baseVersion: controller.current()?.version ?? null,
        startedAt: Date.now(), worldEffect: lastWorldEffect, patched: false,
      };
      emit('engineering_analysis', 'Started reactive controller analysis while local play continues.', {
        analysisId: activeAnalysis.id, feedbackKey: batch.key, baseVersion: activeAnalysis.baseVersion,
        reactionMs: Date.now() - new Date(batch.requestedAt).getTime(), reasons: batch.reasons,
      });
      let failed = false;
      try {
        const payload = await readEngineeringPerception(
          () => optionalJson(path.join(stateDir, 'controller-audit.json'), null),
          controllerAudit => {
            if (stopping) return null;
            const visual = perceptionImage();
            const pending = engineering.feedback();
            if (pending) {
              deliveredFeedbackKey = pending.key;
              activeAnalysis.reasons = pending.reasons;
              engineering.delivered(pending.key);
            }
            const observed = { ...modelObservation(visual), controllerAudit,
              engineering: { ...batch, key: deliveredFeedbackKey, reasons: activeAnalysis.reasons } };
            return { observed, images: visual ? [visual.frame.image] : [] };
          });
        if (!payload) return;
        const { observed, images } = payload;
        emit('perception', 'Background engineer received fresh server state and independent camera status.', {
          analysisId: activeAnalysis.id, feedbackKey: deliveredFeedbackKey, imageAgeMs: observed.imageAgeMs,
          imageSha256: observed.image?.sha256 ?? null, imagePending: observed.imagePending, evidenceToModelMs: Date.now() - new Date(batch.requestedAt).getTime(),
          reasons: activeAnalysis.reasons.map(({ kind, revision, requestedAt }) => ({ kind, revision, requestedAt })),
        });
        const started = Date.now();
        const answer = await engineer.agent.step(observed, { images, feedbackKey: deliveredFeedbackKey });
        metrics.modelMs += Date.now() - started;
        metrics.modelRuns++;
        engineerFailures = 0;
        emit('latency', 'Background controller improvement finished; local play did not await it.', {
          analysisId: activeAnalysis.id, cycleMs: Date.now() - started, modelCalls: answer.modelCalls, toolCalls: answer.toolCalls,
        });
        await atomicJson(path.join(stateDir, 'last-step.json'), { at: new Date().toISOString(), observation: observed, answer });
      } catch (failure) {
        failed = true;
        engineeringFailure(failure);
      } finally {
        engineering.finish({ feedbackKey: deliveredFeedbackKey, baseVersion: activeAnalysis.baseVersion, patched: activeAnalysis.patched, failed });
        activeAnalysis = null;
        deliveredFeedbackKey = null;
        thinking = false;
      }
    };
    while (!stopping) {
      if (retryAt && Date.now() >= retryAt && !thinking) {
        retryAt = null;
        if (!engineer.agent) void engineer.retry();
        else engineering.notify({ kind: 'engineering_retry', key: String(engineerFailures), version: controller.current()?.version ?? null, life, sequence });
      }
      if (engineer.agent && !thinking && !retryAt && bot.health > 0 &&
          action()?.settled !== false && controllerLoop.inspect().pending.length === 0) {
        const batch = engineering.start();
        if (batch) background = improve(batch);
      }
      try {
        await controllerLoop.tick();
      } catch (failure) {
        fail(failure);
        emit('controller_error', failure.message);
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
