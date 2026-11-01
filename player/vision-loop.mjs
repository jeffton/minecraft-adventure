export class VisionLoop {
  constructor({ capture, contextKey, onFrame, onError, now = Date.now, intervalMs = 50000, maxAgeMs = 90000 }) {
    Object.assign(this, { capture, contextKey, onFrame, onError, now, intervalMs, maxAgeMs });
    this.frame = null;
    this.pending = null;
    this.timer = null;
  }

  start() {
    void this.refresh().catch(this.onError);
    this.timer = setInterval(() => { void this.refresh().catch(this.onError); }, this.intervalMs);
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

  async current() {
    if (this.frame?.contextKey === this.contextKey() && this.now() - this.frame.at <= this.maxAgeMs) return this.frame;
    return this.refresh();
  }

  close() { clearInterval(this.timer); }
}
