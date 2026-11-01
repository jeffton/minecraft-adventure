import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODEL, MISSION_INSTRUCTIONS, HttpError, validateChat, validatePlan, validateObservation } from './contracts.mjs';
import { ModelQueue } from './queue.mjs';
import { openEngine } from './engine.mjs';

const BODY_LIMIT = 128 * 1024;

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
  queue = new ModelQueue({ intervalMs: 0 }), missionIntervalMs = 300000, pollMs = 30000,
}) {
  if (!token || token.length < 24) throw new Error('PLANNER_RELAY_TOKEN must contain at least 24 characters');
  let mission = await optionalJson(missionFile);
  const statusFile = path.join(stateDir, 'status.json');
  const pendingFile = path.join(stateDir, 'pending-mission.json');
  const status = await optionalJson(statusFile) ?? { lastMissionAttempt: 0, lastMissionError: null };
  let missionRunning = false;
  let stopping = false;

  async function missionTick() {
    if (missionRunning || stopping) return;
    missionRunning = true;
    try {
      let pending = await optionalJson(pendingFile);
      if (!pending) {
        if (Date.now() - status.lastMissionAttempt < missionIntervalMs) return;
        const raw = await readFile(observedFile, 'utf8');
        if (Buffer.byteLength(raw) > BODY_LIMIT) throw new Error('Observed game state exceeds 128 KiB');
        validateObservation(JSON.parse(raw));
        pending = { id: randomUUID(), observed: null, previousMission: mission };
        await writeJson(pendingFile, pending);
      }
      status.lastMissionAttempt = Date.now();
      await writeJson(statusFile, status);
      const answer = await queue.run(async () => {
        // Reread at dispatch; queued or crash-persisted snapshots may have aged.
        const raw = await readFile(observedFile, 'utf8');
        if (Buffer.byteLength(raw) > BODY_LIMIT) throw new Error('Observed game state exceeds 128 KiB');
        const current = validateObservation(JSON.parse(raw));
        if (pending.observed === null || Date.now() - Date.parse(pending.observed.updatedAt) > 60000) {
          pending = { id: randomUUID(), observed: current, previousMission: mission };
          await writeJson(pendingFile, pending);
        }
        validateObservation(pending.observed);
        const result = await engine.complete([
          { role: 'system', content: MISSION_INSTRUCTIONS },
          { role: 'user', content: JSON.stringify({ observed: pending.observed, previousMission: pending.previousMission }) },
        ], 'mission-' + pending.id);
        // A recovered cached answer is not relabeled as a current observation.
        validateObservation(pending.observed);
        return result;
      });
      const plan = validatePlan(JSON.parse(answer.text));
      mission = { id: pending.id, generatedAt: new Date().toISOString(), ...plan };
      await writeJson(missionFile, mission);
      await writeJson(pendingFile, null);
      status.lastMissionError = null;
      console.info(JSON.stringify({ event: 'mission', id: mission.id, phase: mission.phase }));
    } catch (error) {
      // Failed/malformed model answers are explicit. Existing published missions remain dated, never invented.
      status.lastMissionError = error.message;
      console.error(JSON.stringify({ event: 'mission_failed', error: error.message }));
      // An admitted durable model call can be replayed after process death. Terminal failures need a new attempt.
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
        return send(200, { ok: !stopping, model: MODEL, pending: queue.pending, ...status, missionId: mission?.id ?? null });
      }
      if (!authorized(request, token)) throw new HttpError(401, 'Unauthorized');
      if (request.method === 'GET' && request.url === '/mission') return send(200, mission);
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') throw new HttpError(404, 'Not found');
      if (stopping) throw new HttpError(503, 'Planner is stopping');
      const body = validateChat(await bodyJson(request));
      const id = request.headers['x-request-id'] ?? randomUUID();
      if (typeof id !== 'string' || id.length > 128) throw new HttpError(400, 'Invalid request id');
      const answer = await queue.run(() => engine.complete([
        ...body.messages,
        ...(mission ? [{ role: 'system', content: 'Shared mission (historical world observations take precedence): ' + JSON.stringify(mission) }] : []),
      ], 'chat-' + body.user + '-' + id, { signal: controller.signal }), { signal: controller.signal });
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
      if (code === 502) console.error('Planner model request failed');
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
  const stateDir = process.env.PLANNER_STATE_DIR ?? '/var/lib/minecraft-planner';
  const engine = await openEngine({
    stateDir,
    socketPath: process.env.PLANNER_AUTH_SOCKET ?? '/run/minecraft-planner-auth/auth.sock',
  });
  const planner = await startPlanner({
    engine,
    token: process.env.PLANNER_RELAY_TOKEN,
    stateDir,
    missionFile: process.env.PLANNER_MISSION_FILE ?? '/var/lib/minecraft-adventure/control/mission.json',
    observedFile: process.env.PLANNER_OBSERVED_FILE ?? '/var/lib/minecraft-adventure/observations/state.json',
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
