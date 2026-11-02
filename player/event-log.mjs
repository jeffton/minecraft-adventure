import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Complete persisted events selected by identity, not an arbitrary byte/line cap. */
export async function readPlayerEvents(file, { session, afterSequence = 0, types } = {}) {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('afterSequence must be a nonnegative safe integer');
  const events = [];
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      if ((!session || event.session === session) && event.sequence > afterSequence && (!types || types.includes(event.type))) events.push(event);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return events;
}
