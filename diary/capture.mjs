import { readFileSync, writeFileSync } from 'node:fs';

export async function captureDiary(output, {
  statePath = '/var/lib/minecraft-adventure/observations/state.json',
  url = 'http://127.0.0.1:8935/capture',
} = {}) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const observations = {
    updatedAt: state.updatedAt,
    bots: state.bots.map(({ name, status, session, dimension, position }) => ({ name, status, session, dimension, position })),
    povBot: 'Roy',
    includeBase: false,
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(observations),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Diary camera returned ${response.status}: ${await response.text()}`);
  const { frames } = await response.json();
  writeFileSync(output, Buffer.from(frames[0].image.data, 'base64'), { mode: 0o644 });
}

if (import.meta.url === 'file://' + process.argv[1]) await captureDiary(process.argv[2]);
