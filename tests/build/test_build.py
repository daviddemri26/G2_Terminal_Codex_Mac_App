"""Build-boundary checks: independent input, tamper rejection and reproducible output."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('build_runtime', ROOT / 'scripts/build-runtime.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ('bridge', 'integration'):
            shutil.copytree(ROOT / name, self.root / name)
        (self.root / 'operations').mkdir()
        shutil.copy2(ROOT / 'operations/desktop_location.py', self.root / 'operations/desktop_location.py')
        (self.root / 'scripts').mkdir()
        shutil.copy2(ROOT / 'scripts/build-runtime.py', self.root / 'scripts/build-runtime.py')
        for name in ('package-lock.json', 'compatibility.json'):
            shutil.copy2(ROOT / name, self.root / name)
        self.vendor = self.root / 'node_modules/@evenrealities/even-terminal'
        shutil.copytree(ROOT / 'node_modules/@evenrealities/even-terminal', self.vendor)

    def test_repeat_build_matches_installed_bridge_bytes_and_never_mutates_upstream(self):
        upstream_before = {str(p.relative_to(self.vendor)): p.read_bytes()
                           for p in self.vendor.rglob('*') if p.is_file()}
        first, metadata = builder.build(self.root)
        first_hashes = {str(p.relative_to(first)): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in first.rglob('*') if p.is_file() and 'node_modules' not in p.parts}
        second, repeated_metadata = builder.build(self.root)
        second_hashes = {str(p.relative_to(second)): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in second.rglob('*') if p.is_file() and 'node_modules' not in p.parts}
        self.assertEqual(first_hashes, second_hashes)
        self.assertEqual(metadata, repeated_metadata)
        self.assertEqual(upstream_before, {str(p.relative_to(self.vendor)): p.read_bytes()
                                          for p in self.vendor.rglob('*') if p.is_file()})
        imported = json.loads((ROOT / 'docs/provenance/import-0.2.7.json').read_text())
        if metadata['bridgeVersion'] == imported['bridgeVersion']:
            for relative, expected in imported['files'].items():
                if relative.startswith('bridge/') and '.test.' not in relative:
                    path = second / 'dist/desktop-bridge' / Path(relative).name
                    self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), expected, relative)
        for path in (second / 'dist/desktop-bridge').iterdir():
            folder = 'operations' if path.name == 'desktop_location.py' else 'bridge'
            self.assertEqual(path.read_bytes(), (self.root / folder / path.name).read_bytes())
        self.assertFalse(any('.test.' in p.name for p in (second / 'dist/desktop-bridge').iterdir()))

    def test_modified_or_injected_vendor_is_rejected_before_output(self):
        path = self.vendor / 'dist/index.js'
        original = path.read_bytes()
        path.write_bytes(original + b'\n// unexpected modification\n')
        with self.assertRaisesRegex(ValueError, 'modified'):
            builder.build(self.root)
        self.assertFalse((self.root / '.build/runtime').exists())
        path.write_bytes(original)
        (self.vendor / 'dist/unreviewed.js').write_text('export const injected = true;')
        with self.assertRaisesRegex(ValueError, 'Unexpected files'):
            builder.build(self.root)

    def test_changed_upstream_lock_is_rejected(self):
        path = self.root / 'package-lock.json'
        data = json.loads(path.read_text())
        data['packages']['node_modules/@evenrealities/even-terminal']['integrity'] = 'sha512-incorrect'
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'lock does not match'):
            builder.build(self.root)


if __name__ == '__main__':
    unittest.main()
