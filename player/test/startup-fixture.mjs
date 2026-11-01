import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openPlayerAgent } from '../agent.mjs';
import { startPlayerLifecycle } from '../lifecycle.mjs';

const [stateDir, mode] = process.argv.slice(2);
const lifecycle = await startPlayerLifecycle({ worldId: 'startup-test', port: 0 });
process.send({ port: lifecycle.address.port });
const models = createModels();
const provider = fauxProvider({
  provider: 'openai-codex', tokensPerSecond: 1000000,
  models: ['gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id, reasoning: true, input: ['text', 'image'] })),
});
provider.setResponses([async (_context, options) => {
  process.send({ model: 'started' });
  if (mode === 'seed' || mode === 'recover-wait') {
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
  }
  return fauxAssistantMessage('Remember the safe cave entrance.');
}]);
models.setProvider(provider.provider);
let agent;
try {
  agent = await openPlayerAgent({
    stateDir, worldId: 'startup-test', models, tools: [], signal: lifecycle.signal,
    onStatus: durable => lifecycle.update({ phase: durable.phase, durable }),
  });
  lifecycle.update({ phase: 'ready', ready: true });
  process.send({ ready: true });
  if (mode === 'seed') await agent.step({ landmark: 'persistent-cave-marker' });
  if (!lifecycle.signal.aborted) await new Promise(resolve => lifecycle.signal.addEventListener('abort', resolve, { once: true }));
} catch (error) {
  if (!lifecycle.signal.aborted) throw error;
} finally {
  await agent?.close();
  await lifecycle.close();
}
