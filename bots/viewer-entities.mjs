// Reuse prismarine-viewer's installed MIT-licensed models and game textures.
// No assets are copied into this repository. The upstream name-only stream does
// not carry coat/profession/equipment metadata; variants use a documented base skin.
export function viewerEntityModel(models, type) {
  const skins = {
    cat: 'tabby', donkey: 'donkey', fox: 'red', horse: 'base_brown',
    llama: 'creamy', mule: 'mule', ocelot: 'wild', parrot: 'red_blue',
    rabbit: 'brown', shulker: 'undyed', skeleton_horse: 'skeleton',
    zombie_horse: 'zombie'
  };
  if (type === 'trader_llama' || type === 'llama') {
    const llama = models.llama;
    // Chests are optional in Minecraft and absent from the name-only stream.
    const body = {
      ...llama.geometry.default,
      bones: llama.geometry.default.bones.map(bone => bone.name.startsWith('chest')
        ? { ...bone, cubes: [] }
        : bone)
    };
    const geometry = { default: body };
    const textures = { default: llama.textures.creamy };
    if (type === 'trader_llama') {
      geometry.decor = {
        ...body,
        bones: body.bones.map(bone => ({
          ...bone,
          cubes: bone.cubes?.map(cube => ({ ...cube, inflate: (cube.inflate || 0) + 0.1 }))
        }))
      };
      textures.decor = llama.textures.decor_wandering_trader;
    }
    return { ...llama, identifier: `minecraft:${type}`, geometry, textures };
  }
  const entity = models[type];
  if (skins[type]) {
    return { ...entity, textures: { ...entity.textures, default: entity.textures[skins[type]] } };
  }
  // These are genuine base textures, not profession-only transparent overlays.
  if (type === 'villager' || type === 'zombie_villager') {
    return { ...entity, textures: { ...entity.textures, default: `textures/entity/${type}/${type}` } };
  }
  // Java split boat into wood-specific entity names in 1.21.2. Only woods with
  // exact installed geometry AND texture are mapped; chest boats/rafts differ.
  const boat = /^(oak|spruce|birch|jungle|acacia|dark_oak)_boat$/.exec(type);
  if (boat) {
    return {
      ...models.boat,
      identifier: `minecraft:${type}`,
      textures: { default: `textures/entity/boat/${boat[1]}` }
    };
  }
  return entity;
}

export function patchViewerEntities(source, modelSource) {
  const marker = 'const r=n[e];if(!r)throw new Error(`Unknown entity ${e}`);';
  if (source.split(marker).length !== 2) throw new Error('Upstream entity-model integration changed');
  const textureMarker = 't.wrapT=THREE.RepeatWrapping,h.map=t';
  if (source.split(textureMarker).length !== 2) throw new Error('Upstream entity-texture integration changed');
  return source.replace(marker, `const r=(${modelSource})(n,e);if(!r)throw new Error(\`Unknown entity \${e}\`);`)
    .replace(textureMarker, `${textureMarker},h.needsUpdate=true`);
}
