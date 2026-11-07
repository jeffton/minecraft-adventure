/** Curated Java survival knowledge, not a task sequence or a claim of capability. */
export const DRAGON_GUIDE = `Java survival reference for the installed 26.3 server. Choose your own approach and timing; this does not order an expedition or mark anything achieved. Use real registry/recipes, observations and tool results. Keep discoveries, dimension-labelled routes, dependencies and verified outcomes in notes.plan via remember; keep home stock/facilities in remember_home. Current inventory and fresh evidence override historical counts.

Nether access
- A minimum portal has a 2-wide by 3-high clear interior, 4-wide by 5-high outer frame: 10 ordinary obsidian blocks if the four corners are omitted. Crying obsidian does not work.
- Harvest obsidian with a diamond or netherite pickaxe, not stone or iron. Alternatively cast the frame in place using buckets: water meeting lava SOURCE blocks creates obsidian; flowing lava is not a substitute. Verify each placed block and fluid before removing supports.
- Ignite the interior with flint and steel (iron ingot + flint; gravel can drop flint). Equip/use the actual item against a reachable frame face, then observe portal blocks. Enter and verify the dimension; a lit frame is not a verified Nether visit.
- Record both portal locations and a safe return route. Bring usable tools/weapons, food, blocks and a way to relight a damaged portal; choose supplies for actual conditions, not an arbitrary checklist quota.

Nether resources
- The Nether has lava, falls and hostile mobs; water placed normally evaporates there. One equipped gold armor piece prevents ordinary piglins' default hostility, but not piglin brutes or retaliation for attacks/opening containers/mining guarded gold.
- Adult ordinary piglins barter a gold INGOT for a random result: Java loot includes ender pearls and fire-resistance potions. Use an ingot on a reachable piglin or drop it for one; verify its response and collect actual results. Baby piglins and piglin brutes do not barter. Gold armor does not make a bastion safe.
- Find an actual Nether fortress; blazes there provide blaze rods when killed by the player (drops are not guaranteed). Use cover, a shield and controlled approaches. Fire resistance helps against fire/lava, not falls, melee or every fortress threat. Bartered fire resistance can help before brewing is available.
- One blaze rod crafts into two blaze powder. Brewing your own fire resistance requires a brewing stand, blaze powder fuel, water bottles, nether wart for awkward potion, then magma cream; confirm registry recipes and actual brewing capability before choosing that route. Potions are useful options, not prerequisites for all progress.
- Endermen can drop ender pearls; ordinary piglin bartering is another route. Do not assume each kill/barter succeeds. Avoid staring at unrelated endermen; a two-block-high shelter can help with a deliberate fight.

Stronghold and End entry
- Craft one Eye of Ender from one ender pearl plus one blaze powder. Throw an Eye in the OVERWORLD and observe its flight direction toward a stronghold; travel between useful sightings instead of wasting throws. Each throw has a 20% chance to shatter; recover unbroken Eyes.
- Find the stronghold and its actual portal room, handling lava and silverfish. The frame has 12 slots; some may already contain Eyes. Inspect and fill only empty slots (0–12), budgeting separately for Eyes lost while locating it. Frames cannot be crafted for an ordinary survival End portal.
- Before entering, prepare food, armor, melee weapon, effective ranged attacks/ammunition, pickaxe, building blocks and a controlled way to handle falls. Water and slow falling can help in the End. An accessible Overworld bed near the stronghold can aid recovery, but moving spawn changes the home-return logistics.
- There is no ordinary return through the entrance portal: exit by defeating the dragon or dying. Verify readiness and preserve valuable surplus before committing.

Dragon fight
- Observe the arrival platform: it may require digging out or a safe bridge to the main island. Avoid the void and provoking endermen.
- End crystals atop obsidian towers heal the dragon. Destroy them, usually with ranged attacks; iron-bar cages require a safe approach. Crystals explode: do not stand beside an exposed crystal or rely on an unverified fall landing.
- Attack the flying dragon at range; during its central perch use melee on the head, since the perched Java dragon is immune to arrows. Avoid dragon breath, wing/head knockback and unsafe tower falls; heal and reposition as needed.
- Beds explode in the Nether and End: never attempt ordinary sleep there. Explosive bed tactics are not required.
- Confirm the actual dragon defeat and exit portal before recording victory; execution success or narration alone proves neither.

Sources checked for this guide:
https://www.minecraft.net/en-us/article/stronghold
https://www.polygon.com/minecraft-guides/21438328/nether-portal-obsidian-materials-flint-steel-iron-lava/
https://minecraft.wiki/w/Bartering
https://minecraft.wiki/w/Blaze
https://minecraft.wiki/w/Tutorial:Defeating_the_ender_dragon
`;

export const survivalGuideTool = {
  name: 'survival_guide',
  description: 'Read the curated Java survival guide for Nether portals, obsidian tools/casting, piglins, fortress/blaze rods, pearls, Eyes, strongholds and fighting the Ender Dragon. Knowledge only; performs no gameplay. Consult before planning an unfamiliar progression step.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => DRAGON_GUIDE,
};
