// Clear-weather Overworld lightmap, matching the 1.21.4 client shader used as
// this viewer's reference. Brightness 0.5 is vanilla's default, not sRGB gamma.
// https://assets.mcasset.cloud/1.21.4/assets/minecraft/shaders/core/lightmap.fsh
// Self-contained: the HTTP route embeds this function in the browser bundle.
export function minecraftLighting(timeOfDay, dimension) {
  const clamp = value => Math.max(0, Math.min(1, value));
  const phase = ((timeOfDay / 24000 - 0.25) % 1 + 1) % 1;
  const celestialAngle = (phase * 2 + 0.5 - Math.cos(phase * Math.PI) / 2) / 3;
  const cosine = Math.cos(celestialAngle * Math.PI * 2);
  const overworld = dimension === 'overworld';
  const sun = overworld ? 0.2 + 0.8 * clamp(cosine * 2 + 0.2) : 1;
  const skyVisibility = overworld ? clamp(cosine * 2 + 0.5) : 1;
  const skyFactor = sun * 0.95 + 0.05;
  const skyColor = [0.35 + 0.65 * sun, 0.35 + 0.65 * sun, 1];
  const curve = level => (level / 15) / (4 - 3 * level / 15);
  const lightmap = new Uint8Array(16 * 16 * 4);
  for (let sky = 0; sky < 16; sky++) {
    for (let block = 0; block < 16; block++) {
      const b = curve(block) * 1.5; // Mean vanilla block-light flicker factor.
      const s = curve(sky) * skyFactor;
      const color = [b, b * ((b * 0.6 + 0.4) * 0.6 + 0.4), b * (b * b * 0.6 + 0.4)];
      const offset = (sky * 16 + block) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = clamp((color[channel] + skyColor[channel] * s) * 0.96 + 0.75 * 0.04);
        const notGamma = 1 - (1 - value) ** 4;
        const brightness = clamp((value * 0.5 + notGamma * 0.5) * 0.96 + 0.75 * 0.04);
        lightmap[offset + channel] = Math.round(brightness * 255);
      }
      lightmap[offset + 3] = 255;
    }
  }
  return { celestialAngle, sun, skyVisibility, skyFactor, lightmap };
}
