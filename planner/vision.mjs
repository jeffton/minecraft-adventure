import { createHash } from 'node:crypto';

export const VISION_INSTRUCTIONS = `Images are current Minecraft renders, ordered exactly as visualObservations. Each metadata entry identifies the actor, producer session, dimension, capture time, position and view kind. A pov image is that bot's actual first-person camera, not a shared or omniscient view; an optional base image is an elevated observer view. Compare visible hazards, terrain, access, resources and work with the structured observations to choose practical next tasks. Include strategy.visualAssessment: a short concrete assessment naming the pictured actor(s), visible evidence and its effect on the mission. Occluded terrain and anything outside these views are unknown. Pictures cannot prove inventory transfers, bed spawn acknowledgements, completed buildings or historical actions. Respect image age and newer structured facts. Never claim to have seen a view that is not attached.`;

export function needsBuildingView(observed, strategy) {
  if (!observed.home) return false;
  return /shelter|lodge|house|base|build|chest|bed/i.test([
    observed.objective, strategy?.goal?.title, ...(strategy?.nextGoals ?? []),
    ...Object.values(observed.bots).map(bot => bot.task ?? ''),
  ].join(' '));
}

export function nextPerspective(observed, previousBot) {
  const names = ['Roy', 'Spruce', 'Flint', 'Moss'];
  const start = (names.indexOf(previousBot) + 1) % names.length;
  for (let offset = 0; offset < names.length; offset++) {
    const name = names[(start + offset) % names.length];
    if (Object.values(observed.bots).some(bot => bot.name === name && bot.status === 'online')) return name;
  }
  throw new Error('No online actor for planning vision');
}

export function durableInput(messages, images = []) {
  const text = { type: 'text', text: JSON.stringify({ conversation: messages }) };
  return images.length ? [text, ...images] : text.text;
}

export function validateVisualFrame(frame, home, now = Date.now()) {
  if (!['pov', 'base'].includes(frame.kind)) throw new Error('Unknown planning camera view kind');
  if (frame.kind === 'base' && (!home || frame.home.dimension !== home.dimension || ['x', 'y', 'z'].some(axis => frame.home[axis] !== home[axis]))) {
    throw new Error('Planning camera belongs to a different base');
  }
  const age = now - Date.parse(frame.capturedAt);
  if (!Number.isFinite(age) || age < -5000 || age > 90000) throw new Error('Planning camera image is stale');
  const data = Buffer.from(frame.image.data, 'base64');
  if (frame.image.type !== 'image' || frame.image.mimeType !== 'image/webp' || data.length > 1024 * 1024 ||
      data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('Planning camera returned an invalid WebP image');
  }
  if (createHash('sha256').update(data).digest('hex') !== frame.sha256) throw new Error('Planning camera image checksum mismatch');
  return frame;
}

export function validateVisualSource(frame, observed) {
  validateVisualFrame(frame, observed.home);
  const bot = Object.values(observed.bots).find(bot => bot.name === frame.bot);
  if (!bot || bot.status !== 'online' || bot.session !== frame.sourceSession || bot.dimension !== frame.sourceDimension ||
      (frame.kind === 'base' && bot.dimension !== observed.home.dimension) || Date.parse(observed.updatedAt) < Date.parse(frame.capturedAt) ||
      Date.parse(bot.updatedAt) < Date.parse(frame.capturedAt)) {
    throw new Error('Planning camera source session/dimension is not confirmed after capture');
  }
}

// One fresh rotating POV per review batch, plus an occasional relevant base view.
// The short-lived cache is the normal cadence, never a substitute after capture failure.
export function createPlanningVision(capture, now = Date.now) {
  let previousBot;
  let cached = null;
  let lastBaseAt = 0;
  let lastAttemptAt = 0;
  return async (observed, strategy) => {
    const validCache = cached && cached.frames.every(frame => {
      try { validateVisualSource(frame, observed); return now() - Date.parse(frame.capturedAt) < 60000; }
      catch { return false; }
    });
    if (validCache) return { ...cached, reused: true };
    if (now() - lastAttemptAt < 60000) throw new Error('Planning camera cadence: no valid current-session image; next capture slot is ' + new Date(lastAttemptAt + 60000).toISOString());
    lastAttemptAt = now();
    const povBot = nextPerspective(observed, previousBot);
    const includeBase = needsBuildingView(observed, strategy) && now() - lastBaseAt >= 120000;
    const result = await capture(observed, { povBot, includeBase });
    if (!Array.isArray(result.frames) || result.frames.length < 1 || result.frames.length > 2 || result.frames[0].kind !== 'pov' || result.frames[0].bot !== povBot) {
      throw new Error('Planning capture returned the wrong actor or frame batch');
    }
    for (const frame of result.frames) validateVisualFrame(frame, observed.home, now());
    previousBot = povBot;
    if (result.frames.some(frame => frame.kind === 'base')) lastBaseAt = now();
    cached = result;
    return { ...result, reused: false };
  };
}

export async function capturePlanningViews(observed, { povBot, includeBase }) {
  const response = await fetch('http://127.0.0.1:8935/capture', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(125000),
    body: JSON.stringify({ povBot, includeBase, updatedAt: observed.updatedAt, home: observed.home, bots: Object.values(observed.bots).map(({ name, session, status, dimension, position }) => ({ name, session, status, dimension, position })) }),
  });
  if (!response.ok) throw new Error('Planning camera failed: ' + await response.text());
  return response.json();
}

export function visualMetadata(frame) {
  const { image, ...metadata } = frame;
  return { ...metadata, bytes: Buffer.byteLength(image.data, 'base64') };
}
