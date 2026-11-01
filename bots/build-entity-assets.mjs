import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { bakeModernGeometry } from './viewer-modern-entities.mjs';

export const revision = '15701fa9c13923f12662984c32c124327e40e3d3';
const base = `https://raw.githubusercontent.com/Mojang/bedrock-samples/${revision}/`;
export const entitySources = {
  armadillo: {
    geometry: '32f97a395a798cfb78cb22e0a2793f8b18064d145c667c917267e274b702d211',
    texture: 'armadillo.png', sha256: 'a2a4782ba071a88aadfed84ef2c8a060dc4d9a3167fba5d48806e79848dd2689',
    hiddenBones: ['body_rolled_up']
  },
  goat: {
    geometry: 'd397aa6727e906e26dd5e75a6d3471d72fac9a3421d3e332ff5a69d98794ea08',
    texture: 'goat/goat.png', sha256: '76b85155267cc6e8dc8145248ec72dce1984e1d6c08818780854922b4e264c04'
  },
  glow_squid: {
    geometry: '6d282b02c42a242c2b9026cc1e3e83d4c86fa9034f1e88a11e739e74c6e6510a',
    texture: 'glow_squid/glow_squid.tga', sha256: 'bd5bff0e85f51c2be98c3134b99a41aee89a02504bca1e8b5d88cd869cac8d29'
  }
};

async function download(path, checksum) {
  const response = await fetch(base + path);
  if (!response.ok) throw new Error(`${response.status}: ${base + path}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(buffer).digest('hex') !== checksum) throw new Error(`Checksum mismatch: ${path}`);
  return buffer;
}

async function writeAsset(path, data) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, data);
  await chmod(temporary, 0o644);
  await rename(temporary, path);
}

// Downloads and generated buffers are proprietary Minecraft assets, not source
// code. Default output is gitignored. TGA conversion requires Python Pillow.
export async function buildEntityAssets(directory) {
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o755);
  const models = {};
  const manifest = {
    revision,
    license: '(c) Mojang AB. All rights reserved. Subject to the Minecraft End User License Agreement.',
    licenseUrl: base + 'LICENSE.md',
    eulaUrl: 'https://www.minecraft.net/en-us/eula',
    pose: 'Static adult bind pose; unrolled armadillo, goat with both horns. No age/state/horn metadata or animation.',
    sources: []
  };
  for (const [name, source] of Object.entries(entitySources)) {
    const geometryPath = `resource_pack/models/entity/${name}.geo.json`;
    const texturePath = `resource_pack/textures/entity/${source.texture}`;
    const geometry = await download(geometryPath, source.geometry);
    const texture = await download(texturePath, source.sha256);
    await writeAsset(join(directory, `${name}.geo.json`), geometry);
    const textureFile = join(directory, `${name}.png`);
    if (source.texture.endsWith('.tga')) {
      const tgaFile = join(directory, `${name}.tga`);
      await writeAsset(tgaFile, texture);
      const temporary = `${textureFile}.tmp`;
      execFileSync('python3', ['-c', 'from PIL import Image; import sys; Image.open(sys.argv[1]).save(sys.argv[2], format="PNG")', tgaFile, temporary]);
      await chmod(temporary, 0o644);
      await rename(temporary, textureFile);
    } else {
      await writeAsset(textureFile, texture);
    }
    const model = bakeModernGeometry(JSON.parse(geometry), { hiddenBones: source.hiddenBones });
    const png = await readFile(textureFile);
    if (png.readUInt32BE(16) !== model.textureWidth || png.readUInt32BE(20) !== model.textureHeight) {
      throw new Error(`Texture dimensions disagree with geometry: ${name}`);
    }
    models[name] = { ...model, texture: `${name}.png` };
    manifest.sources.push({ name, geometryUrl: base + geometryPath, geometrySha256: source.geometry,
      textureUrl: base + texturePath, textureSha256: source.sha256,
      pngSha256: createHash('sha256').update(png).digest('hex') });
  }
  await writeAsset(join(directory, 'models.json'), JSON.stringify(models));
  await writeAsset(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return models;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] || fileURLToPath(new URL('./assets/entities/', import.meta.url)));
  const models = await buildEntityAssets(output);
  console.log(JSON.stringify({ output, vertices: Object.fromEntries(Object.entries(models).map(([name, model]) => [name, model.positions.length / 3])) }));
}
