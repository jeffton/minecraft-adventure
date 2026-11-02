/** Model recovery is an independent service, never a barrier to local control. */
export class BackgroundAgent {
  constructor({ open, onError }) {
    this.abort = new AbortController();
    this.opening = Promise.resolve().then(() => open(this.abort.signal)).then(agent => {
      this.agent = agent;
    }).catch(error => {
      this.error = error;
      if (!this.abort.signal.aborted) onError(error);
    });
  }

  async close() {
    this.abort.abort(new Error('Background engineer shutdown'));
    await this.opening;
    await this.agent?.close();
  }
}
