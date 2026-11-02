#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) == 0 ]] || { echo 'Root is required to arrange isolated systemd services.' >&2; exit 1; }
SOURCE=$(cd "$(dirname "$0")" && pwd)
TEST_USER=minecraft-controller-e2e
id "$TEST_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$TEST_USER"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ROOT="/var/lib/minecraft-controller-e2e/$RUN_ID"
SERVER="minecraft-controller-e2e-server-$RUN_ID"
BROKER="minecraft-controller-e2e-broker-$RUN_ID"
PROBE="minecraft-controller-e2e-probe-$RUN_ID"
drain_workers() {
    node --input-type=module - "$ROOT/sandbox-root" <<'DRAIN'
import { execFileSync } from 'node:child_process';
const expectedRoot = process.argv[2];
const units = JSON.parse(execFileSync('systemctl', ['list-units', '--all', '--type=service', '--output=json', 'minecraft-skill-*'], { encoding: 'utf8' }));
for (const { unit } of units) {
    try {
        const root = execFileSync('systemctl', ['show', unit, '--property=RootDirectory', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (root === expectedRoot) execFileSync('systemctl', ['stop', unit], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        if (/not found|not loaded|could not be found/i.test(String(error.stderr))) continue;
        console.error(`Failed to drain ${unit}: ${error.message}`);
        process.exitCode = 1;
    }
}
DRAIN
}
cleanup() {
    systemctl stop "$PROBE.service" 2>/dev/null || true
    drain_workers || echo 'Test worker drain failed; continuing service shutdown.' >&2
    systemctl stop "$BROKER.service" "$SERVER.service" 2>/dev/null || true
    # Catch a worker whose transient-unit registration raced broker shutdown.
    drain_workers || echo 'Final test worker drain failed.' >&2
}
trap cleanup EXIT

install -d -o root -g root "$ROOT"
install -d -o "$TEST_USER" -g "$TEST_USER" "$ROOT/server" "$ROOT/state" "$ROOT/output"
install -d "$ROOT/code" "$ROOT/code/test" "$ROOT/code/test/fixtures" "$ROOT/bots"
cp "$SOURCE/../bots/"{compat-loader,inventory-controller,chunk-light}.mjs "$ROOT/bots/"
chmod -R a+rX "$ROOT/bots"
cp "$SOURCE/"*.mjs "$ROOT/code/"
cp "$SOURCE/test/fixtures/controller-survival.mjs" "$ROOT/code/test/fixtures/"
chmod -R a+rX "$ROOT/code"
cp -a /var/lib/minecraft-adventure/server/{paper.jar,libraries,versions,cache} "$ROOT/server/"
install -d "$ROOT/server/plugins"
cp /var/lib/minecraft-adventure/server/plugins/{ViaVersion,ViaBackwards}.jar "$ROOT/server/plugins/"
printf 'eula=true\n' > "$ROOT/server/eula.txt"
cat > "$ROOT/server/server.properties" <<'PROPERTIES'
server-ip=127.0.0.1
server-port=25576
online-mode=false
enforce-secure-profile=false
white-list=false
difficulty=normal
gamemode=survival
force-gamemode=true
level-name=testworld
level-seed=821746
spawn-protection=0
max-players=2
view-distance=3
simulation-distance=3
pause-when-empty-seconds=-1
enable-rcon=false
enable-query=false
enable-command-block=false
sync-chunk-writes=true
PROPERTIES
chown -R "$TEST_USER:$TEST_USER" "$ROOT/server"
node "$SOURCE/sandbox-install.mjs" "$ROOT/sandbox-root"
cat > "$ROOT/broker.mjs" <<BROKER_SOURCE
import { createSandboxBroker } from '$ROOT/code/sandbox-broker.mjs';
import { chmodSync, chownSync } from 'node:fs';
const broker = createSandboxBroker({ root: '$ROOT/sandbox-root' });
broker.listen('$ROOT/sandbox.sock', () => {
    chownSync('$ROOT/sandbox.sock', $(id -u "$TEST_USER"), $(id -g "$TEST_USER"));
    chmodSync('$ROOT/sandbox.sock', 0o600);
});
BROKER_SOURCE
systemd-run --quiet --unit="$SERVER" --collect \
    -p User="$TEST_USER" -p Group="$TEST_USER" -p WorkingDirectory="$ROOT/server" \
    -p PrivateNetwork=yes -p ProtectSystem=strict -p ProtectHome=yes -p NoNewPrivileges=yes \
    -p ReadWritePaths="$ROOT/server" -p MemoryMax=1280M -p MemorySwapMax=0 \
    -p CPUQuota=120% -p TasksMax=64 -p RuntimeMaxSec=1200 \
    /usr/bin/java -Xms256m -Xmx768m -XX:ActiveProcessorCount=2 -jar paper.jar --nogui
systemd-run --quiet --unit="$BROKER" --collect -p RuntimeMaxSec=1200 -p MemoryMax=128M \
    /usr/bin/node "$ROOT/broker.mjs"
node --input-type=module - "$ROOT" <<'READY'
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
const root = process.argv[2];
const deadline = Date.now() + 90_000;
while (true) {
    try {
        const log = await readFile(`${root}/server/logs/latest.log`, 'utf8');
        if (log.includes('Done (') && (await stat(`${root}/sandbox.sock`)).isSocket()) break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() >= deadline) throw new Error('Isolated Paper/broker readiness deadline exceeded');
    await sleep(250);
}
READY
echo "Isolated E2E: $ROOT; server=$SERVER; probe=$PROBE"
systemd-run --unit="$PROBE" --wait --collect \
    -p User="$TEST_USER" -p Group="$TEST_USER" \
    -p PrivateNetwork=yes -p JoinsNamespaceOf="$SERVER.service" \
    -p ProtectSystem=strict -p ProtectHome=yes -p NoNewPrivileges=yes \
    -p ReadWritePaths="$ROOT/state $ROOT/output" \
    -p InaccessiblePaths='/run/minecraft-planner-auth /var/lib/minecraft-player /var/lib/minecraft-planner /var/lib/minecraft-adventure' \
    -p MemoryMax=384M -p MemorySwapMax=0 -p TasksMax=32 -p RuntimeMaxSec=800 \
    -p Environment="CONTROLLER_E2E_ROOT=$ROOT" \
    /usr/bin/node "$ROOT/code/test-controller-live.mjs"
echo "Evidence: $ROOT/output/report.json"
