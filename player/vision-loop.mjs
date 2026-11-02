export class VisionLoop {
  constructor({ capture, contextKey, onFrame, onError, now = Date.now, intervalMs = 50000, maxAgeMs = 90000 }) {
    Object.assign(this, { capture, contextKey, onFrame, onError, now, intervalMs, maxAgeMs });
    this.frame = null;
    this.pending = null;
    this.timer = null;
  }

  start() {
    this.request();
    this.timer = setInterval(() => this.request(), this.intervalMs);
  }

  peek({ maxAgeMs = this.maxAgeMs } = {}) {
    return this.frame?.contextKey === this.contextKey() && this.now() - this.frame.at <= maxAgeMs ? this.frame : null;
  }

  request() {
    if (this.closed || this.pending) return;
    const requestedContext = this.contextKey();
    void this.refresh().catch(this.onError).finally(() => {
      // A death during rendering invalidates that frame, not the independent AI.
      if (!this.closed && requestedContext !== this.contextKey()) this.request();
    });
  }

  refresh() {
    if (this.pending) return this.pending;
    const key = this.contextKey();
    const startedAt = this.now();
    this.pending = (async () => {
      const frame = await this.capture();
      if (key !== this.contextKey()) throw new Error('Player context changed during vision capture');
      this.frame = { ...frame, contextKey: key };
      this.onFrame(this.frame, { captureMs: this.now() - startedAt });
      return this.frame;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  async current({ maxAgeMs = this.maxAgeMs } = {}) {
    if (this.frame?.contextKey === this.contextKey() && this.now() - this.frame.at <= maxAgeMs) return this.frame;
    return this.refresh();
  }

  close() { this.closed = true; clearInterval(this.timer); }
}
