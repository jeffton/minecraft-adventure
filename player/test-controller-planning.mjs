import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PersistentController } from './controller.mjs';
import { createSandboxBroker } from './sandbox-broker.mjs';
import { prepareSandboxRoot } from './sandbox-install.mjs';
import { SkillSandbox } from './sandbox.mjs';
import { registryInfo } from './world-knowledge.mjs';

const require = createRequire('/opt/minecraft-mindcraft/package.json');
const registry = require('minecraft-data')('1.21.4');
const { Recipe } = require('prismarine-recipe')('1.21.4');

const point = (x, y = 65, z = 0) => ({ x, y, z });
const known = (kind, name, position) => ({ kind, name, position, dimension: 'overworld', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:01:00Z' });

export function planningScenarios() {
  const bedInventory = [{ name: 'oak_planks', count: 12 }, { name: 'stone_sword', count: 1 }, { name: 'crafting_table', count: 1 }];
  const ironInventory = [{ name: 'stick', count: 8 }, { name: 'stone_pickaxe', count: 1 }, { name: 'crafting_table', count: 1 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 8 }];
  return [
    { id: 'bed-known-plains', goal: 'white_bed', inventory: bedInventory, locations: [known('biome', 'plains', point(80))] },
    { id: 'bed-no-known-habitat', goal: 'white_bed', inventory: bedInventory, locations: [] },
    { id: 'iron-known-cave', goal: 'iron_pickaxe', inventory: ironInventory, locations: [known('block', 'stone', point(24, 58)), known('biome', 'dripstone_caves', point(24, 58))] },
    { id: 'iron-no-known-deposit', goal: 'iron_pickaxe', inventory: ironInventory, locations: [] }
  ];
}

/** Offline evidence, not a simulator: every mutation stops at the intent boundary. */
function fixtureRpc(observation, locations, trace) {
  const read = method => (...args) => {
    if (trace.length >= 32) throw new Error('AUDIT_QUERY_BUDGET');
    trace.push({ method, args });
    if (method === 'observe') return structuredClone(observation);
    if (method === 'registryInfo') return registryInfo(registry, ...args);
    if (method === 'recipesAll' || method === 'recipesFor') {
      const item = registry.itemsByName[args[0]];
      if (!item) throw new Error(`Unknown item: ${args[0]}`);
      const recipes = Recipe.find(item.id, null).map((recipe, index) => ({
        index, requiresTable: recipe.requiresTable,
        result: { ...recipe.result, name: registry.items[recipe.result.id]?.name },
        delta: recipe.delta.map(value => ({ ...value, name: registry.items[value.id]?.name }))
      }));
      return method === 'recipesAll' ? recipes : recipes.filter(recipe => recipe.delta.filter(item => item.count < 0).every(item => observation.inventory.filter(value => value.name === item.name).reduce((sum, value) => sum + value.count, 0) >= -item.count));
    }
    if (method === 'knownLocations') {
      const { kind, names, dimension, limit = 16 } = args[0] ?? {};
      return { historical: true, worldId: observation.worldId, locations: locations.filter(value => (!kind || value.kind === kind) && (!names || names.includes(value.name)) && (!dimension || dimension === value.dimension)).slice(0, limit) };
    }
    if (method === 'findBlocks') return observation.blocks.filter(value => args[0].names.includes(value.name));
    if (method === 'blockAt' || method === 'biomeAt') {
      const p = args[0];
      const found = observation.blocks.find(block => block.position.x === p.x && block.position.y === p.y && block.position.z === p.z);
      if (method === 'blockAt') return found ?? null;
      if (!found) throw new Error('Biome position is not loaded');
      return observation.biome;
    }
    if (method === 'itemInfo') return registryInfo(registry, 'items', { names: [args[0]] }).items[0];
    if (method === 'blockInfo') return registryInfo(registry, 'blocks', { names: [args[0]] }).items[0];
    throw new Error(`AUDIT_UNMODELED_QUERY: ${method}`);
  };
  const reads = new Set(['registryInfo', 'recipesAll', 'recipesFor', 'knownLocations', 'findBlocks', 'blockAt', 'biomeAt', 'itemInfo', 'blockInfo']);
  return {
    observe: read('observe'),
    async call(method, args) {
      if (method === 'observe') return read('observe')();
      if (reads.has(method)) return read(method)(...args);
      if (trace.length >= 32) throw new Error('AUDIT_QUERY_BUDGET');
      trace.push({ method, args, mutationIntent: true });
      throw new Error('AUDIT_INTENT_ONLY: no Minecraft actions are executed');
    },
    cancel() {}
  };
}

export async function auditController({ sourceFile, stateFile, goalKey = 'goal', outputFile }) {
  if (process.getuid?.() !== 0) throw new Error('Audit needs root solely to launch the isolated OS sandbox');
  let source = await readFile(sourceFile, 'utf8');
  let productionState = stateFile ? JSON.parse(await readFile(stateFile, 'utf8')) : {};
  if (source.trimStart().startsWith('{')) {
    const store = JSON.parse(source);
    const active = store.versions.find(value => value.version === store.activeVersion);
    if (!active) throw new Error('Source controller store has no active version');
    source = active.code;
    if (!stateFile) productionState = store.state;
  }
  const directory = await mkdtemp('/var/lib/minecraft-planning-audit-');
  await chmod(directory, 0o755);
  const root = path.join(directory, 'root');
  prepareSandboxRoot(root);
  const socketPath = path.join(directory, 'broker.sock');
  const broker = createSandboxBroker({ root, timeoutMs: 4000 });
  await new Promise(resolve => broker.listen(socketPath, resolve));
  const evidence = { sourceHash: createHash('sha256').update(source).digest('hex'), directory, goalKey, limitations: ['Offline decision/action-intent audit, not real navigation, combat, resource acquisition or gameplay success.', 'Goal state key must match the production controller schema; inspect raw state/actions before judging semantics.', 'Unknown target coordinates can be legitimate exploration. No seed, server locate, model requests or production game RPC is available.'], scenarios: [] };
  try {
    for (const scenario of planningScenarios()) {
      const worldId = `audit-${scenario.id}`;
      const observation = {
        worldId, session: 'offline-audit', life: 1, health: 20, food: 20, oxygen: 20,
        position: point(0), dimension: 'overworld', time: { timeOfDay: 1000, isDay: true },
        biome: { name: 'forest', category: 'forest', position: point(0), dimension: 'overworld' },
        inventory: structuredClone(scenario.inventory), entities: [], heldItem: null,
        blocks: [{ name: 'grass_block', position: point(0, 64), type: registry.blocksByName.grass_block.id }],
        goal: { item: scenario.goal, count: 1 },
        knownLocations: { historical: true, worldId, locations: scenario.locations },
        threats: [], progress: { events: [] }
      };
      const state = { ...structuredClone(productionState), [goalKey]: scenario.goal };
      const controller = await new PersistentController({ directory, worldId, socketPath }).open();
      const candidate = await controller.candidate({ name: 'Actual production source: held-out audit', code: source, fixtures: [{ observation, state }, { observation: { ...observation, entities: [] }, state }] });
      const validation = await controller.validate(candidate.version);
      const record = { id: scenario.id, requestedGoal: scenario.goal, observation, initialState: state, validation, decisions: [] };
      evidence.scenarios.push(record);
      if (validation.status !== 'validated') continue;
      await controller.activate(candidate.version);
      // Isolated clone only; production storage is never opened for writing.
      controller.data.state = structuredClone(state);
      await controller.save();
      let previousResult = null;
      for (let step = 0; step < 2; step++) {
        const reopened = await new PersistentController({ directory, worldId, socketPath }).open();
        const decision = await reopened.decide(observation, previousResult);
        const trace = [];
        let actionResult = null;
        if (decision.action) {
          const sandbox = new SkillSandbox({ socketPath, timeoutMs: 3500, rpc: fixtureRpc(observation, scenario.locations, trace) });
          const id = sandbox.start(decision.action.code, { name: decision.action.name, input: decision.action.input, worldId });
          actionResult = await sandbox.wait(id);
        }
        const firstIntent = trace.find(value => value.mutationIntent) ?? null;
        record.decisions.push({ decision, trace, firstIntent, feedbackReceived: previousResult, actionResult, persistedState: (await new PersistentController({ directory, worldId, socketPath }).open()).inspect().state });
        previousResult = firstIntent && ['goto', 'follow'].includes(firstIntent.method)
          ? { state: 'failed', error: 'Held-out fixture: path blocked before reaching target; no materials gained', auditInjectedObstruction: true }
          : actionResult;
      }
    }
  } finally {
    await new Promise(resolve => broker.close(resolve));
  }
  const file = outputFile ?? path.join(directory, 'evidence.json');
  await writeFile(file, JSON.stringify(evidence, null, 2));
  return { file, sourceHash: evidence.sourceHash, scenarios: evidence.scenarios.map(value => ({ id: value.id, validation: value.validation.status, actions: value.decisions.map(item => item.decision.action?.name ?? null), intents: value.decisions.map(item => item.firstIntent) })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourceFile, stateFile, goalKey = 'goal', outputFile] = process.argv.slice(2);
  if (!sourceFile) throw new Error('Usage: node player/test-controller-planning.mjs SOURCE_FILE [STATE_FILE] [GOAL_STATE_KEY] [OUTPUT_JSON]');
  console.log(JSON.stringify(await auditController({ sourceFile, stateFile: stateFile === '-' ? undefined : stateFile, goalKey, outputFile }), null, 2));
}
