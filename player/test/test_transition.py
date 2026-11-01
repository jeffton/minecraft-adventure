import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('transition', Path(__file__).parents[1] / 'fresh-world.py')
transition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transition)


class TransitionTests(unittest.TestCase):
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
