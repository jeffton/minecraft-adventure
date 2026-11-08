import { timingSafeEqual } from 'node:crypto';

/** Both endpoints are local-only and authenticated by the server relay credential. */
export function playerRequestHandler({ token, worldId, chat, narrate, onError }) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return response.writeHead(401).end('{}');
    }
    if (request.method !== 'POST' || !['/diary', '/operator/task'].includes(request.url)) {
      return response.writeHead(404).end('{}');
    }
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (input.worldId !== worldId) return response.writeHead(409).end(JSON.stringify({ error: 'Player world mismatch' }));
      if (request.url === '/operator/task') {
        if (typeof input.id !== 'string' || !input.id.trim() || typeof input.text !== 'string' || !input.text.trim()) {
          return response.writeHead(400).end(JSON.stringify({ error: 'Operator task requires a nonempty id and text' }));
        }
        const id = `operator:${input.id}`;
        const added = await chat.receive({
          id,
          sender: { username: 'RoyOperator', uuid: null, origin: 'operator-relayed-user-request' },
          channel: 'operator',
          text: input.text,
        });
        return response.writeHead(added ? 202 : 200).end(JSON.stringify({ worldId, id, status: added ? 'queued' : 'already_received' }));
      }
      const result = await narrate(input);
      response.end(JSON.stringify({ ...result, worldId }));
    } catch (failure) {
      onError(failure);
      response.writeHead(500).end(JSON.stringify({ error: failure.message }));
    }
  };
}
