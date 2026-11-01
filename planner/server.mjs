import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODEL, MODEL_ROLES, MISSION_INSTRUCTIONS, HttpError, validateChat, validateObservation } from './contracts.mjs';
import { ModelQueue } from './queue.mjs';
import { DIARY_INSTRUCTIONS, validateDiaryInput, validateDiaryParagraph } from './diary.mjs';
import { openEngine } from './engine.mjs';
import { plannerWorldConfig } from './world-scope.mjs';
import { MEAL_EVIDENCE_VERSION, correctUnverifiedMeals, initialEvidence, observeEvidence, resetSinceReview } from './evidence.mjs';
import { STRATEGY_INSTRUCTIONS, reviewTrigger, strategyContext, validateReview } from './strategy.mjs';

const BODY_LIMIT = 128 * 1024;
const OBSERVED_LIMIT = 1024 * 1024; // Four bounded producer streams plus the public event projection.

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o640 });
  await rename(temporary, file);
}

async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function bodyJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'Request body exceeds 128 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function authorized(request, token) {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function startPlanner({
  engine, token, stateDir, missionFile, observedFile,
  host = '127.0.0.1', port = 8766,
  queue = new ModelQueue({ intervalMs: 0 }), missionIntervalMs = 300000, pollMs = 5000,
}) {
  if (!token || token.length < 24) throw new Error('PLANNER_RELAY_TOKEN must contain at least 24 characters');
  let adventure = await engine.getAdventureState();
  if (adventure.evidence === null) {
    const existingMission = await optionalJson(missionFile);
    adventure = await engine.commitAdventureState({ expectedRevision: adventure.revision, next: {
      strategy: null, evidence: initialEvidence(), mission: existingMission,
      lastReviewAt: 0, lastTriggerFingerprint: null,
    } });
  }
  if (adventure.evidence.mealEvidence !== MEAL_EVIDENCE_VERSION) {
    adventure = await engine.recordEvidence({ expectedRevision: adventure.revision, evidence: correctUnverifiedMeals(adventure.evidence) });
  }
  let mission = adventure.mission;
  // Pi Durable is authoritative; this file is only the bot-readable projection.
  await writeJson(missionFile, mission);
  const statusFile = path.join(stateDir, 'status.json');
  const pendingFile = path.join(stateDir, 'pending-mission.json');
  const status = await optionalJson(statusFile) ?? { lastMissionAttempt: 0, lastMissionError: null };
  let missionRunning = false;
  let stopping = false;
  let lastEvidenceRecordedAt = Date.now();

  async function readObserved() {
    const raw = await readFile(observedFile, 'utf8');
    if (Buffer.byteLength(raw) > OBSERVED_LIMIT) throw new Error('Observed game state exceeds 1 MiB');
    return validateObservation(JSON.parse(raw));
  }

  async function prepareReview(state, observed, trigger) {
    const evidence = observeEvidence(state.evidence, observed);
    const recorded = await engine.recordEvidence({ expectedRevision: state.revision, evidence, lastTriggerFingerprint: trigger.fingerprint });
    const pending = {
      version: 2, id: randomUUID(), stateRevision: recorded.revision, trigger, dispatchedAt: null,
      observed, evidence, previousMission: recorded.mission, previousStrategy: recorded.strategy,
      context: strategyContext(recorded, evidence, observed, trigger),
    };
    await writeJson(pendingFile, pending);
    lastEvidenceRecordedAt = Date.now();
    return pending;
  }

  async function missionTick() {
    if (missionRunning || stopping) return;
    missionRunning = true;
    try {
      adventure = await engine.getAdventureState();
      mission = adventure.mission;
      await writeJson(missionFile, mission);
      let pending = await optionalJson(pendingFile);
      if (pending && adventure.mission?.id === pending.id) {
        // A crash after the document commit cannot lose or regenerate the mission.
        await writeJson(pendingFile, null);
        status.lastMissionError = null;
        return;
      }
      if (pending && pending.version !== 2) throw new Error('Superseded pre-strategy pending mission; dated published mission retained');
      if (!pending) {
        const observed = await readObserved();
        const evidence = observeEvidence(adventure.evidence, observed);
        const trigger = reviewTrigger(adventure, evidence, observed, Date.now(), status.lastMissionAttempt, missionIntervalMs);
        if (!trigger) {
          // Notice completed bots promptly without increasing idle SQLite writes.
          if (Date.now() - lastEvidenceRecordedAt >= 30000) {
            adventure = await engine.recordEvidence({ expectedRevision: adventure.revision, evidence });
            lastEvidenceRecordedAt = Date.now();
          }
          return;
        }
        pending = await prepareReview(adventure, observed, trigger);
      }
      status.lastMissionAttempt = Date.now();
      const queuedAt = Date.now();
      await writeJson(statusFile, status);
      const answer = await queue.run(async () => {
        // A queued or crash-persisted request retains its ID/input while fresh.
        // A stale input gets a new identity, never reused for different model input.
        const current = await readObserved();
        if (Date.now() - Date.parse(pending.observed.updatedAt) > 60000 ||
            (pending.dispatchedAt === null && JSON.stringify(current) !== JSON.stringify(pending.observed))) {
          pending = await prepareReview(await engine.getAdventureState(), current, pending.trigger);
        }
        validateObservation(pending.observed);
        pending.dispatchedAt = Date.now();
        await writeJson(pendingFile, pending);
        console.info(JSON.stringify({ event: 'mission_started', id: pending.id, trigger: pending.trigger.kind, queuedMs: pending.dispatchedAt - queuedAt, observedAt: pending.observed.updatedAt }));
        return engine.complete([
          { role: 'system', content: MISSION_INSTRUCTIONS + '\n\n' + STRATEGY_INSTRUCTIONS },
          { role: 'user', content: JSON.stringify({ observed: pending.observed, previousMission: pending.previousMission, ...pending.context }) },
        ], 'mission-' + pending.id, { role: 'mission' });
      }, { priority: 1 });
      const latest = await readObserved();
      const reviewed = validateReview(JSON.parse(answer.text), pending.previousStrategy, pending.evidence, pending.observed);
      const proposedMission = {
        id: pending.id, observedAt: pending.observed.updatedAt, generatedAt: new Date().toISOString(),
        ...reviewed.mission, goalId: reviewed.strategy.goal.id,
      };
      // Events during inference belong to the NEXT review, not an unobserved reset.
      const evidence = observeEvidence(resetSinceReview(pending.evidence), latest);
      adventure = await engine.commitAdventureState({ expectedRevision: pending.stateRevision, next: {
        strategy: reviewed.strategy, evidence, mission: proposedMission,
        lastReviewAt: Date.now(), lastTriggerFingerprint: pending.trigger.fingerprint,
      } });
      mission = adventure.mission;
      await writeJson(missionFile, mission);
      await writeJson(pendingFile, null);
      status.lastMissionError = null;
      console.info(JSON.stringify({ event: 'mission', id: mission.id, phase: mission.phase, goal: reviewed.strategy.goal.id, decision: reviewed.strategy.decision, trigger: pending.trigger.kind, queuedMs: pending.dispatchedAt - queuedAt, planningMs: Date.now() - pending.dispatchedAt }));
    } catch (error) {
      // The durable document remains authoritative even if its file projection fails.
      status.lastMissionError = error.message;
      console.error(JSON.stringify({ event: 'mission_failed', error: error.message }));
      await writeJson(pendingFile, null);
    } finally {
      await writeJson(statusFile, status);
      missionRunning = false;
    }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    const send = (code, body) => response.writeHead(code).end(JSON.stringify(body));
    const controller = new AbortController();
    response.once('close', () => {
      if (!response.writableFinished) controller.abort(new Error('HTTP client disconnected'));
    });
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        return send(200, { ok: !stopping, models: MODEL_ROLES, pending: queue.pending, ...status, missionId: mission?.id ?? null, adventureRevision: adventure.revision, goalId: adventure.strategy?.goal.id ?? null });
      }
      if (!authorized(request, token)) throw new HttpError(401, 'Unauthorized');
      if (request.method === 'GET' && request.url === '/mission') return send(200, mission);
      if (request.method === 'GET' && request.url === '/strategy') return send(200, await engine.getAdventureState());
      if (request.method === 'POST' && request.url === '/diary') {
        if (stopping) throw new HttpError(503, 'Planner is stopping');
        const input = validateDiaryInput(await bodyJson(request));
        const id = 'diary-' + randomUUID();
        const answer = await queue.run(() => engine.complete([
          { role: 'system', content: DIARY_INSTRUCTIONS },
          { role: 'user', content: JSON.stringify(input) },
        ], id, { signal: controller.signal, role: 'repair' }), { signal: controller.signal });
        const text = validateDiaryParagraph(answer.text);
        console.info(JSON.stringify({ event: 'diary', id, model: MODEL, observedAt: input.observedAt, answerEntryId: answer.answerEntryId, usage: answer.usage }));
        return send(200, { text, model: MODEL, answerEntryId: answer.answerEntryId });
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') throw new HttpError(404, 'Not found');
      if (stopping) throw new HttpError(503, 'Planner is stopping');
      const body = validateChat(await bodyJson(request));
      const id = request.headers['x-request-id'] ?? randomUUID();
      if (typeof id !== 'string' || id.length > 128) throw new HttpError(400, 'Invalid request id');
      const answer = await queue.run(() => engine.complete([
        ...body.messages,
        ...(mission ? [{ role: 'system', content: 'Shared mission (historical world observations take precedence): ' + JSON.stringify(mission) }] : []),
      ], 'chat-' + body.user + '-' + id, { signal: controller.signal, role: 'repair' }), { signal: controller.signal });
      console.info(JSON.stringify({ event: 'chat', user: body.user, id, usage: answer.usage }));
      return send(200, {
        id: 'chatcmpl-' + id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: answer.finishReason }],
        usage: {
          prompt_tokens: (answer.usage?.input ?? 0) + (answer.usage?.cacheRead ?? 0) + (answer.usage?.cacheWrite ?? 0),
          completion_tokens: answer.usage?.output ?? 0,
          total_tokens: answer.usage?.totalTokens ?? 0,
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof HttpError ? error.status : 502;
      if (code === 502) console.error('Planner model request failed:', error.message);
      if (!response.headersSent && !response.destroyed) send(code, { error: { message: code === 502 ? 'Model request failed' : error.message, type: 'planner_error' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const timer = observedFile ? setInterval(() => { void missionTick(); }, pollMs) : null;
  if (observedFile) void missionTick();
  return {
    server,
    missionTick,
    async close() {
      stopping = true;
      if (timer) clearInterval(timer);
      await new Promise(resolve => server.close(resolve));
      await queue.drain();
      while (missionRunning) await new Promise(resolve => setTimeout(resolve, 20));
      await engine.close();
    },
  };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  process.umask(0o027);
  const config = await plannerWorldConfig(process.env);
  const engine = await openEngine({
    stateDir: config.databaseDir,
    worldScope: config.worldScope,
    socketPath: process.env.PLANNER_AUTH_SOCKET ?? '/run/minecraft-planner-auth/auth.sock',
  });
  const planner = await startPlanner({
    engine,
    token: process.env.PLANNER_RELAY_TOKEN,
    stateDir: config.stateDir,
    missionFile: config.missionFile,
    observedFile: config.observedFile,
    port: Number(process.env.PLANNER_PORT ?? 8766),
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void planner.close().then(() => process.exit(0), () => { console.error('Planner shutdown failed'); process.exit(1); });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
