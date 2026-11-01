// Reuse installed geometry and Minecraft textures without copying game assets
// into this repository. The viewer engine is MIT; Minecraft assets are Mojang's.
// The upstream name-only stream does
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
  if (type === 'horse') {
    // The legacy model includes donkey ears, chests and saddle parts in its base
    // geometry. The name-only stream carries no equipment: render the bare horse.
    return {
      ...entity,
      geometry: { default: {
        ...entity.geometry.default,
        bones: entity.geometry.default.bones.map(bone => /^(MuleEar|Bag|Saddle|HeadSaddle)/.test(bone.name) ? { ...bone, cubes: [] } : bone)
      } },
      textures: { default: entity.textures.base_brown }
    };
  }
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
  source = source.replace(marker, `const r=(${modelSource})(n,e);if(!r)throw new Error(\`Unknown entity \${e}\`);`)
    .replace(textureMarker, `${textureMarker},h.needsUpdate=true`);
  const edits = [
    ['const e=function(t,e){if(t.name)try{', 'const e=function(t,e){if(t.name==="item"||window.roycraftEntityAssets[t.name])return window.roycraftBuildEntity(t,n);if(t.name)try{'],
    ['update(t){if(!this.entities[t.id])', `update(t){const current=this.entities[t.id];if(current?.userData.roycraftCustom&&(t.delete||(t.name==="item"&&current.userData.itemKey!==(t.item?\`\${t.item.name}:\${t.item.count}\`:"pending")))){this.scene.remove(current);window.roycraftDisposeEntity(current);delete this.entities[t.id];if(t.delete)return}if(!this.entities[t.id])`],
    ['this.scene.remove(t),o(t);this.entities={}', 'this.scene.remove(t),t.userData.roycraftCustom?window.roycraftDisposeEntity(t):o(t);this.entities={}'],
    // Upstream's parent-name normalization handles legacy witch/piglin geometry:
    // pivots are absolute in the data, while THREE child positions are relative.
    ['const o=[];for(const t of e.bones)t.parent?i[t.parent].add(i[t.name]):o.push(i[t.name]);', `const o=[],definitions=new Map(e.bones.map(b=>[b.name.toLowerCase(),b]));for(const t of e.bones){const parent=t.parent?definitions.get(t.parent.toLowerCase()):undefined;if(parent){if(parent.pivot)i[t.name].position.sub(new THREE.Vector3(...parent.pivot));i[parent.name].add(i[t.name])}else o.push(i[t.name])}`]
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Upstream custom-entity integration changed');
    source = source.replace(before, after);
  }
  // The Socket.IO client is constructed only after its render assets are ready,
  // so initial entity packets cannot race the model/artwork downloads.
  return `(async()=>{const [models,items]=await Promise.all([fetch('entity-assets/models.json'),fetch('item-assets/manifest.json')]);if(!models.ok||!items.ok)throw new Error('Camera entity assets could not load');window.roycraftEntityAssets=await models.json();window.roycraftItemAssets=await items.json();${source}\n})().catch(error=>{document.body.textContent='Camera entity assets could not load';throw error});`;
}
