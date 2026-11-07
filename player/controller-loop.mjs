import { actionFeedback, observationFeedback } from './feedback.mjs';

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
    this.nextAt = 0;
    return { version: record.version, status: 'pending_activation' };
  }

  /** Swap admitted source at the first fully drained boundary, not an action deadline. */
  async hotReload(record, interrupt) {
    this.stage(record);
    // A mission may arrive while survival owns movement. Stage it without
    // cancelling that escape; tick activates it when survival releases control.
    if (!this.context().reflexOwner) await interrupt('Controller hot reload');
    await this.tick();
    const { status, error } = this.controller.inspect(record.version);
    return { version: record.version, status, ...(error ? { error } : {}) };
  }

  invalidate(reason) {
    this.epoch++;
    this.nextAt = 0;
    this.interruption = { reason, epoch: this.epoch, at: new Date().toISOString() };
  }

  inspect() {
    return { pending: [...this.pending], nextDecisionAt: this.nextAt, epoch: this.epoch };
  }

  async tick(now = Date.now(), { activateOnly = false } = {}) {
    const context = this.context();
    if (this.busy || context.stopping || context.reflexOwner || context.draining || context.health <= 0 ||
        this.pipeline.current()?.settled === false || now < this.nextAt) return;
    this.busy = true;
    const epoch = this.epoch;
    try {
      const version = this.pending.shift();
      if (version) {
        try {
          const candidate = this.controller.inspect(version);
          if (candidate.status !== 'admitted') {
            this.onEvent('controller_error', 'Controller source was not admitted.', { version, error: candidate.error });
          } else if (epoch === this.epoch && this.available()) {
            await this.controller.activate(version);
            this.onEvent('controller_activated', 'Hot-reloaded compiled controller after control drain.', { version });
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
      if (activateOnly || !this.controller.current() || epoch !== this.epoch || !this.available()) return;
      const observation = this.snapshot();
      const outcome = actionFeedback(this.pipeline.current());
      const lastResult = outcome && {
        id: outcome.id, name: outcome.name, state: outcome.state, error: outcome.error,
        effects: outcome.effects, value: outcome.untrustedValue,
      };
      const decision = await this.controller.decide(observation, lastResult, {
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
        // A finished strategic episode parks until a new mission is staged. Safety
        // reflexes stay independent; do not replay the same script while planning.
        this.nextAt = decision.replan ? Infinity : Date.now() + decision.wakeAfterMs;
        this.onEvent(decision.replan ? 'controller_replan' : 'controller_idle', decision.reason, {
          wakeAfterMs: decision.wakeAfterMs, version: this.controller.current().version,
        });
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
      sensorWindow: { blocks: observed.blocks.length, entities: observed.entities.length, queries: 'Use RPC for larger read-only queries in an action.' },
    };
  }

  available() {
    const context = this.context();
    return !context.stopping && !context.reflexOwner && !context.draining && context.health > 0 &&
      this.pipeline.current()?.settled !== false;
  }
}
