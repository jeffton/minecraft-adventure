import http from 'node:http';
import { chmod } from 'node:fs/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export async function startBroker({ socketPath, authPath, runtime } = {}) {
  // The same SDK file backend/lock as Batty owns refresh. No copied refresh-token store.
  const models = runtime ?? await ModelRuntime.create({
    authPath,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || request.url !== '/auth') {
      response.writeHead(404).end('{"error":"Not found"}');
      return;
    }
    try {
      const resolved = await models.getAuth('openai-codex');
      if (!resolved?.auth?.apiKey) throw new Error('Codex auth not configured');
      // Access-token request auth only. Never return refresh credentials or provider env.
      response.end(JSON.stringify({ auth: resolved.auth, source: 'Local broker' }));
    } catch {
      console.error('Codex credential resolution failed');
      response.writeHead(503).end('{"error":"Codex credential resolution failed"}');
    }
  });
  // RuntimeDirectory is removed by systemd on stop; do not unlink a socket owned by a live process.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o660);
  return server;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const server = await startBroker({
    socketPath: process.env.PLANNER_AUTH_SOCKET ?? '/run/minecraft-planner-auth/auth.sock',
    authPath: process.env.BATTY_PROVIDER_AUTH_PATH ?? '/root/github/.batty/auth.json',
  });
  const close = () => server.close();
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
