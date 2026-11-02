import { createConnection } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_FRAME_BYTES, readFrames, sendFrame } from './sandbox-protocol.mjs';

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}

export function rpcFailureKey(method, args) {
  return createHash('sha256').update(JSON.stringify([method, args])).digest('hex');
}

function statusProjection(action) {
  const { before, after, ...metadata } = action;
  const facts = observed => {
    if (!observed) return undefined;
    const { at, health, food, oxygen, position, dimension, inventory, heldItem, time } = observed;
    return { at, health, food, oxygen, position, dimension, inventory, heldItem, time };
  };
  return { ...metadata, before: facts(before), after: facts(after) };
}

/** Shared validation for immediate and queued skill execution. Does not allocate an action. */
export function validateSkillRequest(code, { name, input = {}, worldId } = {}) {
  if (typeof code !== 'string') throw new Error('Skill code must be a string');
  if (typeof name !== 'string' || /\p{Cc}/u.test(name) || !name.trim()) {
    throw new Error('Skill name is required (nonempty, no control characters)');
  }
  name = name.trim();
  if (typeof worldId !== 'string' || !worldId) throw new Error('worldId is required');
  const request = { type: 'start', code, input, worldId };
  if (Buffer.byteLength(JSON.stringify(request)) + 1 > MAX_FRAME_BYTES) {
    throw Object.assign(new Error('Action exceeds the 1 MiB sandbox frame limit'), { code: 'SANDBOX_FRAME_LIMIT' });
  }
  return { name, request };
}

/** Async action handles. The returned value of generated code is untrusted, not verification. */
export class SkillSandbox {
  constructor({ rpc, socketPath = '/run/minecraft-player-sandbox/broker.sock', timeoutMs = 120_000, historyDirectory = mkdtempSync(join(tmpdir(), 'minecraft-action-history-')), onEvent = () => {} }) {
    this.rpc = rpc;
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.onEvent = onEvent;
    this.historyDirectory = historyDirectory;
    mkdirSync(historyDirectory, { recursive: true });
    // Only the active action lives in memory. Completed originals are read on demand.
    this.actions = new Map();
    this.activeId = null;
  }

  start(code, options = {}) {
    if (this.activeId) throw new Error(`Action "${this.actions.get(this.activeId).action.name}" is still running`);
    const { name, request } = validateSkillRequest(code, options);
    const { worldId } = request;
    const id = randomUUID();
    const directory = join(this.historyDirectory, id);
    mkdirSync(directory);
    const action = { id, name, worldId, sourceHash: createHash('sha256').update(code).digest('hex'), state: 'running', settled: false, startedAt: new Date().toISOString(), callCount: 0, calls: [], waitingOnly: true,
      history: { directory, calls: 'calls.jsonl', originals: 'action.json', projection: 'status metadata and action return value; complete original calls/args/results are on disk, available through inspect' } };
    writeFileSync(join(directory, 'request.json'), JSON.stringify(request));
    writeFileSync(join(directory, 'calls.jsonl'), '');
    writeJson(join(directory, 'action.json'), action);
    writeJson(join(directory, 'status.json'), statusProjection(action));
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const record = { action, promise, controller: new AbortController(), resolve };
    this.actions.set(id, record);
    this.activeId = id;
    queueMicrotask(() => this.launch(record, request));
    return id;
  }

  launch(record, request) {
    if (record.action.state !== 'running') return;
    try {
      record.action.before = this.rpc.observe();
      this.persist(record);
      const socket = createConnection(this.socketPath);
      record.socket = socket;
      record.timer = setTimeout(() => this.finish(record, 'failed', { error: 'Skill execution deadline exceeded' }), this.timeoutMs);
      socket.on('connect', () => {
        if (record.action.state !== 'running') return;
        try { sendFrame(socket, request); } catch (error) { this.finish(record, 'failed', { error: error.message }); }
      });
      readFrames(socket, message => {
        if (record.action.state !== 'running') return;
        if (message.type === 'rpc') {
          if (record.inFlight) throw new Error('Concurrent Minecraft RPC is not permitted');
          record.inFlight = true;
          void this.dispatch(record, message);
        } else if (message.type === 'result' && !record.inFlight) {
          this.finish(record, 'completed', { value: message.value });
        } else if (message.type === 'error' && !record.inFlight) {
          this.finish(record, 'failed', { error: String(message.error) });
        } else {
          throw new Error('Unexpected sandbox response');
        }
      }, error => this.finish(record, 'failed', { error: error.message }));
      socket.on('close', () => {
        if (record.action.state === 'running') this.finish(record, 'failed', { error: 'Sandbox connection closed before result' });
        else if (record.pendingCompletion) {
          record.pendingCompletion = false;
          if (!record.inFlight) this.release(record);
        }
      });
      this.onEvent({ type: 'action-start', action: this.status(record.action.id) });
    } catch (error) {
      this.finish(record, 'failed', { error: error.message });
    }
  }

  async dispatch(record, message) {
    const call = { method: message.method, args: message.args, startedAt: new Date().toISOString() };
    const index = ++record.action.callCount;
    record.action.waitingOnly &&= ['observe', 'waitTicks', 'blockAt'].includes(call.method);
    appendFileSync(join(record.action.history.directory, 'calls.jsonl'), JSON.stringify({ type: 'start', index, call }) + '\n');
    try {
      const value = await this.rpc.call(message.method, message.args, { signal: record.controller.signal });
      call.value = value;
      call.completedAt = new Date().toISOString();
      if (record.action.state === 'running') sendFrame(record.socket, { type: 'reply', id: message.id, value });
    } catch (error) {
      call.error = error.message;
      if (record.action.state === 'running') {
        try { sendFrame(record.socket, { type: 'reply', id: message.id, error: error.message }); }
        catch (sendError) { this.finish(record, 'failed', { error: sendError.message }); }
      }
    } finally {
      call.completedAt ??= new Date().toISOString();
      appendFileSync(join(record.action.history.directory, 'calls.jsonl'), JSON.stringify({ type: 'result', index, call }) + '\n');
      if (call.error) {
        const key = rpcFailureKey(call.method, call.args);
        record.action.failureStreak = { key, count: record.action.failureStreak?.key === key ? record.action.failureStreak.count + 1 : 1 };
      } else {
        record.action.failureStreak = null;
      }
      record.inFlight = false;
      this.onEvent({ type: 'rpc-result', actionId: record.action.id, actionName: record.action.name, call });
      if (record.action.state !== 'running' && !record.pendingCompletion) this.release(record);
    }
  }

  finish(record, state, result) {
    if (record.action.state !== 'running') return;
    record.action.state = state;
    clearTimeout(record.timer);
    record.controller.abort();
    // Also stop Mineflayer operations; killing the isolated JS cannot stop host-side goto/dig.
    try { this.rpc.cancel(); }
    catch (error) { record.action.stopError = error.message; }
    if (record.socket && !record.socket.destroyed) {
      try { sendFrame(record.socket, { type: 'cancel' }); } catch {}
      record.socket.end();
      record.pendingCompletion = state !== 'completed';
    }
    Object.assign(record.action, result, { completedAt: new Date().toISOString() });
    try { record.action.after = this.rpc.observe(); }
    catch (error) { record.action.observationError = error.message; }
    this.persist(record);
    if (!record.pendingCompletion && !record.inFlight) this.release(record);
  }

  persist(record) {
    writeJson(join(record.action.history.directory, 'action.json'), record.action);
    writeJson(join(record.action.history.directory, 'status.json'), statusProjection(record.action));
  }

  release(record) {
    if (record.released) return;
    record.released = true;
    record.action.settled = true;
    // A cancelled host RPC can settle after the worker exits. Evidence is final only here.
    try { record.action.after = this.rpc.observe(); }
    catch (error) { record.action.observationError = error.message; }
    record.pendingCompletion = false;
    if (this.activeId === record.action.id) this.activeId = null;
    this.persist(record);
    const outcome = structuredClone(record.action);
    // Events carry trusted before/after and the action return value, never accumulated calls.
    this.actions.delete(record.action.id);
    record.resolve();
    this.onEvent({ type: 'action-end', action: outcome });
    record.action = statusProjection(record.action);
  }

  status(id) {
    const record = this.actions.get(id);
    if (record) return structuredClone(statusProjection(record.action));
    return JSON.parse(readFileSync(this.historyFile(id, 'status.json'), 'utf8'));
  }

  historyFile(id, file) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Unknown action: ${id}`);
    return join(this.historyDirectory, id, file);
  }

  inspect(id) {
    const record = this.actions.get(id);
    const action = record ? structuredClone(record.action) : JSON.parse(readFileSync(this.historyFile(id, 'action.json'), 'utf8'));
    const calls = new Map();
    for (const line of readFileSync(this.historyFile(id, 'calls.jsonl'), 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      calls.set(entry.index, entry.call);
    }
    action.calls = [...calls.values()];
    return action;
  }

  async wait(id, { details = true } = {}) {
    const record = this.actions.get(id);
    if (record) await record.promise;
    return details ? this.inspect(id) : this.status(id);
  }

  cancel(id = this.activeId, reason = 'Cancelled by runtime') {
    if (id === null) return null;
    const record = this.actions.get(id);
    if (!record) return this.status(id);
    this.finish(record, 'cancelled', { error: reason });
    return this.status(id);
  }
}
