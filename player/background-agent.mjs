/** Model recovery is an independent service, never a barrier to local control. */
export class BackgroundAgent {
  constructor({ open, onError }) {
    Object.assign(this, { open, onError });
    this.abort = new AbortController();
    this.retry();
  }

  retry() {
    if (this.pending || this.agent || this.abort.signal.aborted) return this.opening;
    this.pending = true;
    this.opening = Promise.resolve().then(() => this.open(this.abort.signal)).then(agent => {
      this.agent = agent;
      this.error = null;
    }).catch(error => {
      this.error = error;
      if (!this.abort.signal.aborted) this.onError(error);
    }).finally(() => { this.pending = false; });
    return this.opening;
  }

  async close() {
    this.abort.abort(new Error('Background engineer shutdown'));
    await this.opening;
    await this.agent?.close();
  }
}
