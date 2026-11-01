import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError } from './contracts.mjs';

export class ModelQueue {
  #tail = Promise.resolve();
  #pending = 0;
  #lastStart = 0;
  #jobs = [];
  #running = false;

  constructor({ intervalMs = 20000, capacity = 8, now = Date.now, wait = sleep } = {}) {
    this.intervalMs = intervalMs;
    this.capacity = capacity;
    this.now = now;
    this.wait = wait;
  }

  get pending() { return this.#pending; }

  run(operation, { signal, priority = 0 } = {}) {
    signal?.throwIfAborted();
    if (this.#pending >= this.capacity) throw new HttpError(429, 'Planner queue is full');
    this.#pending++;
    const job = { operation, signal, priority, started: false };
    let finished = false;
    let settle;
    const result = new Promise((resolve, reject) => {
      settle = (error, value) => {
        if (finished) return;
        finished = true;
        this.#pending--;
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
    });
    const cancel = () => {
      // Active inference owns its abort/settlement. A queued disconnected caller frees capacity immediately.
      if (!job.started) {
        this.#jobs.splice(this.#jobs.indexOf(job), 1);
        settle(signal.reason);
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    job.settle = settle;
    const position = this.#jobs.findIndex(queued => queued.priority < priority);
    if (position === -1) this.#jobs.push(job);
    else this.#jobs.splice(position, 0, job);
    if (!this.#running) {
      this.#running = true;
      this.#tail = Promise.resolve().then(() => this.#process());
    }
    return result;
  }

  async #process() {
    while (this.#jobs.length) {
      try {
        const remaining = this.#lastStart + this.intervalMs - this.now();
        if (remaining > 0) await this.wait(remaining);
      } catch (error) {
        this.#jobs.shift()?.settle(error);
        continue;
      }
      // Select after pacing, so higher-priority arrivals can still pass waiting jobs.
      const job = this.#jobs.shift();
      if (!job) continue;
      job.started = true;
      try {
        job.signal?.throwIfAborted();
        this.#lastStart = this.now();
        job.settle(null, await job.operation());
      } catch (error) {
        job.settle(error);
      }
    }
    this.#running = false;
  }

  async drain() { await this.#tail; }
}
