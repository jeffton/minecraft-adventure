export const BOT_ROLES = Object.freeze({
  Roy: 'builder and expedition coordinator',
  Spruce: 'forester and building-material supplier',
  Flint: 'miner, smith and equipment supplier',
  Moss: 'farmer, food supplier and quartermaster'
});

export const INITIAL_TASKS = Object.freeze({
  Roy: 'Secure immediate food and basic tools. Choose a safe reachable shared home with !chooseHome. Build small lodge batches from owned local materials; prioritize shelter and shared storage before distant exploration. Do not harvest the lodge.',
  Spruce: 'Gather nearby local timber outside the home footprint. Secure a personal tool and weapon, then help establish the first shared chest and deposit surplus building supplies through the checked program. Preserve personal food and tools; replant saplings where possible.',
  Flint: 'Earn basic stone tools, a weapon and furnace. Supply accessible stone for shelter through shared storage before deep mining or iron expeditions. Keep a reachable route home; do not dig below the home.',
  Moss: 'Secure immediate food, basic tools and defence. Source observed sheep and matching wool for personal beds early, coordinating separate bed footprints and confirmed spawn setting through the checked program. Establish renewable food beside the shared shelter after urgent food and beds.'
});

const WOOD_FAMILIES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped'];
const TIMBER_BLOCKS = new Set(WOOD_FAMILIES.flatMap(wood => {
  const forms = wood === 'bamboo' ? ['block'] : ['crimson', 'warped'].includes(wood) ? ['stem', 'hyphae'] : ['log', 'wood'];
  return forms.flatMap(form => [`${wood}_${form}`, `stripped_${wood}_${form}`]);
}));

// Oak names describe blueprint roles, not a required tree species.
export function matchesLodgeMaterial(actual, material) {
  if (actual === material) return true;
  if (material === 'oak_log') return TIMBER_BLOCKS.has(actual);
  if (material === 'oak_planks') return WOOD_FAMILIES.some(wood => actual === `${wood}_planks`);
  if (material === 'oak_door') return WOOD_FAMILIES.some(wood => actual === `${wood}_door`);
  return false;
}

export function lodgeMaterialItem(items, material) {
  return items.find(item => item.name === material && item.count > 0) ??
    items.find(item => item.count > 0 && matchesLodgeMaterial(item.name, material));
}

// Relative block positions. A compact timber lodge: raised stone skirt, plank floor,
// exposed corner posts, recessed windows, steep gable, porch and warm lighting.
export function lodgeBlueprint() {
  const blocks = new Map();
  const put = (x, y, z, material) => blocks.set(`${x},${y},${z}`, { x, y, z, material });
  for (let x = 0; x < 7; x++) {
    for (let z = 0; z < 9; z++) {
      put(x, -1, z, 'oak_planks');
      if (x === 0 || x === 6 || z === 0 || z === 8) put(x, -2, z, 'cobblestone');
    }
  }
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 7; x++) {
      for (const z of [0, 8]) {
        if (z === 0 && x === 3 && y < 2) continue;
        const corner = x === 0 || x === 6;
        const window = y === 1 && (x === 2 || x === 4);
        put(x, y, z, corner ? 'oak_log' : window ? 'glass_pane' : 'oak_planks');
      }
    }
    for (let z = 1; z < 8; z++) {
      for (const x of [0, 6]) put(x, y, z, y === 1 && [2, 3, 5, 6].includes(z) ? 'glass_pane' : 'oak_planks');
    }
  }
  // Solid gable ends provide genuine supports for each roof course.
  for (let x = 0; x < 7; x++) {
    const height = 3 + Math.min(x + 1, 7 - x);
    for (const z of [0, 8]) for (let y = 3; y < height; y++) put(x, y, z, 'oak_planks');
  }
  for (let x = -1; x <= 7; x++) {
    const y = 3 + Math.min(x + 1, 7 - x);
    // The overhangs are last, after the supported central roof.
    for (let z = 0; z <= 8; z++) put(x, y, z, 'oak_planks');
  }
  for (let x = -1; x <= 7; x++) {
    const y = 3 + Math.min(x + 1, 7 - x);
    for (const z of [-1, 9]) put(x, y, z, 'oak_planks');
  }
  for (let x = 2; x <= 4; x++) for (const z of [-2, -1]) put(x, -1, z, 'oak_planks');
  put(3, 0, 0, 'oak_door');
  put(1, 0, 1, 'crafting_table');
  put(5, 0, 1, 'furnace');
  put(1, 0, 7, 'chest');
  for (const [x, z] of [[1, 2], [5, 2], [1, 6], [5, 6]]) put(x, 0, z, 'torch');
  return [...blocks.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
}

export function validHome(home) {
  return home && ['x', 'y', 'z'].every(key => Number.isInteger(home[key])) &&
    Math.abs(home.x) < 30_000_000 && Math.abs(home.z) < 30_000_000 && home.y >= -60 && home.y <= 300;
}

export function validateMission(value) {
  if (!value || typeof value.id !== 'string' || typeof value.objective !== 'string' ||
      typeof value.phase !== 'string' || !value.bots || value.objective.length > 4000) {
    throw new Error('Invalid mission: expected id, phase, objective and bots');
  }
  for (const name of Object.keys(BOT_ROLES)) {
    if (typeof value.bots[name]?.task !== 'string' || value.bots[name].task.length > 4000) {
      throw new Error(`Invalid mission task for ${name}`);
    }
  }
  if (value.home !== null && value.home !== undefined && !validHome(value.home)) throw new Error('Invalid mission home');
  return value;
}

export function missionPrompt(name, mission, home) {
  const task = mission?.bots?.[name]?.task ?? INITIAL_TASKS[name];
  const program = mission?.bots?.[name]?.program;
  const programInstruction = program?.length ? `Shared behavior program for this mission: ${JSON.stringify(program)}. Use !runProgram to execute the checked local sequence without a model request between gathering/crafting steps. If it reports a concrete blocked prerequisite, solve that with ordinary documented commands, then rerun. The team planner rewrites the program from observed progress and failures.\n` : '';
  return programInstruction + `Shared long-term goal: build a beautiful cooperative survival home, establish renewable supplies and defeat the Ender Dragon through earned progression. Role: ${BOT_ROLES[name]}. Current phase: ${mission?.phase ?? 'settling'}. Team objective: ${mission?.objective ?? 'Secure food, tools and a shared timber lodge'}. Your task: ${task}\n` +
    `Team: Roy builds, Spruce supplies wood, Flint supplies stone/iron, Moss supplies food. Coordinate concrete deliveries using !givePlayer and the shared mission; do not request resources teammates do not have or start conversation loops. ${home ? `Home entrance ground position: ${home.x},${home.y},${home.z}; reserve x ${home.x - 2}..${home.x + 8}, z ${home.z - 3}..${home.z + 10} against harvesting.` : 'Roy must choose the shared home before construction.'}\n` +
    'If the observed wood list is empty, do not repeat a 32-block wood search. Use !scoutForResource("wood", 96) to explore safe walking routes, or a nearby observed terrain waypoint with !goToCoordinates; find a forest before committing to a treeless base. Unloaded space is unknown, not safe ground. Survival only: no commands, teleportation, spawned items, creative mode or generated code. Protect health: eat, equip armour/shield, retreat from creepers/lava and avoid neutral endermen. Gather small batches, keep food/tools, and share spare materials. Use actual available commands only. Do not claim a structure, portal or dragon victory without observing it.';
}
