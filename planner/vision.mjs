import { createHash } from 'node:crypto';

export const VISION_INSTRUCTIONS = `An attached image is a real current render of the shared base from an elevated observer camera, not a bot action or a completed-building certificate. Use it to assess visible gaps, access and shelter shape alongside block/event evidence. Occluded terrain is unknown; a picture cannot establish chest contents, spawn acknowledgement, structural completeness or events outside its view. Include strategy.visualAssessment: one short concrete sentence about what is visibly present or missing and how it affects the next building task. Never claim to have seen an image when none is attached.`;

export function needsBuildingView(observed, strategy) {
  if (!observed.home) return false;
  const programs = Object.values(observed.bots).flatMap(bot => [bot.task ?? '']);
  return /shelter|lodge|house|base|build|chest|bed/i.test([
    observed.objective, strategy?.goal?.title, ...(strategy?.nextGoals ?? []), ...programs,
  ].join(' '));
}

export function durableInput(messages, images = []) {
  const text = { type: 'text', text: JSON.stringify({ conversation: messages }) };
  return images.length ? [text, ...images] : text.text;
}

export function validateVisualFrame(frame, home, now = Date.now()) {
  if (frame.home.dimension !== home.dimension || ['x', 'y', 'z'].some(axis => frame.home[axis] !== home[axis])) {
    throw new Error('Building camera belongs to a different base');
  }
  const age = now - Date.parse(frame.capturedAt);
  if (!Number.isFinite(age) || age < -5000 || age > 90000) throw new Error('Building camera image is stale');
  const data = Buffer.from(frame.image.data, 'base64');
  if (frame.image.type !== 'image' || frame.image.mimeType !== 'image/webp' || data.length > 1024 * 1024 ||
      data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('Building camera returned an invalid WebP image');
  }
  if (createHash('sha256').update(data).digest('hex') !== frame.sha256) throw new Error('Building camera image checksum mismatch');
  return frame;
}

export function validateVisualSource(frame, observed) {
  validateVisualFrame(frame, observed.home);
  const bot = Object.values(observed.bots).find(bot => bot.name === frame.bot);
  if (!bot || bot.status !== 'online' || bot.session !== frame.sourceSession || bot.dimension !== frame.sourceDimension ||
      bot.dimension !== observed.home.dimension || Date.parse(observed.updatedAt) < Date.parse(frame.capturedAt) ||
      Date.parse(bot.updatedAt) < Date.parse(frame.capturedAt)) {
    throw new Error('Building camera source session/dimension is not confirmed after capture');
  }
}

export async function captureBuildingView(observed) {
  const response = await fetch('http://127.0.0.1:8935/capture', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(65000),
    body: JSON.stringify({ updatedAt: observed.updatedAt, home: observed.home, bots: Object.values(observed.bots).map(({ name, session, status, dimension, position }) => ({ name, session, status, dimension, position })) }),
  });
  if (!response.ok) throw new Error('Building camera failed: ' + await response.text());
  return validateVisualFrame(await response.json(), observed.home);
}

export function visualMetadata(frame) {
  const { image, ...metadata } = frame;
  return { ...metadata, bytes: Buffer.byteLength(image.data, 'base64') };
}
