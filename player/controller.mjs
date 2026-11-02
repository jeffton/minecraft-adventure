import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Script } from 'node:vm';
import { parse } from 'acorn';
import { readFile } from 'node:fs/promises';
import { SkillSandbox, validateSkillRequest } from './sandbox.mjs';
import { MAX_FRAME_BYTES } from './sandbox-protocol.mjs';
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
  if (typeof code !== 'string') throw new Error('Controller source must be a string');
  const entryMarker = `__controllerEntry_${randomUUID().replaceAll('-', '')}`;
  const module = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const entry = module.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === 'decide' && node.declaration.async && !node.declaration.generator);
  if (!entry) throw new Error('Controller must export async function decide(observation, state, lastResult)');
  const nodes = [module];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== 'object') continue;
    if (['ImportDeclaration', 'ImportExpression'].includes(node.type) || (node.type === 'MetaProperty' && node.meta.name === 'import')) throw new Error('Controller imports are not available in the isolated decision API');
    nodes.push(...Object.values(node).filter(value => value && typeof value === 'object').flat());
  }
  const source = code.slice(0, entry.start) + `const ${entryMarker} = true; ` + code.slice(entry.declaration.start);
  // Compile only: never execute generated module initialization in the host.
  new Script(source);
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
if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > ${MAX_FRAME_BYTES}) throw new Error('Controller output exceeds JSON budget');
const result = JSON.parse(encoded);
if (result.action && typeof result.action.code === 'string') new vm.Script('(async function(mc,input){"use strict";\\n' + result.action.code + '\\n})');
return result;
`;
}

export function validateControllerResult(value, worldId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'state')) throw new Error('Controller must return {state, action}');
  const state = boundedJson(value.state, MAX_FRAME_BYTES, 'Controller state');
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Controller state must be an object');
  if (value.action === null) {
    if (typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('Idle decision requires a nonempty reason');
    const wakeAfterMs = value.wakeAfterMs ?? 1000;
    if (!Number.isSafeInteger(wakeAfterMs) || wakeAfterMs < 0) throw new Error('Idle wakeAfterMs must be a nonnegative safe integer');
    return { state, action: null, reason: value.reason, wakeAfterMs };
  }
  const action = value.action;
  if (!action || typeof action !== 'object') throw new Error('Controller must return action or explicit null idle');
  const { name } = validateSkillRequest(action.code, { name: action.name, input: action.input ?? {}, worldId });
  return { state, action: { name, code: action.code, input: boundedJson(action.input ?? {}, MAX_FRAME_BYTES, 'Action input') } };
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
    this.sandbox = new SkillSandbox({ socketPath, timeoutMs, historyDirectory: path.join(path.dirname(this.file), 'decisions'), rpc: {
      observe: () => ({ worldId }),
      call: async () => { throw new Error('Controller decisions cannot call Minecraft RPC directly'); },
      cancel() {},
    } });
    this.writeTail = Promise.resolve();
  }

  async open() {
    this.data = await optionalJson(this.file, { worldId: this.worldId, activeVersion: null, state: {}, versions: [] });
    if (this.data.worldId !== this.worldId) throw new Error('Controller storage world mismatch');
    // Preserve old records, but do not promote obsolete fixture-gated candidates.
    for (const version of this.data.versions) {
      if (['candidate', 'validating', 'validated'].includes(version.status)) {
        version.status = 'superseded';
        version.error = 'Pending source predates immediate hot-reload admission; submit a fresh version-aware edit';
        version.errorCode = 'CONTROLLER_STALE_VERSION';
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
    return clone({ worldId: this.worldId, activeVersion: this.data.activeVersion, state: this.data.state, busy: this.busy, error: this.data.error ?? null, feedbackFailure: this.data.feedbackFailure ?? null, lastDecision: this.data.lastDecision ?? null, versions: this.data.versions });
  }

  record(version) {
    const record = this.data.versions.find(item => item.version === version);
    if (!record) throw new Error(`Unknown controller version: ${version}`);
    return record;
  }

  editedSource(baseVersion, edits) {
    if (!baseVersion || baseVersion !== this.data.activeVersion) throw staleVersion('Controller edit requires the active inspected base version');
    if (!Array.isArray(edits) || !edits.length) throw new Error('Provide nonempty exact source edits');
    const source = this.record(baseVersion).code;
    const replacements = edits.map(({ oldText, newText }) => {
      if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') throw new Error('Each edit requires nonempty oldText and string newText');
      const start = source.indexOf(oldText);
      if (start < 0 || source.indexOf(oldText, start + 1) >= 0) throw new Error('Each oldText must match exactly once in the original source');
      return { start, end: start + oldText.length, newText };
    }).sort((a, b) => a.start - b.start);
    let result = '';
    let end = 0;
    for (const replacement of replacements) {
      if (replacement.start < end) throw new Error('Source edits must not overlap; all match the original version');
      result += source.slice(end, replacement.start) + replacement.newText;
      end = replacement.end;
    }
    result += source.slice(end);
    if (result === source) throw new Error('Source edits must change the controller');
    return result;
  }

  async candidate({ name, code, edits, baseVersion = this.data.activeVersion, analysis }) {
    if (baseVersion !== this.data.activeVersion) throw staleVersion('Controller candidate base version is not the active version');
    if (edits !== undefined) {
      if (code !== undefined) throw new Error('Provide source or edits, not both');
      code = this.editedSource(baseVersion, edits);
    }
    validateSkillRequest(controllerRunner(code), { name, worldId: this.worldId });
    if (typeof name !== 'string' || !name.trim()) throw new Error('Controller name is required');
    const record = { version: randomUUID(), name: name.trim(), code, baseVersion: this.data.activeVersion, sourceHash: createHash('sha256').update(code).digest('hex'), status: 'admitted', createdAt: timestamp() };
    if (edits !== undefined) record.edits = clone(edits);
    if (analysis !== undefined) record.analysis = clone(analysis);
    this.data.versions.push(record);
    await this.save();
    return clone(record);
  }

  boundary() {
    if (this.busy || this.isActionActive()) throw Object.assign(new Error('Controller operation requires a drained action/decision boundary'), { code: 'CONTROLLER_BOUNDARY_BUSY' });
  }

  decisionRequest(code, observation, state, lastResult) {
    const input = { observation, state, lastResult: lastResult ?? null };
    const source = controllerRunner(code);
    validateSkillRequest(source, { name: 'controller: decide', input, worldId: this.worldId });
    return { source, input };
  }

  async inspectFeedback(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid controller feedback reference');
    return JSON.parse(await readFile(path.join(path.dirname(this.file), 'feedback', `${id}.json`), 'utf8'));
  }

  async run(code, observation, state, lastResult) {
    const { source, input } = this.decisionRequest(code, observation, state, lastResult);
    const id = this.sandbox.start(source, { name: 'controller: decide', input, worldId: this.worldId });
    const result = await this.sandbox.wait(id, { details: false });
    if (result.state !== 'completed') throw new Error(result.error ?? 'Controller sandbox failed');
    return validateControllerResult(result.value, this.worldId);
  }

  async activate(version) {
    this.boundary();
    const record = this.record(version);
    if (record.status === 'superseded') throw staleVersion(record.error);
    if (record.status !== 'admitted') throw new Error('Only admitted source can be activated');
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
      let admittedFeedback = lastResult;
      try {
        this.decisionRequest(record.code, observation, this.data.state, lastResult);
      } catch (error) {
        if (error.code !== 'SANDBOX_FRAME_LIMIT' || !lastResult) throw error;
        // This is a rejected transport admission, not a successful result with
        // silently shortened data. Preserve the full original for engineering.
        const feedbackHash = createHash('sha256').update(JSON.stringify(lastResult)).digest('hex');
        const previousFailure = this.data.feedbackFailure;
        const retained = previousFailure?.id === lastResult.id && previousFailure?.feedbackHash === feedbackHash;
        const feedbackId = retained ? previousFailure.feedbackId : randomUUID();
        admittedFeedback = {
          id: lastResult.id, name: lastResult.name, state: 'failed',
          errorCode: 'CONTROLLER_FEEDBACK_TOO_LARGE',
          error: 'Action feedback cannot fit the complete decision frame. Request smaller query results; the original is retained for controller_inspect({feedbackId}).',
          feedbackId, feedbackHash,
        };
        this.decisionRequest(record.code, observation, this.data.state, admittedFeedback);
        if (!retained) {
          await atomicJson(path.join(path.dirname(this.file), 'feedback', `${feedbackId}.json`), lastResult);
          this.data.feedbackFailure = admittedFeedback;
          await this.save();
          this.onEvent({ type: 'controller-feedback-rejected', ...admittedFeedback });
        }
      }
      const result = await this.run(record.code, observation, this.data.state, admittedFeedback);
      completedRun = true;
      if (!isCurrent()) return { discarded: true };
      // Do not persist state that cannot cross the next complete decision frame.
      // A rejected state leaves the previous planning state available for repair.
      this.decisionRequest(record.code, observation, result.state, null);
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
