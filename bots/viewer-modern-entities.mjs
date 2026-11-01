// Geometry code only. Mojang models and textures are downloaded separately.
// Output is a static adult bind pose: armadillos are unrolled, goats have both
// horns. Age, rolled state and missing-horn metadata are not in the viewer stream.
const faces = [
  { corners: [[0, 1, 1], [1, 1, 1], [0, 1, 0], [1, 1, 0]], uv: (x, y, z) => [z, 0, z + x, z] },
  { corners: [[1, 0, 1], [0, 0, 1], [1, 0, 0], [0, 0, 0]], uv: (x, y, z) => [z + x, 0, z + 2 * x, z] },
  { corners: [[1, 1, 1], [1, 0, 1], [1, 1, 0], [1, 0, 0]], uv: (x, y, z) => [0, z, z, z + y] },
  { corners: [[0, 1, 0], [0, 0, 0], [0, 1, 1], [0, 0, 1]], uv: (x, y, z) => [z + x, z, 2 * z + x, z + y] },
  { corners: [[1, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]], uv: (x, y, z) => [z, z, z + x, z + y] },
  { corners: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], uv: (x, y, z) => [2 * z + x, z, 2 * z + 2 * x, z + y] }
];
const uvCorners = [[0, 0], [1, 0], [0, 1], [1, 1]];
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);

// Bedrock angles are clockwise; convert to the viewer's right-handed axes.
export function rotatePoint(point, rotation = [0, 0, 0], pivot = [0, 0, 0]) {
  let [x, y, z] = sub(point, pivot);
  const [rx, ry, rz] = rotation.map(value => -value * Math.PI / 180);
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return add([x, y, z], pivot);
}

export function bakeModernGeometry(document, { hiddenBones = [] } = {}) {
  const [geometry] = document['minecraft:geometry'];
  const { texture_width: textureWidth, texture_height: textureHeight } = geometry.description;
  const bones = new Map(geometry.bones.map(bone => [bone.name, bone]));
  const hidden = new Set(hiddenBones);
  const positions = [], normals = [], uvs = [], indices = [];
  function transform(point, bone) {
    let current = bone;
    while (current) {
      point = rotatePoint(point, current.rotation, current.pivot);
      current = current.parent ? bones.get(current.parent) : undefined;
    }
    return point;
  }
  for (const bone of geometry.bones) {
    if (hidden.has(bone.name)) continue;
    for (const cube of bone.cubes || []) {
      if (!Array.isArray(cube.uv)) throw new Error('Modern entity adapter requires box UV arrays');
      const mirror = cube.mirror ?? bone.mirror ?? false;
      for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
        const face = faces[faceIndex];
        const offset = positions.length / 3;
        const points = face.corners.map(corner => {
          const local = [...corner];
          if (mirror) local[0] = 1 - local[0];
          const inflate = cube.inflate ?? bone.inflate ?? 0;
          const point = local.map((value, axis) => cube.origin[axis] + value * cube.size[axis] + (value ? inflate : -inflate));
          const pivot = cube.pivot ?? cube.origin.map((value, axis) => value + cube.size[axis] / 2);
          return transform(rotatePoint(point, cube.rotation, pivot), bone).map(value => value / 16);
        });
        const order = mirror ? [0, 2, 1, 2, 3, 1] : [0, 1, 2, 2, 1, 3];
        // Rotating a face direction, rather than crossing vertices, preserves
        // normals on zero-depth ear/beard planes.
        const direction = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, -1], [0, 0, 1]][faceIndex];
        if (mirror) direction[0] *= -1;
        const normal = sub(transform(rotatePoint(direction, cube.rotation), bone), transform([0, 0, 0], bone));
        const [u0, v0, u1, v1] = face.uv(...cube.size);
        for (let i = 0; i < 4; i++) {
          positions.push(...points[i]);
          normals.push(...normal);
          // Side faces run vertically down; north/south corners start at bottom.
          let [u, v] = uvCorners[i];
          if (faceIndex === 2 || faceIndex === 3) [u, v] = [v, u];
          if (faceIndex >= 4) v = 1 - v;
          uvs.push((cube.uv[0] + u0 + u * (u1 - u0)) / textureWidth,
            (cube.uv[1] + v0 + v * (v1 - v0)) / textureHeight);
        }
        indices.push(...order.map(index => offset + index));
      }
    }
  }
  return { textureWidth, textureHeight, positions, normals, uvs, indices };
}
