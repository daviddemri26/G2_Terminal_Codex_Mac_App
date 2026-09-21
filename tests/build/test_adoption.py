"""A changed or missing runtime dependency must never be silently adopted."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('adopt_installation', ROOT / 'scripts/adopt-installation.py')
adoption = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adoption)


class AdoptionTests(unittest.TestCase):
    def test_dependency_byte_change_or_removal_blocks_adoption(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            relative = 'node_modules/example/index.js'
            target = source / relative
            target.parent.mkdir(parents=True)
            target.write_bytes(b'original')
            manifest = {'files': {relative: hashlib.sha256(b'original').hexdigest()}}
            self.assertEqual(adoption.verify_equivalent(source, manifest), (1, []))
            target.write_bytes(b'changed')
            with self.assertRaisesRegex(adoption.BridgeError, 'differs'):
                adoption.verify_equivalent(source, manifest)
            target.unlink()
            with self.assertRaisesRegex(adoption.BridgeError, 'differs'):
                adoption.verify_equivalent(source, manifest)

    def test_only_project_tests_can_be_omitted(self):
        with tempfile.TemporaryDirectory() as directory:
            relative = 'dist/desktop-bridge/provider.test.mjs'
            self.assertEqual(adoption.verify_equivalent(Path(directory), {'files': {relative: 'unused'}}), (0, [relative]))
            with self.assertRaises(adoption.BridgeError):
                adoption.verify_equivalent(Path(directory), {'files': {'dist/desktop-bridge/provider.mjs': 'missing'}})

    def test_unexpected_executable_addition_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / 'dist').mkdir()
            (source / 'dist/unknown-plugin.js').write_text('unreviewed')
            with self.assertRaisesRegex(adoption.BridgeError, 'Unexpected files'):
                adoption.verify_equivalent(source, {'files': {}})


if __name__ == '__main__':
    unittest.main()
