// Shared IPC allocation bound, not a separate controller/source/state policy.
// One MiB is small relative to the OS sandbox's 192 MiB memory allocation.
export const MAX_FRAME_BYTES = 1_048_576;

export function sendFrame(stream, value) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Sandbox frame exceeds 1 MiB');
  if (stream.destroyed || stream.writableEnded) throw new Error('Sandbox connection is closed');
  stream.write(line);
}

export function readFrames(stream, onFrame, onError) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  const fail = error => {
    if (failed) return;
    failed = true;
    onError(error);
  };
  stream.on('data', chunk => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.includes(10)) {
      const index = buffer.indexOf(10);
      if (index + 1 > MAX_FRAME_BYTES) return fail(new Error('Sandbox frame exceeds 1 MiB'));
      const line = buffer.subarray(0, index).toString('utf8');
      buffer = buffer.subarray(index + 1);
      try { onFrame(JSON.parse(line)); } catch (error) { return fail(error); }
    }
    if (buffer.length > MAX_FRAME_BYTES) fail(new Error('Sandbox frame exceeds 1 MiB'));
  });
  stream.on('end', () => {
    if (buffer.length) fail(new Error('Incomplete sandbox frame'));
  });
  stream.on('error', fail);
}
