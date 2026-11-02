const clone = value => structuredClone(value);
const tier = count => Math.floor(Math.log(count) / Math.log(4));

/** Coalesced evidence for one background engineer; never a gameplay controller. */
export class EngineeringSignals {
  constructor({ onEvent = () => {}, now = Date.now } = {}) {
    Object.assign(this, { onEvent, now });
    this.records = new Map();
    this.snapshots = new Map();
    this.revision = 0;
    this.busy = false;
    this.active = null;
    this.deliveredKey = null;
    this.streak = null;
    this.materials = new Set();
    this.progress = null;
  }

  notify({ kind, key, details, version = null, life = null, sequence = null, at = this.now() }) {
    const identity = JSON.stringify([kind, key, version, life]);
    let record = this.records.get(identity);
    if (!record) {
      record = { identity, kind, key, version, life, count: 0, tier: -1, revision: 0,
        acknowledged: 0, requestedAt: at };
      this.records.set(identity, record);
    }
    record.count++;
    record.latestAt = at;
    record.sequence = sequence;
    record.details = clone(details);
    const nextTier = tier(record.count);
    if (nextTier > record.tier) {
      // Once consumed, a repeated problem needs materially stronger evidence.
      if (record.revision === record.acknowledged) record.requestedAt = at;
      record.tier = nextTier;
      record.revision = ++this.revision;
      this.onEvent('engineering_requested', 'New controller engineering evidence.', {
        kind, key, version, life, count: record.count, revision: record.revision, at,
      });
    }
    return clone(record);
  }

  feedback() {
    const pending = [...this.records.values()].filter(record => record.revision > record.acknowledged);
    if (!pending.length) return null;
    const key = `engineering:${this.revision}`;
    const batch = {
      key,
      requestedAt: pending.reduce((first, record) =>
        new Date(record.requestedAt).getTime() < new Date(first).getTime() ? record.requestedAt : first,
      pending[0].requestedAt),
      reasons: pending.map(({ acknowledged, ...record }) => clone(record)),
    };
    this.snapshots.set(key, pending.map(record => ({ identity: record.identity, revision: record.revision })));
    return batch;
  }

  inspect() {
    return { busy: this.busy, active: clone(this.active), pending: this.feedback() };
  }

  activated(version) {
    // Retain history and issued snapshots: a job may finish after its patch activates.
    for (const record of this.records.values()) {
      if (record.version !== version) record.acknowledged = record.revision;
    }
    this.streak = null;
  }

  start() {
    if (this.busy) return null;
    const batch = this.feedback();
    if (!batch) return null;
    this.busy = true;
    this.active = { key: batch.key, startedAt: this.now() };
    this.deliveredKey = batch.key;
    this.onEvent('engineering_started', 'Background engineer started.', clone(batch));
    return batch;
  }

  delivered(key) {
    const snapshot = this.snapshots.get(key);
    if (!snapshot) throw new Error(`Unknown engineering feedback snapshot: ${key}`);
    for (const evidence of snapshot) {
      const record = this.records.get(evidence.identity);
      record.acknowledged = Math.max(record.acknowledged, evidence.revision);
    }
    this.deliveredKey = key;
  }

  finish({ feedbackKey = this.deliveredKey, baseVersion, patched = false, failed = false } = {}) {
    if (!this.busy) throw new Error('No background engineering job is active');
    if (feedbackKey) this.delivered(feedbackKey);
    this.onEvent('engineering_finished', 'Background engineer finished.', {
      key: this.active.key, feedbackKey, baseVersion, patched, failed, at: this.now(),
    });
    this.busy = false;
    this.active = null;
    this.deliveredKey = null;
    // Issued snapshots belong to the finished job. Pending records remain intact.
    this.snapshots.clear();
    return this.feedback();
  }

  actionOutcome(result, { version, life, sequence, placedBlocks } = {}) {
    const context = { version, life, sequence, at: result.completedAt ?? this.now() };
    const before = result.before;
    const after = result.after;
    if (result.state === 'failed' || result.state === 'timed_out' || result.state === 'timeout') {
      this.notify({ ...context, kind: 'action_failure',
        key: `${result.name}:${result.error?.split('\n')[0] ?? result.state}`,
        details: { actionId: result.id, name: result.name, state: result.state, error: result.error } });
    }
    if (!before || !after) return;
    const totals = inventory => {
      const counts = new Map();
      for (const item of inventory) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
      return counts;
    };
    const counts = totals(before.inventory);
    for (const name of counts.keys()) this.materials.add(name);
    let acquired = false;
    for (const [name, count] of totals(after.inventory)) {
      if (count > (counts.get(name) ?? 0)) {
        acquired = true;
        if (!this.materials.has(name)) {
          this.notify({ ...context, kind: 'material_discovery', key: name,
            details: { material: name, actionId: result.id } });
        }
      }
      this.materials.add(name);
    }
    const sameDimension = before.dimension === after.dimension;
    const displacement = sameDimension ? Math.hypot(...['x', 'y', 'z'].map(axis =>
      after.position[axis] - before.position[axis])) : Infinity;
    const placed = placedBlocks !== undefined && this.progress?.placedBlocks !== undefined &&
      placedBlocks > this.progress.placedBlocks;
    const productive = acquired || after.food > before.food || placed || displacement >= 2;
    const identity = JSON.stringify([version, life, result.name]);
    if (result.state === 'completed' && !productive) {
      const count = this.streak?.identity === identity ? this.streak.count + 1 : 1;
      this.streak = { identity, count };
      // Feed every repetition after onset into the same coalescing identity.
      if (count >= 4) this.notify({ ...context, kind: 'action_no_effect', key: result.name,
        details: { repetitions: count, displacement, actionId: result.id } });
    } else this.streak = null;
    if (placedBlocks !== undefined) this.progress = { ...this.progress, placedBlocks };
  }

  hostProgress({ deaths, placedBlocks }, context = {}) {
    if (this.progress && deaths > this.progress.deaths) {
      this.notify({ ...context, kind: 'death', key: 'death', details: { deaths } });
    }
    if (placedBlocks > 0 && !(this.progress?.placedBlocks > 0)) {
      this.notify({ ...context, kind: 'construction_started', key: 'first_placed_block', details: { placedBlocks } });
    }
    this.progress = { deaths, placedBlocks };
  }
}
