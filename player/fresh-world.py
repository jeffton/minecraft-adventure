#!/usr/bin/env python3
"""Explicit one-time world transition. Archives stopped state; never deletes worlds."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

ROOT = Path('/var/lib/minecraft-adventure')
SERVER = ROOT / 'server'
PLAYER_STATE = Path('/var/lib/minecraft-player')


def require_fresh_identity(world_id):
    destinations = [
        PLAYER_STATE / world_id,
        ROOT / 'observations' / f'gameplay-{world_id}.jsonl',
        SERVER / f'bluemap-{world_id}',
        *(SERVER / f'world-{world_id}{suffix}' for suffix in ['', '_nether', '_the_end']),
    ]
    if any(destination.exists() for destination in destinations):
        raise ValueError('World identity already has world, map or player data; use a new identity')


def replace_property(text, key, value):
    pattern = rf'(?m)^{re.escape(key)}=.*$'
    if len(re.findall(pattern, text)) != 1:
        raise ValueError(f'Expected one {key} property')
    return re.sub(pattern, f'{key}={value}', text)


def run(*args):
    subprocess.run(args, check=True)


def archive_directory(source, destination):
    info = source.stat()
    source.rename(destination)
    source.mkdir(mode=info.st_mode & 0o7777)
    os.chown(source, info.st_uid, info.st_gid)
    source.chmod(info.st_mode & 0o7777)
    acl = subprocess.check_output(['getfacl', '--omit-header', str(destination)], text=True)
    subprocess.run(['setfacl', '--set-file=-', str(source)], input=acl, text=True, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--world-id', required=True)
    parser.add_argument('--activate', action='store_true', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,63}', args.world_id):
        raise ValueError('Root and a safe explicit world identity are required')
    world_name = 'world-' + args.world_id
    map_name = 'bluemap-' + args.world_id
    require_fresh_identity(args.world_id)
    if not Path('/opt/minecraft-adventure/player/runtime.mjs').is_file():
        raise ValueError('Install and review the player before changing the world')
    run('systemctl', 'stop', 'minecraft-adventure-diary.timer', 'minecraft-adventure-diary.service',
        'minecraft-player.service', 'minecraft-player-sandbox.socket', 'minecraft-player-sandbox.service')
    run('systemctl', 'disable', '--now', 'minecraft-adventure-bots.service', 'minecraft-planner.service')
    run('systemctl', 'stop', 'minecraft-building-camera.service', 'minecraft-adventure-server.service')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    archive = ROOT / 'archives' / f'{stamp}-before-{args.world_id}'
    archive.mkdir(parents=True, mode=0o700)
    archive.chmod(0o700)
    with tarfile.open(archive / 'server.tar', 'w') as backup:
        backup.add(SERVER, arcname='server')
    with tarfile.open(archive / 'agent-data.tar', 'w') as backup:
        for source in [PLAYER_STATE, ROOT / 'bots', Path('/var/lib/minecraft-planner'), Path('/var/www/roybot.se/minecraft')]:
            backup.add(source, arcname=str(source).lstrip('/'))
    manifest = {'worldId': args.world_id, 'oldWorldRetained': True, 'archives': {}}
    for file in ['server.tar', 'agent-data.tar']:
        digest = hashlib.file_digest((archive / file).open('rb'), 'sha256').hexdigest()
        manifest['archives'][file] = digest
    (archive / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    shutil.copy2(SERVER / 'server.properties', archive / 'server.properties')
    shutil.copytree(SERVER / 'plugins/BlueMap', archive / 'BlueMap-config')
    for directory in ['observations', 'control']:
        archive_directory(ROOT / directory, archive / directory)
    properties = (SERVER / 'server.properties').read_text()
    for key, value in [('level-name', world_name), ('difficulty', 'normal'), ('gamemode', 'survival'), ('level-seed', '')]:
        properties = replace_property(properties, key, value)
    (SERVER / 'server.properties').write_text(properties)
    whitelist_file = SERVER / 'whitelist.json'
    whitelist = json.loads(whitelist_file.read_text())
    whitelist_file.write_text(json.dumps([entry for entry in whitelist if entry['name'] not in ['Spruce', 'Flint', 'Moss']], indent=2) + '\n')
    config = SERVER / 'plugins/BlueMap'
    for name in ['core.conf', 'webserver.conf', 'webapp.conf', 'storages/file.conf']:
        file = config / name
        file.write_text(file.read_text().replace('bluemap', map_name))
    for file in (config / 'maps').glob('*.conf'):
        file.write_text(file.read_text().replace('world: "world"', f'world: "{world_name}"'))
    old_map = SERVER / 'bluemap'
    new_map = SERVER / map_name
    new_map.mkdir(mode=0o750)
    for name in ['minecraft-client-26.3.jar', 'defaultBlockstates.zip', 'resourceExtensions.zip']:
        shutil.copy2(old_map / name, new_map / name)
    web = new_map / 'web'
    web.mkdir(mode=0o750)
    for item in (old_map / 'web').iterdir():
        if item.name in ['maps', 'settings.json']:
            continue
        destination = web / item.name
        if item.is_dir():
            shutil.copytree(item, destination)
        else:
            shutil.copy2(item, destination)
    account = SERVER.stat()
    for directory, dirs, files in os.walk(new_map):
        for name in dirs + files:
            os.chown(Path(directory) / name, account.st_uid, account.st_gid)
    os.chown(new_map, account.st_uid, account.st_gid)
    env = Path('/etc/minecraft-adventure/player.env')
    env.write_text(f'PLAYER_WORLD_ID={args.world_id}\n')
    env.chmod(0o600)
    (archive / 'ROLLBACK.txt').write_text('Stop minecraft-player and Paper. Restore server properties, whitelist and BlueMap configuration from server.tar before starting Paper; original world remains present. Restore observations/control from this archive and re-enable old bots/planner only when deliberately rolling back. Do not overlay a live world.\n')
    print(json.dumps({'archive': str(archive), 'worldId': args.world_id, 'worldDirectory': world_name, 'mapDirectory': map_name, 'started': False}))


if __name__ == '__main__':
    main()
