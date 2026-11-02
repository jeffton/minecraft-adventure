import { createServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFrames, sendFrame } from './sandbox-protocol.mjs';

export function sandboxCommand(root, unit, timeoutMs) {
  return [
    '--quiet', '--pipe', '--wait', '--collect', `--unit=${unit}`,
    '-p', `RootDirectory=${root}`,
    '-p', 'DynamicUser=yes', '-p', 'NoNewPrivileges=yes',
    '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=yes',
    '-p', 'PrivateNetwork=yes', '-p', 'PrivateDevices=yes',
    '-p', 'ProtectProc=invisible', '-p', 'ProcSubset=pid',
    '-p', 'CapabilityBoundingSet=', '-p', 'RestrictSUIDSGID=yes',
    '-p', 'RestrictNamespaces=yes', '-p', 'RestrictAddressFamilies=AF_UNIX',
    '-p', 'SystemCallFilter=@system-service',
    '-p', 'MemoryMax=192M', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=50%',
    '-p', 'TasksMax=24', '-p', 'LimitNOFILE=64', '-p', 'LimitFSIZE=1048576',
    '-p', 'TemporaryFileSystem=/tmp:rw,size=8M',
    '-p', `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}`,
    '-p', 'TimeoutStopSec=2', '-p', 'KillMode=control-group',
    '-p', 'WorkingDirectory=/',
    '/usr/bin/node', '--max-old-space-size=64', '/worker.mjs'
  ];
}

export function createSandboxBroker({ root, timeoutMs = 120_000, onEvent = () => {} }) {
  let busy = false;
  return createServer({ allowHalfOpen: true }, socket => {
    let child;
    let unit;
    let started = false;
    let stopped = false;
    let timer;
    let rpcPending;
    let completed = false;
    let resultMessage;
    let childClosed = false;
    let frames = 0;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (unit && !childClosed) execFile('/usr/bin/systemctl', ['stop', unit], { timeout: 5000 }, error => {
        if (error) onEvent({ type: 'stop-error', unit, error: error.message });
        // If cancel raced unit registration, terminate the launcher and issue a second stop
        // once it exits. This prevents an in-flight manager request from creating an orphan.
        if (child && child.exitCode === null) child.kill('SIGTERM');
      });
      child?.stdin.destroy();
      // systemd owns the entire descendant cgroup; killing systemd-run alone is insufficient.
    };
    const fail = error => {
      if (!socket.destroyed) {
        try { sendFrame(socket, { type: 'error', error: String(error.message ?? error) }); } catch {}
      }
      stop();
      if (!child || childClosed) socket.end();
    };
    socket.setTimeout(10_000, () => fail(new Error('Sandbox client inactive')));
    socket.on('close', stop);
    socket.on('end', () => {
      stop();
      if (!child || childClosed) socket.end();
    });
    readFrames(socket, message => {
      if (message.type === 'start' && !started) {
        if (busy) throw new Error('Sandbox already has an active action');
        if (typeof message.code !== 'string') throw new Error('Skill code must be a string');
        if (typeof message.worldId !== 'string' || !message.worldId || message.worldId.length > 128) {
          throw new Error('A worldId of at most 128 characters is required');
        }
        started = true;
        busy = true;
        socket.setTimeout(0);
        unit = `minecraft-skill-${randomUUID()}.service`;
        child = spawn('/usr/bin/systemd-run', sandboxCommand(root, unit, timeoutMs), {
          stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }
        });
        timer = setTimeout(() => fail(new Error('Skill execution deadline exceeded')), timeoutMs + 3000);
        let stderr = '';
        child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
        child.on('error', fail);
        child.stdin.on('error', error => {
          if (!completed && !stopped) fail(error);
        });
        child.on('close', code => {
          const drained = () => {
            childClosed = true;
            busy = false;
            clearTimeout(timer);
            if (!completed && !stopped) {
              fail(new Error(`Sandbox exited ${code}: ${stderr.trim()}`));
            } else if (resultMessage && !stopped) {
              // A completed handle promises the broker is ready for its immediate successor.
              sendFrame(socket, resultMessage);
            }
            socket.end();
            onEvent({ type: 'exit', unit, code });
          };
          if (stopped) execFile('/usr/bin/systemctl', ['stop', unit], { timeout: 5000 }, error => {
            if (error) onEvent({ type: 'stop-error', unit, error: error.message });
            drained();
          });
          else drained();
        });
        readFrames(child.stdout, response => {
          if (stopped) return;
          if (++frames > 2048) throw new Error('Skill exceeded RPC/output frame budget');
          if (completed) throw new Error('Output after skill result');
          if (response.type === 'rpc') {
            if (rpcPending !== undefined) throw new Error('Only one Minecraft RPC may be active');
            if (!Number.isSafeInteger(response.id) || typeof response.method !== 'string' || !Array.isArray(response.args)) {
              throw new Error('Invalid Minecraft RPC frame');
            }
            rpcPending = response.id;
          } else if (response.type === 'result' || response.type === 'error') {
            if (rpcPending !== undefined) throw new Error('Skill ended during active Minecraft RPC');
            completed = true;
            resultMessage = response;
          } else {
            throw new Error('Unsupported skill output');
          }
          if (response.type === 'rpc') sendFrame(socket, response);
        }, fail);
        sendFrame(child.stdin, { type: 'start', code: message.code, input: message.input ?? null });
        onEvent({ type: 'start', unit, worldId: message.worldId });
      } else if (message.type === 'reply' && started && rpcPending === message.id && !completed && !stopped) {
        rpcPending = undefined;
        sendFrame(child.stdin, { type: 'reply', id: message.id, value: message.value, error: message.error });
      } else if (message.type === 'cancel') {
        stop();
        if (!child || childClosed) socket.end();
      } else {
        throw new Error('Unexpected sandbox client message');
      }
    }, fail);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.getuid() !== 0) throw new Error('Sandbox broker requires root; worker skills never run as root');
  const broker = createSandboxBroker({ root: '/var/lib/minecraft-player-sandbox/root', onEvent: event => {
    console.log(JSON.stringify(event));
  } });
  // systemd socket activation supplies the root-owned, group-restricted Unix socket.
  if (process.env.LISTEN_FDS !== '1') throw new Error('Launch using minecraft-player-sandbox.socket');
  broker.listen({ fd: 3 });
}
