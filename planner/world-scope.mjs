import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function worldPaths(root, worldId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(worldId)) {
    throw new Error('World identity must be a canonical Paper world UUID');
  }
  const namespace = path.join(path.resolve(root), 'worlds', worldId);
  return {
    worldId, root: namespace, manifestFile: path.join(namespace, 'world.json'),
    control: path.join(namespace, 'control'), observations: path.join(namespace, 'observations'),
    botData: path.join(namespace, 'bots'), plannerState: path.join(namespace, 'planner'),
  };
}

// Run by the host administrator. Bots and planner never need server-directory access.
export async function readWorldId(uidFile) {
  const uid = await readFile(uidFile);
  if (uid.length !== 16) throw new Error('Paper uid.dat must contain exactly 16 bytes');
  const hex = uid.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export async function assertWorldScope({ root, worldId }) {
  worldPaths(root, worldId); // Validate identity even when called directly by the engine.
  if (path.basename(path.resolve(root)) !== worldId || path.basename(path.dirname(path.resolve(root))) !== 'worlds') {
    throw new Error('World namespace path must end in worlds/<world UUID>');
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'world.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.worldId !== worldId) throw new Error('World namespace identity mismatch');
}

async function selectedWorldScope(env) {
  if (!env.ADVENTURE_WORLD_ID) {
    if (env.ADVENTURE_ROOT && path.basename(path.dirname(path.resolve(env.ADVENTURE_ROOT))) === 'worlds') {
      throw new Error('World namespace requires ADVENTURE_WORLD_ID');
    }
    return null;
  }
  if (!env.ADVENTURE_ROOT) throw new Error('ADVENTURE_ROOT is required with ADVENTURE_WORLD_ID');
  const root = path.resolve(env.ADVENTURE_ROOT);
  const scope = worldPaths(path.dirname(path.dirname(root)), env.ADVENTURE_WORLD_ID);
  if (root !== scope.root) throw new Error('World root and identity mismatch');
  await assertWorldScope(scope);
  return scope;
}

export async function botWorldConfig(env) {
  const scope = await selectedWorldScope(env);
  if (scope && (!env.BOT_DATA_DIR || path.resolve(env.BOT_DATA_DIR) !== scope.botData)) {
    throw new Error('BOT_DATA_DIR does not match selected world namespace');
  }
  return scope;
}

export async function plannerWorldConfig(env) {
  const databaseDir = env.PLANNER_STATE_DIR ?? '/var/lib/minecraft-planner';
  const scope = await selectedWorldScope(env);
  if (!scope) {
    // The deployed live world is explicitly unscoped until an administrator selects a namespace.
    return {
      databaseDir, stateDir: databaseDir,
      missionFile: env.PLANNER_MISSION_FILE ?? '/var/lib/minecraft-adventure/control/mission.json',
      observedFile: env.PLANNER_OBSERVED_FILE ?? '/var/lib/minecraft-adventure/observations/state.json',
    };
  }
  const missionFile = path.join(scope.control, 'mission.json');
  const observedFile = path.join(scope.observations, 'state.json');
  for (const [name, expected] of [['PLANNER_MISSION_FILE', missionFile], ['PLANNER_OBSERVED_FILE', observedFile]]) {
    if (env[name] && path.resolve(env[name]) !== expected) throw new Error(name + ' does not match selected world namespace');
  }
  return { databaseDir, worldScope: scope, stateDir: scope.plannerState, missionFile, observedFile };
}

// Preparation creates only an empty namespace. It never selects it, copies old facts or edits a world.
export async function prepareWorldScope({ root, uidFile, dryRun = true }) {
  const scope = worldPaths(root, await readWorldId(uidFile));
  if (dryRun) return scope;
  await mkdir(scope.root, { recursive: true, mode: 0o750 });
  try {
    await writeFile(scope.manifestFile, JSON.stringify({ version: 1, worldId: scope.worldId }) + '\n', { flag: 'wx', mode: 0o640 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await assertWorldScope(scope);
  }
  for (const directory of [scope.control, scope.observations, scope.botData, scope.plannerState]) {
    await mkdir(directory, { recursive: true, mode: 0o750 });
  }
  return scope;
}
