import http from 'node:http';
import { chmod, readFile } from 'node:fs/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export async function startBroker({ socketPath, authPath, modelsStorePath, runtime } = {}) {
  // The same SDK file backend/lock as Batty owns refresh. No copied refresh-token store.
  const models = runtime ?? await ModelRuntime.create({
    authPath,
    modelsPath: null,
    // Read Batty's canonical cached catalog without taking ownership of its file.
    modelsStore: {
      read: async provider => JSON.parse(await readFile(modelsStorePath, 'utf8'))[provider],
      write: async () => { throw new Error('Canonical model catalog is read-only'); },
      delete: async () => { throw new Error('Canonical model catalog is read-only'); },
    },
    allowModelNetwork: false,
  });
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || !['/auth', '/models'].includes(request.url)) {
      response.writeHead(404).end('{"error":"Not found"}');
      return;
    }
    try {
      if (request.url === '/models') {
        response.end(JSON.stringify(models.getModels('openai-codex')));
        return;
      }
      const resolved = await models.getAuth('openai-codex');
      if (!resolved?.auth?.apiKey) throw new Error('Codex auth not configured');
      // Access-token request auth only. Never return refresh credentials or provider env.
      response.end(JSON.stringify({ auth: resolved.auth, source: 'Local broker' }));
    } catch {
      console.error('Codex broker request failed');
      response.writeHead(503).end('{"error":"Codex broker request failed"}');
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
    authPath: process.env.BATTY_PROVIDER_AUTH_PATH ?? '/home/roy/github/.batty/auth.json',
    modelsStorePath: process.env.BATTY_MODELS_STORE_PATH,
  });
  const close = () => server.close();
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
