import { validateSkillRequest } from './sandbox.mjs';

/** One current action and one agent-authored continuation, never a second controller. */
export class ActionPipeline {
  constructor({ sandbox, worldId, context, onEvent }) {
    this.sandbox = sandbox;
    this.worldId = worldId;
    this.context = context;
    this.onEvent = onEvent;
    this.latestId = null;
    this.continuationId = null;
    this.next = null;
  }

  current() { return this.latestId ? this.sandbox.status(this.latestId) : null; }

  validate(program) {
    const current = this.context();
    if (current.stopping || current.draining || current.health <= 0) throw new Error('Player cannot act in this state');
    if (current.reflexOwner) throw new Error(`Local safety owns control: ${current.reflexOwner}`);
    if (program.session !== current.session || program.life !== current.life) throw new Error('Player context changed: observe before acting');
    const { name } = validateSkillRequest(program.code, { ...program, worldId: this.worldId });
    return { ...program, name, input: program.input ?? {} };
  }

  start({ next, ...program }) {
    // Validate the whole pair before starting any physical work.
    const continuation = next ? this.validate({ ...next, session: program.session, life: program.life }) : null;
    if (this.next) throw new Error('A next skill is already queued');
    const ready = this.validate(program);
    const previous = this.current();
    const id = this.sandbox.start(ready.code, { name: ready.name, input: ready.input, worldId: this.worldId });
    this.latestId = id;
    this.continuationId = id;
    this.onEvent('skill_started', `Started ${ready.name}.`, {
      actionId: id, skillName: ready.name,
      previousActionId: previous?.id,
      gapMs: previous?.settled ? Date.now() - Date.parse(previous.completedAt) : null,
    });
    if (continuation) this.next = { ...continuation, afterAction: id };
    return { actionId: id, name: ready.name, worldId: this.worldId, life: ready.life, nextSkill: continuation?.name ?? null };
  }

  queue({ afterAction, ...program }) {
    const ready = this.validate(program);
    if (this.next) throw new Error('One next skill is already queued');
    const previous = this.current();
    if (!previous || previous.id !== afterAction || this.continuationId !== afterAction) throw new Error('Continuation is obsolete or does not refer to the latest uninterrupted action');
    if (!['running', 'completed'].includes(previous.state)) throw new Error('The previous skill failed or was interrupted; observe before acting');
    // The predecessor may finish while the model writes this continuation.
    if (previous.state === 'completed' && previous.settled) {
      const started = this.start(ready);
      this.onEvent('pipeline', `Started ${ready.name} after ${previous.name}.`, { ...started, afterAction, gapMs: Date.now() - Date.parse(previous.completedAt), lateContinuation: true });
      return { ...started, queued: false, started: true };
    }
    this.next = { ...ready, afterAction };
    return { queued: true, name: ready.name, afterAction };
  }

  completed(result) {
    if (!this.next || this.next.afterAction !== result.id) return;
    const next = this.next;
    this.next = null;
    if (result.state !== 'completed') {
      this.onEvent('pipeline', `Discarded ${next.name} after ${result.name} was ${result.state}.`, { afterAction: result.id, skillName: next.name });
      return;
    }
    try {
      const started = this.start(next);
      this.onEvent('pipeline', `Started ${next.name} after ${result.name}.`, { ...started, afterAction: result.id, gapMs: Date.now() - Date.parse(result.completedAt), lateContinuation: false });
    } catch (error) {
      this.onEvent('error', `Could not start ${next.name}: ${error.message}`, { afterAction: result.id, skillName: next.name });
    }
  }

  clear() { this.next = null; this.continuationId = null; }
}
