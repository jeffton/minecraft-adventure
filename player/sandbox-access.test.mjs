import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, chownSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createSandboxBroker } from './sandbox-broker.mjs';
import { prepareSandboxRoot } from './sandbox-install.mjs';

const run = promisify(execFile);

test('nonroot minecraft-bots client can execute through the group-restricted root broker', { skip: process.getuid?.() !== 0 }, async () => {
  const directory = mkdtempSync('/var/lib/minecraft-sandbox-access-test-');
  chmodSync(directory, 0o755);
  prepareSandboxRoot(join(directory, 'root'));
  for (const name of ['sandbox.mjs', 'sandbox-protocol.mjs']) {
    const path = join(directory, name);
    copyFileSync(new URL(name, import.meta.url), path);
    chmodSync(path, 0o644);
  }
  const socketPath = join(directory, 'broker.sock');
  const broker = createSandboxBroker({ root: join(directory, 'root') });
  await new Promise(resolve => broker.listen(socketPath, resolve));
  const { stdout: group } = await run('/usr/bin/getent', ['group', 'minecraft-adventure-project']);
  chownSync(socketPath, 0, Number(group.split(':')[2]));
  chmodSync(socketPath, 0o660);
  try {
    const code = `
      import { SkillSandbox } from ${JSON.stringify(new URL(`file://${directory}/sandbox.mjs`).href)};
      let count=0;
      const rpc={observe:()=>({inventory:[{name:'oak_log',count}]}),call:async(method,args)=>count+=args[0],cancel(){}};
      const sandbox=new SkillSandbox({rpc,socketPath:${JSON.stringify(socketPath)}});
      const id=sandbox.start('return await mc.call("collect",2)',{name:'Collect two logs',worldId:'nonroot-test'});
      const result=await sandbox.wait(id);
      console.log(JSON.stringify({uid:process.getuid(),result}));
    `;
    const { stdout } = await run('/usr/sbin/runuser', ['-u', 'minecraft-bots', '--', '/usr/bin/node', '--input-type=module', '-e', code], { timeout: 20_000 });
    const value = JSON.parse(stdout);
    assert.notEqual(value.uid, 0);
    assert.equal(value.result.state, 'completed', stdout);
    assert.equal(value.result.name, 'Collect two logs');
    assert.equal(value.result.value, 2);
    assert.equal(value.result.after.inventory[0].count, 2);
    const denied = await run('/usr/sbin/runuser', ['-u', 'nobody', '--', '/usr/bin/node', '--input-type=module', '-e', `
      import net from 'node:net';
      const socket=net.connect(${JSON.stringify(socketPath)});
      socket.on('connect',()=>{console.log('UNEXPECTED');socket.end();});
      socket.on('error',error=>console.log(error.code));
    `]);
    assert.equal(denied.stdout.trim(), 'EACCES');
  } finally {
    await new Promise(resolve => broker.close(resolve));
  }
});
