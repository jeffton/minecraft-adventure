import http from 'node:http';

/** Health and cancellation exist before Minecraft or Durable starts recovering. */
export async function startPlayerLifecycle({ worldId, port = 8766, host = '127.0.0.1', signals = process }) {
  const controller = new AbortController();
  let status = { phase: 'starting', ready: false, durable: { phase: 'not_open' } };
  let details = () => ({});
  let handler;
  const stop = signal => {
    status = { ...status, phase: 'stopping', ready: false };
    controller.abort(new Error(`Player shutdown: ${signal}`));
  };
  const term = () => stop('SIGTERM');
  const int = () => stop('SIGINT');
  signals.once('SIGTERM', term);
  signals.once('SIGINT', int);
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(status.ready ? 200 : 503);
      return response.end(JSON.stringify({ worldId, player: 'Roy', ...details(), ...status }));
    }
    if (!status.ready || !handler) {
      response.writeHead(503);
      return response.end(JSON.stringify({ error: 'Player is not ready', ...status }));
    }
    void handler(request, response);
  });
  const close = async () => {
    signals.removeListener('SIGTERM', term);
    signals.removeListener('SIGINT', int);
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    signals.removeListener('SIGTERM', term);
    signals.removeListener('SIGINT', int);
    throw error;
  }
  return {
    signal: controller.signal,
    address: server.address(),
    update(next) { if (!controller.signal.aborted) status = { ...status, ...next }; },
    details(read) { details = read; },
    handler(next) { handler = next; },
    close,
  };
}
