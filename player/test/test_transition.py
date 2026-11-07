import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('transition', Path(__file__).parents[1] / 'fresh-world.py')
transition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transition)


class TransitionTests(unittest.TestCase):
    def test_identity_cannot_reuse_old_player_or_dimension_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(transition, 'ROOT', root), \
                    patch.object(transition, 'SERVER', root / 'server'), \
                    patch.object(transition, 'PLAYER_STATE', root / 'player'):
                for relative in ['player/used', 'server/world-used', 'server/world-used_nether',
                                 'server/world-used_the_end', 'server/bluemap-used',
                                 'observations/gameplay-used.jsonl']:
                    destination = root / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.touch()
                    with self.assertRaisesRegex(ValueError, 'already has'):
                        transition.require_fresh_identity('used')
                    transition.require_fresh_identity('unused')
                    destination.unlink()

    def test_player_and_sandbox_stop_before_any_archive_or_world_change(self):
        commands = []
        with patch('sys.argv', ['fresh-world.py', '--world-id', 'unused', '--activate']), \
                patch.object(transition.os, 'geteuid', return_value=0), \
                patch.object(transition, 'require_fresh_identity'), \
                patch.object(transition.Path, 'is_file', return_value=True), \
                patch.object(transition, 'run', side_effect=lambda *args: commands.append(args)), \
                patch.object(transition.Path, 'mkdir', side_effect=RuntimeError('archive boundary')):
            with self.assertRaisesRegex(RuntimeError, 'archive boundary'):
                transition.main()
        first_stop = commands[0]
        self.assertEqual(first_stop[:2], ('systemctl', 'stop'))
        for unit in ['minecraft-player.service', 'minecraft-player-sandbox.socket',
                     'minecraft-player-sandbox.service']:
            self.assertIn(unit, first_stop)
        self.assertIn('minecraft-adventure-server.service', commands[-1])

    def test_second_transition_preserves_settings_memory_and_archives_env(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            server = root / 'server'
            config = server / 'plugins/BlueMap'
            old_map = 'bluemap-player-20261101'
            new_id = 'player-20261107-plains'
            new_map = 'bluemap-' + new_id
            (config / 'storages').mkdir(parents=True)
            (config / 'maps').mkdir()
            (server / old_map / 'web').mkdir(parents=True)
            for name in ['minecraft-client-26.3.jar', 'defaultBlockstates.zip', 'resourceExtensions.zip']:
                (server / old_map / name).write_text('current assets')
            (server / old_map / 'web/index.html').write_text('current web')
            (server / old_map / 'web/settings.json').write_text('old map settings')
            (server / 'world-player-20261101').mkdir()
            (server / 'world-player-20261101/level.dat').write_bytes(b'old world')
            properties = 'level-name=world-player-20261101\nlevel-seed=123\ndifficulty=hard\ngamemode=adventure\n'
            (server / 'server.properties').write_text(properties)
            (server / 'whitelist.json').write_text('[]')
            for name, key, suffix in [('core.conf', 'data', ''), ('webserver.conf', 'webroot', '/web'),
                                      ('webapp.conf', 'webroot', '/web'), ('storages/file.conf', 'root', '/web/maps')]:
                (config / name).write_text(f'{key}: "{old_map}{suffix}"\n# bluemap docs\nother: "{old_map}-unrelated"\n')
            for name in ['overworld', 'nether', 'end']:
                (config / 'maps' / f'{name}.conf').write_text('world: "world-player-20261101"\n')
            for name in ['observations', 'control', 'player/player-20261101', 'bots', 'planner', 'diary']:
                (root / name).mkdir(parents=True)
            (root / 'player/player-20261101/notes.json').write_text('old home')
            env_text = '# retain settings\nPLAYER_WORLD_ID=player-20261101\nOTHER=value\n'
            (root / 'player.env').write_text(env_text)
            (root / 'runtime.mjs').touch()
            absolute_paths = {
                '/etc/minecraft-adventure/player.env': root / 'player.env',
                '/opt/minecraft-adventure/player/runtime.mjs': root / 'runtime.mjs',
                '/var/lib/minecraft-planner': root / 'planner',
                '/var/www/roybot.se/minecraft': root / 'diary',
            }
            with patch('sys.argv', ['fresh-world.py', '--world-id', new_id, '--seed', 'plains seed', '--activate']), \
                    patch.object(transition, 'ROOT', root), \
                    patch.object(transition, 'SERVER', server), \
                    patch.object(transition, 'PLAYER_STATE', root / 'player'), \
                    patch.object(transition, 'Path', side_effect=lambda value: absolute_paths.get(str(value), Path(value))), \
                    patch.object(transition.os, 'geteuid', return_value=0), \
                    patch.object(transition.os, 'chown'), \
                    patch.object(transition, 'run'):
                transition.main()
            result = (server / 'server.properties').read_text()
            self.assertIn('level-name=world-' + new_id, result)
            self.assertIn('level-seed=plains\\ seed', result)
            self.assertIn('difficulty=hard\ngamemode=adventure', result)
            self.assertEqual((root / 'player.env').read_text(), env_text.replace('player-20261101', new_id))
            for name in ['core.conf', 'webserver.conf', 'webapp.conf', 'storages/file.conf']:
                text = (config / name).read_text()
                self.assertIn('"' + new_map, text)
                self.assertIn(f'other: "{old_map}-unrelated"', text)
                self.assertIn('# bluemap docs', text)
            for file in (config / 'maps').glob('*.conf'):
                self.assertEqual(file.read_text(), f'world: "world-{new_id}"\n')
            self.assertEqual((server / new_map / 'web/index.html').read_text(), 'current web')
            self.assertFalse((server / new_map / 'web/settings.json').exists())
            self.assertEqual((server / 'world-player-20261101/level.dat').read_bytes(), b'old world')
            self.assertEqual((root / 'player/player-20261101/notes.json').read_text(), 'old home')
            self.assertFalse((root / 'player' / new_id).exists())
            archive, = (root / 'archives').iterdir()
            self.assertEqual((archive / 'player.env').read_text(), env_text)
            self.assertIn('/etc/minecraft-adventure/player.env', (archive / 'ROLLBACK.txt').read_text())
            with transition.tarfile.open(archive / 'server.tar') as backup:
                self.assertEqual(backup.extractfile('server/server.properties').read().decode(), properties)

    def test_env_without_world_id_retains_other_keys_and_appends_separate_line(self):
        self.assertEqual(transition.update_world_env('OTHER=keep', 'new-world'),
                         'OTHER=keep\nPLAYER_WORLD_ID=new-world\n')
        self.assertEqual(transition.update_world_env('', 'new-world'), 'PLAYER_WORLD_ID=new-world\n')

    def test_archive_preserves_named_default_acls_and_keeps_old_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'observations'
            source.mkdir(mode=0o2770)
            (source / 'old-state.json').write_text('old world')
            subprocess.run(['setfacl', '-m', 'u:nobody:r-x,d:u:nobody:r-x', str(source)], check=True)
            old_acl = subprocess.check_output(['getfacl', '--omit-header', str(source)], text=True)
            old = source.stat()
            archive = root / 'archived-observations'
            transition.archive_directory(source, archive)
            self.assertEqual(subprocess.check_output(['getfacl', '--omit-header', str(source)], text=True), old_acl)
            self.assertEqual((source.stat().st_uid, source.stat().st_gid), (old.st_uid, old.st_gid))
            self.assertFalse((source / 'old-state.json').exists())
            self.assertEqual((archive / 'old-state.json').read_text(), 'old world')
            (source / 'new-state.json').write_text('fresh world')
            inherited = subprocess.check_output(['getfacl', '--omit-header', str(source / 'new-state.json')], text=True)
            self.assertIn('user:nobody:r-x', inherited)


if __name__ == '__main__':
    unittest.main()
