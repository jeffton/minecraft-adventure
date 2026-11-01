import { createConnection } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { readFrames, sendFrame } from './sandbox-protocol.mjs';

/** Async action handles. The returned value of generated code is untrusted, not verification. */
export class SkillSandbox {
  constructor({ rpc, socketPath = '/run/minecraft-player-sandbox/broker.sock', timeoutMs = 120_000, onEvent = () => {} }) {
    this.rpc = rpc;
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.onEvent = onEvent;
    this.actions = new Map();
    this.activeId = null;
  }

  start(code, { name, input = {}, worldId } = {}) {
    if (this.activeId) throw new Error(`Action "${this.actions.get(this.activeId).action.name}" is still running`);
    if (typeof code !== 'string' || Buffer.byteLength(code) > 32_768) throw new Error('Skill code must be at most 32 KiB');
    if (typeof name !== 'string' || /\p{Cc}/u.test(name) || !name.trim() || name.trim().length > 80) {
      throw new Error('Skill name is required (1–80 trimmed characters, no control characters)');
    }
    name = name.trim();
    if (typeof worldId !== 'string' || !worldId || worldId.length > 128) throw new Error('worldId is required (maximum 128 characters)');
    // Validate before creating a connection; serialization errors must remain visible.
    const request = { type: 'start', code, input, worldId };
    if (Buffer.byteLength(JSON.stringify(request)) > 65_536) throw new Error('Action exceeds frame limit');
    const id = randomUUID();
    const action = { id, name, worldId, sourceHash: createHash('sha256').update(code).digest('hex'), state: 'running', settled: false, startedAt: new Date().toISOString(), callCount: 0, calls: [] };
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const record = { action, promise, controller: new AbortController(), resolve };
    this.actions.set(id, record);
    this.activeId = id;
    for (const [key, entry] of this.actions) {
      if (this.actions.size <= 32) break;
      if (entry.action.state !== 'running') this.actions.delete(key);
    }
    queueMicrotask(() => this.launch(record, request));
    return id;
  }

  launch(record, request) {
    if (record.action.state !== 'running') return;
    try {
      record.action.before = this.rpc.observe();
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
        else if (record.pendingCompletion) this.release(record);
      });
      this.onEvent({ type: 'action-start', action: this.status(record.action.id) });
    } catch (error) {
      this.finish(record, 'failed', { error: error.message });
    }
  }

  async dispatch(record, message) {
    const call = { method: message.method, args: message.args, startedAt: new Date().toISOString() };
    record.action.callCount++;
    record.action.calls.push(call);
    if (record.action.calls.length > 32) record.action.calls.shift();
    try {
      if (record.action.callCount > 1024) throw new Error('Minecraft RPC call budget exceeded');
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
      record.inFlight = false;
      this.onEvent({ type: 'rpc-result', actionId: record.action.id, actionName: record.action.name, call: structuredClone(call) });
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
    if (!record.pendingCompletion) this.release(record);
  }

  release(record) {
    record.action.settled = true;
    record.pendingCompletion = false;
    if (this.activeId === record.action.id) this.activeId = null;
    const outcome = this.status(record.action.id);
    record.resolve(outcome);
    this.onEvent({ type: 'action-end', action: outcome });
  }

  status(id) {
    const record = this.actions.get(id);
    if (!record) throw new Error(`Unknown action: ${id}`);
    return structuredClone(record.action);
  }

  wait(id) {
    const record = this.actions.get(id);
    if (!record) throw new Error(`Unknown action: ${id}`);
    return record.promise;
  }

  cancel(id = this.activeId, reason = 'Cancelled by runtime') {
    if (id === null) return null;
    const record = this.actions.get(id);
    if (!record) throw new Error(`Unknown action: ${id}`);
    this.finish(record, 'cancelled', { error: reason });
    return this.status(id);
  }
}
