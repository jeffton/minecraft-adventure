import { createHash } from 'node:crypto';
import { actionFeedback, observationFeedback } from './feedback.mjs';

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

/** Exact input budget: omitted untrusted payloads remain explicit, never claimed successful. */
export function budgetControllerInput(observation, state, lastResult) {
  const input = { observation: structuredClone(observation), state, lastResult: structuredClone(lastResult) };
  if (typeof input.lastResult?.error === 'string' && Buffer.byteLength(input.lastResult.error) > 1024) {
    const original = input.lastResult.error;
    input.lastResult.error = 'Action failed; error text exceeds the controller feedback budget.';
    input.lastResult.errorOmitted = { bytes: Buffer.byteLength(original), sha256: createHash('sha256').update(original).digest('hex') };
  }
  if (input.lastResult?.value !== undefined && jsonBytes(input) > 16384) {
    const encoded = JSON.stringify(input.lastResult.value);
    input.lastResult.value = { omitted: true, reason: 'Action result exceeds the controller input budget; return a smaller query summary.',
      bytes: Buffer.byteLength(encoded), sha256: createHash('sha256').update(encoded).digest('hex') };
  }
  while (jsonBytes(input) > 16384 && (input.observation.blocks.length || input.observation.entities.length)) {
    if (input.observation.blocks.length) input.observation.blocks.pop();
    else input.observation.entities.pop();
  }
  input.observation.sensorWindow.blocks = input.observation.blocks.length;
  input.observation.sensorWindow.entities = input.observation.entities.length;
  if (jsonBytes(input) > 16384) throw new Error('Controller state and essential facts exceed the 16 KiB input budget');
  return { observation: input.observation, lastResult: input.lastResult };
}

/** A realtime scheduler, independent of model requests. It owns no gameplay policy. */
export class ControllerLoop {
  constructor({ controller, pipeline, observe, context, onEvent = () => {} }) {
    Object.assign(this, { controller, pipeline, observe, context, onEvent });
    this.pending = [];
    this.nextAt = 0;
    this.epoch = 0;
    this.interruption = null;
  }

  stage(record) {
    this.pending.push(record.version);
    return { version: record.version, status: 'pending_validation' };
  }

  invalidate(reason) {
    this.epoch++;
    this.nextAt = 0;
    this.interruption = { reason, epoch: this.epoch, at: new Date().toISOString() };
  }

  inspect() {
    return { pending: [...this.pending], nextDecisionAt: this.nextAt, epoch: this.epoch };
  }

  async tick(now = Date.now()) {
    const context = this.context();
    if (this.busy || context.stopping || context.reflexOwner || context.health <= 0 ||
        this.pipeline.current()?.settled === false || now < this.nextAt) return;
    this.busy = true;
    const epoch = this.epoch;
    try {
      const version = this.pending.shift();
      if (version) {
        try {
          const stored = this.controller.inspect(version);
          const candidate = stored.status === 'validated' ? stored : await this.controller.validate(version);
          if (candidate.status !== 'validated') {
            this.onEvent('controller_error', 'Controller candidate rejected.', { version, error: candidate.error });
          } else if (epoch === this.epoch && this.available()) {
            await this.controller.activate(version);
            this.onEvent('controller_activated', 'Activated validated controller between actions.', { version });
          } else {
            this.pending.unshift(version);
            return;
          }
        } catch (error) {
          if (error.code === 'CONTROLLER_BOUNDARY_BUSY' && (epoch !== this.epoch || !this.available())) {
            this.pending.unshift(version);
            return;
          }
          throw error;
        }
      }
      if (!this.controller.current() || epoch !== this.epoch || !this.available()) return;
      const observation = this.snapshot();
      const outcome = actionFeedback(this.pipeline.current());
      const lastResult = outcome && {
        id: outcome.id, name: outcome.name, state: outcome.state, error: outcome.error,
        effects: outcome.effects, value: outcome.untrustedValue,
      };
      const budgeted = budgetControllerInput(observation, this.controller.inspect().state, lastResult);
      if (budgeted.lastResult?.value?.omitted) this.onEvent('controller_feedback', budgeted.lastResult.value.reason, budgeted.lastResult.value);
      const decision = await this.controller.decide(budgeted.observation, budgeted.lastResult, {
        isCurrent: () => epoch === this.epoch && this.available(),
      });
      if (decision.discarded || epoch !== this.epoch || !this.available()) {
        this.onEvent('controller_discarded', 'Discarded decision after interruption. Fresh observation required.');
        return;
      }
      if (decision.action) {
        const current = this.context();
        this.pipeline.start({ ...decision.action, life: current.life, session: current.session });
        this.onEvent('controller_action', decision.action.name, { version: this.controller.current().version });
      } else {
        this.nextAt = Date.now() + decision.wakeAfterMs;
        this.onEvent('controller_idle', decision.reason, { wakeAfterMs: decision.wakeAfterMs });
      }
    } finally {
      this.busy = false;
    }
  }

  snapshot() {
    const fresh = this.context();
    const observed = observationFeedback(this.observe());
    // A bounded sensor window, not the explored-world store.
    return {
      ...observed, worldId: fresh.worldId, session: fresh.session, life: fresh.life, interruption: this.interruption,
      inventory: observed.inventory.map(({ name, count }) => ({ name, count })),
      blocks: observed.blocks.slice(0, 24), entities: observed.entities.slice(0, 16),
      sensorWindow: { blocks: 24, entities: 16, queries: 'Use RPC for larger read-only queries in an action.' },
    };
  }

  available() {
    const context = this.context();
    return !context.stopping && !context.reflexOwner && context.health > 0 &&
      this.pipeline.current()?.settled !== false;
  }
}
