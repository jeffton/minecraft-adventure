// Render downloaded Mojang geometry and genuine inventory artwork. Assets stay
// in runtime storage; no Minecraft textures or model data are embedded here.
export function buildViewerEntity(entity, THREE) {
  const root = new THREE.Group();
  root.userData.roycraftCustom = true;
  const textures = window.roycraftEntityTextures ??= new Map();
  function texture(path, flipY) {
    if (!textures.has(path)) {
      const value = new THREE.TextureLoader().load(path);
      value.magFilter = THREE.NearestFilter;
      value.minFilter = THREE.NearestFilter;
      value.flipY = flipY;
      textures.set(path, value);
    }
    return textures.get(path);
  }
  if (entity.name === 'item') {
    const item = entity.item;
    root.userData.itemKey = item ? `${item.name}:${item.count}` : 'pending';
    root.userData.roycraftKind = 'item';
    if (item) {
      const path = window.roycraftItemAssets.items[item.name];
      if (!path) throw new Error(`No Minecraft artwork for dropped ${item.name}`);
      const material = new THREE.SpriteMaterial({ map: texture(path, true), alphaTest: 0.1 });
      const copies = item.count > 48 ? 5 : item.count > 32 ? 4 : item.count > 16 ? 3 : item.count > 1 ? 2 : 1;
      for (let index = 0; index < copies; index++) {
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(0.5, 0.5, 1);
        sprite.position.set(index * 0.035, 0.25 + index * 0.025, index * 0.035);
        root.add(sprite);
      }
      root.name = `${item.name} ×${item.count}`;
    }
  } else {
    const model = window.roycraftEntityAssets[entity.name];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(model.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(model.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(model.uvs, 2));
    geometry.setIndex(model.indices);
    const Material = entity.name === 'glow_squid' ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial;
    const material = new Material({ map: texture(`entity-assets/${model.texture}`, false), transparent: true, alphaTest: 0.1, side: THREE.DoubleSide });
    root.add(new THREE.Mesh(geometry, material));
    root.userData.roycraftKind = entity.name;
  }
  if (entity.pos) root.position.set(entity.pos.x, entity.pos.y, entity.pos.z);
  return root;
}

export function disposeViewerEntity(root) {
  const materials = new Set();
  root.traverse(child => {
    if (!child.isSprite) child.geometry?.dispose();
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (material) materials.add(material);
    }
  });
  // Textures are shared by live entities and remain cached until iframe teardown.
  for (const material of materials) material.dispose();
}
