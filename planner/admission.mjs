import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { MISSION_INSTRUCTIONS, validateObservation } from './contracts.mjs';

// Applied below the durable scheduler, so recovered requests and compaction share admission too.
export function admittedModels(models, { stateDir, intervalMs = 20000 }) {
  let tail = Promise.resolve();
  const stampFile = path.join(stateDir, 'last-model-start.json');

  const admitted = {
    streamSimple(model, context, options) {
      const output = new AssistantMessageEventStream();
      const operation = tail.then(async () => {
        let previous = 0;
        try { previous = JSON.parse(await readFile(stampFile, 'utf8')).startedAt; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const delay = previous + intervalMs - Date.now();
        if (delay > 0) await sleep(delay, undefined, { signal: options?.signal });
        options?.signal?.throwIfAborted();
        // Mission input is persisted in the Harness. Check it again here after pacing,
        // including requests resumed directly by Pi before the HTTP listener starts.
        const lastUser = context.messages.filter(message => message.role === 'user').at(-1);
        const text = typeof lastUser?.content === 'string' ? lastUser.content :
          lastUser?.content?.filter(item => item.type === 'text').map(item => item.text).join('');
        if (text) {
          const envelope = JSON.parse(text);
          if (envelope.conversation?.some(message => message.role === 'system' && message.content === MISSION_INSTRUCTIONS)) {
            const missionInput = envelope.conversation.findLast(message => message.role === 'user');
            validateObservation(JSON.parse(missionInput.content).observed);
          }
        }
        const temporary = stampFile + '.tmp';
        await writeFile(temporary, JSON.stringify({ startedAt: Date.now() }) + '\n', { mode: 0o640 });
        await rename(temporary, stampFile);
        const upstream = models.streamSimple(model, context, options);
        for await (const event of upstream) output.push(event);
        output.end(await upstream.result());
      });
      tail = operation.catch(error => {
        const aborted = options?.signal?.aborted;
        const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        output.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage, stopReason: aborted ? 'aborted' : 'error', errorMessage: error.message, timestamp: Date.now(),
        } });
        output.end();
      });
      return output;
    },
  };
  return new Proxy(models, {
    get(target, key) {
      if (key === 'streamSimple') return admitted.streamSimple;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
