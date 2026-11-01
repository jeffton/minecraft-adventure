// Untrusted skills run only inside the OS sandbox prepared by sandbox.mjs.
import { createInterface } from 'node:readline';

const pending = new Map();
let sequence = 0;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

async function run({ code, input }) {
  // Do not expose the launching service's environment to generated code.
  for (const key of Object.keys(process.env)) delete process.env[key];
  const mc = Object.freeze({
    call(method, ...args) {
      if (pending.size >= 1) throw new Error('Await each Minecraft call before issuing another');
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ type: 'rpc', id, method, args });
      });
    },
    observe() { return this.call('observe'); }
  });
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const value = await new AsyncFunction('mc', 'input', `"use strict";\n${code}`)(mc, input);
    process.stdout.write(`${JSON.stringify({ type: 'result', value: value ?? null })}\n`, () => process.exit(0));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: 'error', error: String(error.stack ?? error) })}\n`, () => process.exit(1));
  }
}

let started = false;
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'start' && !started) {
    started = true;
    void run(message);
  } else if (message.type === 'reply') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.value);
  }
});
