#!/usr/bin/env python3
"""Install a fresh, stopped Minecraft Adventure stack. Run as root after review."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import urllib.request
import uuid

SOURCE = Path(__file__).resolve().parent
RUNTIME = Path('/var/lib/minecraft-adventure')
DOWNLOADS = {
    'server/paper.jar': (
        'https://fill-data.papermc.io/v1/objects/4ebaf5c9da98c654bb8f17245799943dfb05a285830be4307bfdf7bc9ca024bf/paper-26.3-235.jar',
        '4ebaf5c9da98c654bb8f17245799943dfb05a285830be4307bfdf7bc9ca024bf',
    ),
    'bin/velocity.jar': (
        'https://fill-data.papermc.io/v1/objects/0844bcabdcdb4f5b875906fd4c3365bc1bb76918e42bc595ed88ad195258dd75/velocity-4.3.1-45.jar',
        '0844bcabdcdb4f5b875906fd4c3365bc1bb76918e42bc595ed88ad195258dd75',
    ),
    'server/plugins/ViaVersion.jar': (
        'https://github.com/ViaVersion/ViaVersion/releases/download/5.12.2/ViaVersion-5.12.2.jar',
        '24e4876fefe73e08a4c87cd6c457ee0916e62dd69656631caf41e26f909d504b',
    ),
    'server/plugins/ViaBackwards.jar': (
        'https://github.com/ViaVersion/ViaBackwards/releases/download/5.12.2/ViaBackwards-5.12.2.jar',
        '9a148a80ea22074f4bd1626cdbe254a4cd998bf44e7ceaff4e285a1b6b35da42',
    ),
}
BOTS = ['Roy', 'Spruce', 'Flint', 'Moss']


def offline_uuid(name):
    digest = hashlib.md5(('OfflinePlayer:' + name).encode()).digest()
    return str(uuid.UUID(bytes=digest, version=3))


def write(path, content, mode=0o640):
    path.write_text(content)
    path.chmod(mode)
    shutil.chown(path, user='minecraft-adventure', group='minecraft-adventure')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--whitelist', type=Path, required=True, help='Private JSON file containing human Minecraft name/UUID entries')
    arguments = parser.parse_args()
    humans = json.loads(arguments.whitelist.read_text())
    for player in humans:
        uuid.UUID(player['uuid'])
    if os.geteuid() != 0:
        raise SystemExit('Run installation as root; services run as minecraft-adventure.')
    if (RUNTIME / 'server/server.properties').exists():
        raise SystemExit('Existing installation: inspect and update explicitly, do not replace it.')
    subprocess.run(['groupadd', '--system', 'minecraft-adventure-project'], check=True)
    subprocess.run([
        'useradd', '--system', '--user-group', '--home-dir', str(RUNTIME),
        '--shell', '/usr/sbin/nologin', 'minecraft-adventure',
    ], check=True)
    account = pwd.getpwnam('minecraft-adventure')
    for name in [
        'server', 'server/plugins', 'server/plugins/bStats', 'server/plugins/ViaVersion',
        'server/config', 'bin', 'proxy-public', 'proxy-public/plugins',
        'proxy-public/plugins/bStats', 'proxy-local', 'proxy-local/plugins',
        'proxy-local/plugins/bStats',
    ]:
        directory = RUNTIME / name
        directory.mkdir(parents=True, mode=0o750, exist_ok=True)
        directory.chmod(0o750)
        os.chown(directory, account.pw_uid, account.pw_gid)
    RUNTIME.chmod(0o751)
    for name in ['control', 'observations']:
        directory = RUNTIME / name
        directory.mkdir(mode=0o2770)
        shutil.chown(directory, user='minecraft-adventure', group='minecraft-adventure-project')
        directory.chmod(0o2770)
    for relative, (url, expected_hash) in DOWNLOADS.items():
        request = urllib.request.Request(url, headers={'User-Agent': 'minecraft-adventure/1.0'})
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != expected_hash:
            raise RuntimeError('Download checksum mismatch: ' + relative)
        destination = RUNTIME / relative
        destination.write_bytes(data)
        destination.chmod(0o640)
        os.chown(destination, account.pw_uid, account.pw_gid)
    # The secret stays exclusively in private runtime files, never in source or logs.
    forwarding_secret = secrets.token_hex(32)
    for kind, bind, online, rate in [
        ('public', '0.0.0.0:25565', 'true', '3000'),
        ('local', '127.0.0.1:25567', 'false', '0'),
    ]:
        directory = RUNTIME / ('proxy-' + kind)
        template = (SOURCE / 'velocity.toml').read_text()
        content = template.replace('@BIND@', bind).replace('@ONLINE@', online).replace('@RATE@', rate)
        write(directory / 'velocity.toml', content)
        write(directory / 'forwarding.secret', forwarding_secret, mode=0o600)
        write(directory / 'plugins/bStats/config.txt', 'enabled=false\n')
    write(RUNTIME / 'server/plugins/bStats/config.yml', 'enabled: false\n')
    write(RUNTIME / 'server/plugins/ViaVersion/config.yml', (
        'check-for-updates: false\n'
        "block-versions: ['<1.21.4']\n"
    ))
    write(RUNTIME / 'server/config/paper-global.yml', (
        'proxies:\n'
        '  velocity:\n'
        '    enabled: true\n'
        '    online-mode: true\n'
        f'    secret: "{forwarding_secret}"\n'
    ), mode=0o600)
    write(RUNTIME / 'server/server.properties', (SOURCE / 'server.properties').read_text())
    write(RUNTIME / 'server/eula.txt', 'eula=true\n')
    players = [{'name': player['name'], 'uuid': player['uuid']} for player in humans]
    players.extend({'name': name, 'uuid': offline_uuid(name)} for name in BOTS)
    write(RUNTIME / 'server/whitelist.json', json.dumps(players, indent=2) + '\n')
    write(RUNTIME / 'server/ops.json', '[]\n')
    for name in [
        'minecraft-adventure.slice',
        'minecraft-adventure-server.service',
        'minecraft-adventure-proxy@.service',
    ]:
        shutil.copyfile(SOURCE / name, Path('/etc/systemd/system') / name)
        (Path('/etc/systemd/system') / name).chmod(0o644)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    print('Installed stopped stack. Review and test loopback services before enabling public access.')


if __name__ == '__main__':
    main()
