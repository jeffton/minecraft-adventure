import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError } from './contracts.mjs';

export class ModelQueue {
  #tail = Promise.resolve();
  #pending = 0;
  #lastStart = 0;

  constructor({ intervalMs = 20000, capacity = 8, now = Date.now, wait = sleep } = {}) {
    this.intervalMs = intervalMs;
    this.capacity = capacity;
    this.now = now;
    this.wait = wait;
  }

  get pending() { return this.#pending; }

  run(operation, { signal } = {}) {
    signal?.throwIfAborted();
    if (this.#pending >= this.capacity) throw new HttpError(429, 'Planner queue is full');
    this.#pending++;
    let started = false;
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
      if (!started) settle(signal.reason);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    this.#tail = this.#tail.then(async () => {
      if (finished) return;
      started = true;
      try {
        const remaining = this.#lastStart + this.intervalMs - this.now();
        if (remaining > 0) await this.wait(remaining);
        signal?.throwIfAborted();
        this.#lastStart = this.now();
        settle(null, await operation());
      } catch (error) {
        settle(error);
      }
    });
    return result;
  }

  async drain() { await this.#tail; }
}
