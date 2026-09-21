"""Renaming the window app must preserve the old installation on failure."""
import importlib.util
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('install_app', ROOT / 'scripts/install-app.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class AppInstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'home'
        self.applications = self.root / 'Applications'
        self.applications.mkdir()
        self.source = self.root / 'build' / installer.APP_BUNDLE
        self.destination = self.applications / installer.APP_BUNDLE
        self.legacy = self.applications / installer.LEGACY_BUNDLE
        self.make_bundle(self.source, 'new')
        self.support = self.home / 'Library/Application Support/EvenCodexBridge'
        self.support.mkdir(parents=True)
        self.sentinel = self.support / 'control.json'
        self.sentinel.write_text('{"untouched": true}\n')
        self.addCleanup(patch.stopall)
        patch.object(installer.Path, 'home', return_value=self.home).start()
        self.signature = patch.object(installer.subprocess, 'run').start()
        self.processes = patch.object(installer.subprocess, 'check_output', return_value='').start()

    def make_bundle(self, path, marker, identifier=installer.IDENTIFIER):
        (path / 'Contents/MacOS').mkdir(parents=True)
        (path / 'Contents/MacOS/G2Bridge').write_text(marker)
        (path / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': identifier,
            'CFBundleExecutable': 'G2Bridge',
            'CFBundleShortVersionString': '1.1.1',
        }))

    def marker(self, path):
        return (path / 'Contents/MacOS/G2Bridge').read_text()

    def backups(self):
        return list((self.support / 'app-backups').glob('*.app'))

    def assert_legacy_intact(self):
        self.assertEqual(self.marker(self.legacy), 'old')
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.backups(), [])
        self.assertEqual(self.sentinel.read_text(), '{"untouched": true}\n')
        self.assertEqual(list(self.applications.glob('.g2-bridge-install-*')), [])

    def test_renames_legacy_bundle_and_preserves_backup_and_service_data(self):
        self.make_bundle(self.legacy, 'old')
        result = installer.install(self.source, self.destination, True)
        self.assertTrue(result['complete'])
        self.assertEqual(result['renamedFrom'], str(self.legacy))
        self.assertFalse(result['bridgeServiceChanged'])
        self.assertEqual(self.marker(self.destination), 'new')
        self.assertFalse(self.legacy.exists())
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual(self.marker(self.backups()[0]), 'old')
        self.assertEqual(self.sentinel.read_text(), '{"untouched": true}\n')

    def test_dry_run_reports_migration_without_writes(self):
        self.make_bundle(self.legacy, 'old')
        result = installer.install(self.source, self.destination)
        self.assertFalse(result['apply'])
        self.assertEqual(result['replaces'], str(self.legacy))
        self.assert_legacy_intact()

    def test_signature_failure_after_install_restores_original_name(self):
        self.make_bundle(self.legacy, 'old')

        def check(arguments, **kwargs):
            if arguments[-1] == str(self.destination):
                raise subprocess.CalledProcessError(1, arguments)

        self.signature.side_effect = check
        with self.assertRaises(subprocess.CalledProcessError):
            installer.install(self.source, self.destination, True)
        self.assert_legacy_intact()

    def test_failed_atomic_rename_restores_original_name(self):
        self.make_bundle(self.legacy, 'old')
        original_rename = Path.rename

        def rename(path, target):
            if path.parent.name.startswith('.g2-bridge-install-'):
                raise OSError('synthetic rename failure')
            return original_rename(path, target)

        with patch.object(Path, 'rename', rename):
            with self.assertRaisesRegex(OSError, 'synthetic rename'):
                installer.install(self.source, self.destination, True)
        self.assert_legacy_intact()

    def test_legacy_wrong_identity_is_never_overwritten(self):
        self.make_bundle(self.legacy, 'old', identifier='org.example.unrelated')
        with self.assertRaisesRegex(ValueError, 'selected bundle'):
            installer.install(self.source, self.destination, True)
        self.assert_legacy_intact()

    def test_legacy_symlink_is_never_followed_or_removed(self):
        target = self.root / 'unrelated.app'
        self.make_bundle(target, 'unrelated')
        self.legacy.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symbolic link'):
            installer.install(self.source, self.destination, True)
        self.assertTrue(self.legacy.is_symlink())
        self.assertEqual(self.marker(target), 'unrelated')
        self.assertFalse(self.destination.exists())

    def test_dangling_destination_symlink_is_rejected(self):
        self.destination.symlink_to(self.root / 'missing.app')
        with self.assertRaisesRegex(ValueError, 'symbolic link'):
            installer.install(self.source, self.destination, True)
        self.assertTrue(self.destination.is_symlink())
        self.assertEqual(self.backups(), [])

    def test_running_legacy_or_current_name_is_rejected(self):
        self.make_bundle(self.legacy, 'old')
        for path in (self.legacy, self.destination):
            with self.subTest(path=path.name):
                self.processes.return_value = str(path / 'Contents/MacOS/G2Bridge') + ' --example\n'
                with self.assertRaisesRegex(ValueError, 'Quit the'):
                    installer.install(self.source, self.destination, True)
                self.assert_legacy_intact()

    def test_app_started_during_staging_prevents_migration(self):
        self.make_bundle(self.legacy, 'old')
        self.processes.side_effect = ['', str(self.legacy / 'Contents/MacOS/G2Bridge') + '\n']
        with self.assertRaisesRegex(ValueError, 'Quit the'):
            installer.install(self.source, self.destination, True)
        self.assert_legacy_intact()

    def test_two_installed_names_are_rejected_without_deleting_either(self):
        self.make_bundle(self.legacy, 'old')
        self.make_bundle(self.destination, 'already renamed')
        with self.assertRaisesRegex(ValueError, 'Both the current and former'):
            installer.install(self.source, self.destination, True)
        self.assertEqual(self.marker(self.destination), 'already renamed')
        self.assertEqual(self.marker(self.legacy), 'old')
        self.assertEqual(self.backups(), [])

    def test_later_update_replaces_new_name_normally(self):
        self.make_bundle(self.destination, 'previous renamed release')
        result = installer.install(self.source, self.destination, True)
        self.assertIsNone(result['renamedFrom'])
        self.assertEqual(self.marker(self.destination), 'new')
        self.assertEqual(self.marker(self.backups()[0]), 'previous renamed release')
        self.assertFalse(self.legacy.exists())

    def test_fresh_install_has_no_backup(self):
        result = installer.install(self.source, self.destination, True)
        self.assertFalse(result['previousAppSaved'])
        self.assertEqual(self.marker(self.destination), 'new')
        self.assertEqual(self.backups(), [])


if __name__ == '__main__':
    unittest.main()
