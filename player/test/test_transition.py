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
