import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { MAX_FRAME_BYTES, readFrames, sendFrame } from '../sandbox-protocol.mjs';

function receiver() {
  const stream = new PassThrough();
  const frames = [];
  const failures = [];
  readFrames(stream, frame => frames.push(frame), error => failures.push(error));
  return { stream, frames, failures };
}

test('IPC admission and decoding agree on the exact serialized frame boundary', () => {
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ text: '' }) + '\n');
  const payload = { text: 'x'.repeat(MAX_FRAME_BYTES - envelopeBytes) };
  const f = receiver();
  sendFrame(f.stream, payload);
  assert.deepEqual(f.frames, [payload]);
  assert.deepEqual(f.failures, []);
  assert.throws(() => sendFrame(f.stream, { text: payload.text + 'x' }), /1 MiB/);
  const other = receiver();
  other.stream.write(JSON.stringify({ text: payload.text + 'x' }) + '\n');
  assert.equal(other.frames.length, 0);
  assert.match(other.failures[0].message, /1 MiB/);
});

test('IPC bounds serialized UTF-8 and escapes, not raw JavaScript string length', () => {
  const f = receiver();
  const payload = { text: '🌊\n'.repeat(30_000) };
  const encoded = Buffer.from(JSON.stringify(payload) + '\n');
  for (let offset = 0; offset < encoded.length; offset += 8191) f.stream.write(encoded.subarray(offset, offset + 8191));
  assert.deepEqual(f.frames, [payload]);
  assert.deepEqual(f.failures, []);
  assert.throws(() => sendFrame(f.stream, { text: '\n'.repeat(MAX_FRAME_BYTES / 2) }), /1 MiB/);
});
