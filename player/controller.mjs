import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Script } from 'node:vm';
import { SkillSandbox, validateSkillRequest } from './sandbox.mjs';
import { atomicJson, optionalJson } from './observations.mjs';

const timestamp = () => new Date().toISOString();
const clone = value => structuredClone(value);
const staleVersion = message => Object.assign(new Error(message), { code: 'CONTROLLER_STALE_VERSION' });

function boundedJson(value, bytes, label) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > bytes) throw new Error(`${label} must be JSON of at most ${bytes} bytes`);
  return JSON.parse(json);
}

// Runs INSIDE the existing OS sandbox. The VM narrows the controller API; it is
// not the security boundary. No Minecraft object or RPC is passed to the VM.
export function controllerRunner(code) {
  if (typeof code !== 'string' || Buffer.byteLength(code) > 20_480) throw new Error('Controller source must be at most 20 KiB');
  const entryMarker = `__controllerEntry_${randomUUID().replaceAll('-', '')}`;
  let source;
  for (const match of code.matchAll(/\bexport\s+async\s+function\s+decide\s*\(/g)) {
    const candidate = code.slice(0, match.index) + `const ${entryMarker} = true; ` + code.slice(match.index + 'export'.length);
    try {
      // Parsing does not execute candidate code. Trying each match avoids treating
      // an example declaration inside a comment/string as the actual entrypoint.
      new Script(candidate);
      source = candidate;
      break;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  if (source === undefined) throw new Error('Controller must export async function decide(observation, state, lastResult) with valid script syntax');
  return `
const vm = await import('node:vm');
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const source = ${JSON.stringify(source)};
// JSON is parsed inside the realm: no host functions/prototypes cross into it.
new vm.Script('globalThis.args = JSON.parse(' + JSON.stringify(JSON.stringify(input)) + ')').runInContext(context, { timeout: 250 });
new vm.Script(source + '\\n;if (typeof ${entryMarker} === "undefined") throw new Error("Missing exported decide entrypoint"); globalThis.answer = decide(args.observation, args.state, args.lastResult);').runInContext(context, { timeout: 500 });
await context.answer;
context.awaitedAnswer = await context.answer;
const encoded = new vm.Script('JSON.stringify(awaitedAnswer)').runInContext(context, { timeout: 250 });
if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 49152) throw new Error('Controller output exceeds JSON budget');
const result = JSON.parse(encoded);
if (result.action && typeof result.action.code === 'string') new vm.Script('(async function(mc,input){"use strict";\\n' + result.action.code + '\\n})');
return result;
`;
}

export function validateControllerResult(value, worldId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'state')) throw new Error('Controller must return {state, action}');
  const state = boundedJson(value.state, 8192, 'Controller state');
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Controller state must be an object');
  if (value.action === null) {
    if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500) throw new Error('Idle decision requires a reason (1–500 characters)');
    const wakeAfterMs = value.wakeAfterMs ?? 1000;
    if (!Number.isSafeInteger(wakeAfterMs) || wakeAfterMs < 100 || wakeAfterMs > 60_000) throw new Error('Idle wakeAfterMs must be 100–60000');
    return { state, action: null, reason: value.reason, wakeAfterMs };
  }
  const action = value.action;
  if (!action || typeof action !== 'object') throw new Error('Controller must return action or explicit null idle');
  const { name } = validateSkillRequest(action.code, { name: action.name, input: action.input ?? {}, worldId });
  return { state, action: { name, code: action.code, input: boundedJson(action.input ?? {}, 16_384, 'Action input') } };
}

export class PersistentController {
  constructor({ directory, worldId, sandbox, socketPath = sandbox?.socketPath, timeoutMs = 3000, onEvent = () => {}, isActionActive = () => Boolean(sandbox?.activeId) }) {
    if (!/^[a-z0-9-]{1,128}$/.test(worldId ?? '')) throw new Error('Controller worldId must be a safe world identifier');
    this.worldId = worldId;
    this.file = path.join(directory, worldId, 'controller.json');
    this.onEvent = onEvent;
    this.isActionActive = isActionActive;
    this.busy = false;
    // A separate handle avoids gameplay callbacks, observations and cancellation.
    // It deliberately uses the SAME root-owned broker and OS-isolation boundary.
    this.sandbox = new SkillSandbox({ socketPath, timeoutMs, rpc: {
      observe: () => ({ worldId }),
      call: async () => { throw new Error('Controller decisions and offline validation cannot call Minecraft RPC'); },
      cancel() {},
    } });
    this.writeTail = Promise.resolve();
  }

  async open() {
    this.data = await optionalJson(this.file, { worldId: this.worldId, activeVersion: null, state: {}, versions: [] });
    if (this.data.worldId !== this.worldId) throw new Error('Controller storage world mismatch');
    // A process may have died during validation. Never promote an unfinished test.
    for (const version of this.data.versions) {
      if (['candidate', 'validating', 'validated'].includes(version.status) && !Object.hasOwn(version, 'baseVersion')) {
        version.status = 'superseded';
        version.error = 'Pending controller has no recorded base version';
        version.errorCode = 'CONTROLLER_STALE_VERSION';
      } else if (version.status === 'validating') {
        version.status = 'failed';
        version.error = 'Validation interrupted by restart';
      }
    }
    await this.save();
    return this;
  }

  async save() {
    const snapshot = clone(this.data);
    const write = this.writeTail.then(() => atomicJson(this.file, snapshot));
    this.writeTail = write;
    await write;
  }

  current() {
    const record = this.data.versions.find(item => item.version === this.data.activeVersion);
    return record ? clone(record) : null;
  }

  inspect(version) {
    if (version) return clone(this.record(version));
    return clone({ worldId: this.worldId, activeVersion: this.data.activeVersion, state: this.data.state, busy: this.busy, error: this.data.error ?? null, lastDecision: this.data.lastDecision ?? null, versions: this.data.versions });
  }

  record(version) {
    const record = this.data.versions.find(item => item.version === version);
    if (!record) throw new Error(`Unknown controller version: ${version}`);
    return record;
  }

  async candidate({ name, code, fixtures, baseVersion = this.data.activeVersion, analysis }) {
    if (baseVersion !== this.data.activeVersion) throw staleVersion('Controller candidate base version is not the active version');
    controllerRunner(code);
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Controller name is required (1–80 characters)');
    if (!Array.isArray(fixtures) || fixtures.length < 2 || fixtures.length > 8) throw new Error('Provide 2–8 offline fixtures');
    fixtures = boundedJson(fixtures, 131_072, 'Controller fixtures');
    for (const fixture of fixtures) {
      if (!fixture || typeof fixture.observation !== 'object' || !fixture.observation) throw new Error('Each fixture requires an observation');
    }
    const record = { version: randomUUID(), name: name.trim(), code, fixtures, baseVersion: this.data.activeVersion, sourceHash: createHash('sha256').update(code).digest('hex'), status: 'candidate', createdAt: timestamp() };
    if (analysis !== undefined) record.analysis = boundedJson(analysis, 8192, 'Controller analysis metadata');
    this.data.versions.push(record);
    await this.save();
    return clone(record);
  }

  boundary() {
    if (this.busy || this.isActionActive()) throw Object.assign(new Error('Controller operation requires a drained action/decision boundary'), { code: 'CONTROLLER_BOUNDARY_BUSY' });
  }

  async run(code, observation, state, lastResult) {
    const input = boundedJson({ observation, state, lastResult: lastResult ?? null }, 16_384, 'Decision input');
    const id = this.sandbox.start(controllerRunner(code), { name: 'controller: decide', input, worldId: this.worldId });
    const result = await this.sandbox.wait(id);
    if (result.state !== 'completed') throw new Error(result.error ?? 'Controller sandbox failed');
    return validateControllerResult(result.value, this.worldId);
  }

  async validate(version) {
    this.boundary();
    const record = this.record(version);
    if (record.version === this.data.activeVersion) throw new Error('Cannot validate the active controller');
    if (record.status === 'superseded') throw staleVersion(record.error);
    this.busy = true;
    try {
      record.status = 'validating';
      delete record.error;
      await this.save();
      const results = [];
      for (const fixture of record.fixtures) {
        const output = await this.run(record.code, fixture.observation, fixture.state ?? {}, fixture.lastResult);
        results.push({ action: output.action?.name ?? null, reason: output.reason ?? null });
      }
      record.status = 'validated';
      record.validation = { at: timestamp(), results };
      this.onEvent({ type: 'controller-validated', version });
    } catch (error) {
      record.status = 'failed';
      record.error = error.message;
      this.onEvent({ type: 'controller-error', version, error: error.message });
    } finally {
      this.busy = false;
      await this.save();
    }
    return clone(record);
  }

  async activate(version) {
    this.boundary();
    const record = this.record(version);
    if (record.status === 'superseded') throw staleVersion(record.error);
    if (record.status !== 'validated') throw new Error('Only a validated candidate can be activated');
    this.busy = true;
    try {
      if (!Object.hasOwn(record, 'baseVersion') || record.baseVersion !== this.data.activeVersion) {
        record.status = 'superseded';
        record.error = 'Controller candidate base version is no longer active';
        record.errorCode = 'CONTROLLER_STALE_VERSION';
        await this.save();
        throw staleVersion(record.error);
      }
      const previous = this.current();
      if (previous) this.record(previous.version).status = 'retired';
      record.status = 'active';
      record.activatedAt = timestamp();
      this.data.activeVersion = version;
      await this.save();
      this.onEvent({ type: 'controller-activated', version });
      return this.current();
    } finally {
      this.busy = false;
    }
  }

  async decide(observation, lastResult = null, { isCurrent = () => true } = {}) {
    this.boundary();
    const record = this.current();
    if (!record) throw new Error('No active controller');
    if (observation.worldId !== this.worldId) throw new Error('Decision observation world mismatch');
    this.busy = true;
    let completedRun = false;
    try {
      const result = await this.run(record.code, observation, this.data.state, lastResult);
      completedRun = true;
      if (!isCurrent()) return { discarded: true };
      const previous = clone({ state: this.data.state, lastDecision: this.data.lastDecision, error: this.data.error });
      this.data.state = result.state;
      this.data.lastDecision = { version: record.version, at: timestamp(), session: observation.session, life: observation.life, action: result.action?.name ?? null };
      delete this.data.error;
      await this.save();
      if (!isCurrent()) {
        // Restore controller metadata only: interrupted decisions must not advance
        // phase/state, while concurrent candidate/version writes remain intact.
        Object.assign(this.data, previous);
        await this.save();
        return { discarded: true };
      }
      return result;
    } catch (error) {
      // Cancellation may reject the isolated run after its observation expired.
      // Persistence failures remain visible even if the epoch changed meanwhile.
      if (!completedRun && !isCurrent()) return { discarded: true };
      this.data.error = error.message;
      await this.save();
      this.onEvent({ type: 'controller-error', version: record.version, error: error.message });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async resetState(reason) {
    this.boundary();
    this.busy = true;
    try {
      this.data.state = {};
      this.data.lastReset = { at: timestamp(), reason };
      await this.save();
    } finally {
      this.busy = false;
    }
  }
}
