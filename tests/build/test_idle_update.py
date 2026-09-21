"""Queued update policy with a fake clock and installer. No service is contacted."""
from contextlib import redirect_stdout
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('idle_update', ROOT / 'scripts/install-when-idle.py')
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


class IdleUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.support = self.root / 'support'
        self.support.mkdir(mode=0o700)
        self.source = self.root / 'runtime'
        (self.source / 'dist').mkdir(parents=True)
        (self.source / 'package.json').write_text('{"version":"0.10.4"}')
        (self.source / 'dist/upstream.js').write_text('export const source = true;')
        self.dependencies = self.root / 'dependencies'
        (self.dependencies / 'library').mkdir(parents=True)
        (self.dependencies / 'library/index.js').write_text('export const dependency = true;')
        (self.dependencies / '.bin').mkdir()
        (self.dependencies / '.bin/library').symlink_to('../library/index.js')
        (self.source / 'node_modules').symlink_to(self.dependencies, target_is_directory=True)
        self.node = self.root / 'node'
        self.record = {'format': 1, 'activeRelease': {'name': 'old'}, 'configPath': '/synthetic/config'}
        self.fingerprint = {'provider.mjs': 'original'}
        self.now = 0
        self.sleep_calls = []
        self.runner = Mock(return_value=Mock(returncode=0, stdout='', stderr=''))
        self.patches = [
            patch.object(queue.control, 'installation', side_effect=lambda _: copy.deepcopy(self.record)),
            patch.object(queue.control, 'assert_owned_plist'),
            patch.object(queue.manage, 'source_fingerprint', side_effect=lambda _: dict(self.fingerprint)),
            patch.object(queue.manage, 'source_version', return_value=queue.manage.INSTALL_VERSION),
            patch.object(queue.manage, 'reviewed_node_version', return_value=queue.common.EXPECTED_NODE_VERSION),
            patch.object(queue.control, 'status', return_value={'safeToChange': True, 'desktopCompatible': True}),
            patch.object(queue.control, 'diagnostics', return_value={'bridgeVersion': queue.manage.INSTALL_VERSION,
                'diagnostics': {'runtimeVerified': True}}),
        ]
        for entry in self.patches:
            entry.start()
            self.addCleanup(entry.stop)

    def sleep(self, seconds):
        self.sleep_calls.append(seconds)
        self.now += seconds

    def execute(self, timeout=30):
        return queue.wait_and_install(self.source, self.support, self.node, timeout=timeout, interval=5,
                                      clock=lambda: self.now, sleep=self.sleep, run=self.runner)

    def test_busy_timeout_never_runs_installer_or_changes_installation(self):
        queue.control.status.return_value = {'safeToChange': False, 'desktopCompatible': True}
        original = copy.deepcopy(self.record)
        with self.assertRaisesRegex(queue.common.BridgeError, 'expired without forcing'):
            self.execute(timeout=15)
        self.runner.assert_not_called()
        self.assertEqual(self.record, original)
        self.assertEqual(self.now, 15)
        self.assertEqual(queue.control.status.call_count, 3)

    def test_three_consecutive_idle_checks_install_exactly_once_and_verify(self):
        queue.control.status.side_effect = [
            {'safeToChange': safe, 'desktopCompatible': True} for safe in (True, True, False, True, True, True)]
        result = self.execute()
        self.assertTrue(result['complete'])
        self.assertEqual(queue.control.status.call_count, 6)
        self.assertEqual(self.now, 25)
        self.runner.assert_called_once()
        command = self.runner.call_args.args[0]
        self.assertIn('install', command)
        self.assertIn('--apply', command)
        self.assertEqual(command[command.index('--source') + 1], str(self.source))
        self.assertEqual(command[command.index('--support') + 1], str(self.support))
        queue.control.diagnostics.assert_called_once_with(self.support)
        self.assertEqual(json.loads((self.support / 'pending-update.json').read_text())['state'], 'complete')

    def test_candidate_change_cancels_before_calling_installer(self):
        queue.manage.source_fingerprint.side_effect = [{'provider': 'first'}, {'provider': 'changed'}]
        with self.assertRaisesRegex(queue.common.BridgeError, 'candidate changed'):
            self.execute()
        self.runner.assert_not_called()
        queue.control.status.assert_not_called()

    def test_control_change_cancels_before_calling_installer(self):
        queue.control.installation.side_effect = [self.record, {**self.record, 'activeRelease': {'name': 'other'}}]
        with self.assertRaisesRegex(queue.common.BridgeError, 'installation or candidate changed'):
            self.execute()
        self.runner.assert_not_called()
        queue.control.status.assert_not_called()

    def change_candidate_during_final_idle_check(self, change):
        checks = 0
        def status(_):
            nonlocal checks
            checks += 1
            if checks == 3:
                change()
            return {'safeToChange': True, 'desktopCompatible': True}
        queue.control.status.side_effect = status
        with self.assertRaisesRegex(queue.common.BridgeError, 'complete candidate changed'):
            self.execute()
        self.runner.assert_not_called()

    def test_dependency_change_outside_runtime_cancels_before_installer(self):
        self.change_candidate_during_final_idle_check(
            lambda: (self.dependencies / 'library/index.js').write_text('export const dependency = false;'))

    def test_new_untracked_vendor_file_cancels_before_installer(self):
        self.change_candidate_during_final_idle_check(
            lambda: (self.source / 'dist/untracked-upstream.js').write_text('export const unreviewed = true;'))

    def test_dependency_link_retarget_with_identical_files_still_cancels(self):
        other = self.root / 'other-dependencies'
        shutil.copytree(self.dependencies, other, symlinks=True)
        def retarget():
            (self.source / 'node_modules').unlink()
            (self.source / 'node_modules').symlink_to(other, target_is_directory=True)
        self.change_candidate_during_final_idle_check(retarget)

    def test_complete_tree_hash_is_repeatable_and_records_internal_link_identity(self):
        original = queue.candidate_tree_fingerprint(self.source)
        self.assertEqual(queue.candidate_tree_fingerprint(self.source), original)
        alias = self.dependencies / '.bin/library'
        alias.unlink()
        alias.symlink_to('../library/../library/index.js')
        self.assertNotEqual(queue.candidate_tree_fingerprint(self.source), original)

    def test_complete_tree_rejects_cycles_external_links_and_special_files_without_following(self):
        entry = self.dependencies / 'unsafe'
        for target in ('.', str(self.root)):
            with self.subTest(target=target):
                entry.symlink_to(target, target_is_directory=True)
                with self.assertRaisesRegex(queue.common.BridgeError, 'could not be verified'):
                    queue.candidate_tree_fingerprint(self.source)
                entry.unlink()
        first, second = self.dependencies / 'a', self.dependencies / 'b'
        first.symlink_to('b')
        second.symlink_to('a')
        with self.assertRaisesRegex(queue.common.BridgeError, 'could not be verified'):
            queue.candidate_tree_fingerprint(self.source)
        first.unlink()
        second.unlink()
        os.mkfifo(entry)
        with self.assertRaisesRegex(queue.common.BridgeError, 'could not be verified'):
            queue.candidate_tree_fingerprint(self.source)

    def test_manager_failure_is_never_retried(self):
        self.runner.return_value = Mock(returncode=1, stdout='SYNTHETIC_PRIVATE_OUTPUT', stderr='SYNTHETIC_PRIVATE_OUTPUT')
        with self.assertRaisesRegex(queue.common.BridgeError, 'was not retried') as error:
            self.execute()
        self.assertNotIn('SYNTHETIC_PRIVATE_OUTPUT', str(error.exception))
        self.runner.assert_called_once()
        queue.control.diagnostics.assert_not_called()
        self.assertEqual(self.sleep_calls, [5, 5])

    def test_uncertain_installer_timeout_is_never_retried(self):
        self.runner.side_effect = subprocess.TimeoutExpired('synthetic-installer', 300)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.execute()
        self.runner.assert_called_once()
        queue.control.diagnostics.assert_not_called()

    def test_failed_verification_does_not_rerun_installation(self):
        queue.control.diagnostics.return_value = {'bridgeVersion': queue.manage.INSTALL_VERSION,
                                                  'diagnostics': {'runtimeVerified': False}}
        with self.assertRaisesRegex(queue.common.BridgeError, 'needs verification'):
            self.execute()
        self.runner.assert_called_once()

    def test_duplicate_worker_cannot_overwrite_the_active_waiting_record(self):
        status = self.support / 'pending-update.json'
        queue.common.atomic_json(status, {'state': 'waiting', 'targetVersion': queue.manage.INSTALL_VERSION,
                                          'expiresAt': time.time() + 1200})
        before = status.read_bytes()
        output = io.StringIO()
        with queue.common.exclusive_lock(self.support / 'run/queued-update.lock'):
            with patch.object(queue, 'wait_and_install') as worker, redirect_stdout(output):
                result = queue.main(['--support', str(self.support), '--apply'])
        self.assertEqual(result, 1)
        worker.assert_not_called()
        self.assertEqual(status.read_bytes(), before)
        self.assertFalse(json.loads(output.getvalue())['complete'])

    def test_unowned_installation_does_not_create_state_or_lock_directories(self):
        missing = self.root / 'missing-installation'
        queue.control.installation.side_effect = queue.common.BridgeError('Unowned installation.')
        output = io.StringIO()
        with redirect_stdout(output):
            result = queue.main(['--support', str(missing), '--apply'])
        self.assertEqual(result, 1)
        self.assertFalse(missing.exists())

    def test_main_reports_failure_and_releases_worker_lock_without_retry(self):
        output = io.StringIO()
        with patch.object(queue, 'wait_and_install', side_effect=queue.common.BridgeError('The service stayed busy.')) as worker:
            with redirect_stdout(output):
                result = queue.main(['--support', str(self.support), '--apply'])
        self.assertEqual(result, 1)
        worker.assert_called_once()
        self.assertEqual(json.loads((self.support / 'pending-update.json').read_text())['state'], 'stopped')
        with queue.common.exclusive_lock(self.support / 'run/queued-update.lock'):
            pass

    def test_ui_queue_hint_allows_only_known_states_versions_and_private_owned_files(self):
        path = self.support / 'pending-update.json'
        self.assertIsNone(queue.control.pending_update(self.support))
        queue.common.atomic_json(path, {'state': 'waiting', 'targetVersion': queue.manage.INSTALL_VERSION,
                                        'expiresAt': time.time() + 60, 'message': 'SYNTHETIC_SECRET'})
        hint = queue.control.pending_update(self.support)
        self.assertEqual(hint, {'state': 'waiting', 'targetVersion': queue.manage.INSTALL_VERSION})
        self.assertNotIn('SYNTHETIC_SECRET', json.dumps(hint))
        queue.common.atomic_json(path, {'state': 'waiting', 'targetVersion': queue.manage.INSTALL_VERSION,
                                        'expiresAt': time.time() - 1})
        self.assertEqual(queue.control.pending_update(self.support)['state'], 'stopped')
        queue.common.atomic_json(path, {'state': 'complete', 'targetVersion': 'UNREVIEWED'})
        self.assertIsNone(queue.control.pending_update(self.support))
        queue.common.atomic_json(path, {'state': 'unsupported', 'targetVersion': queue.manage.INSTALL_VERSION})
        self.assertIsNone(queue.control.pending_update(self.support))
        path.unlink()
        target = self.root / 'outside.json'
        queue.common.atomic_json(target, {'state': 'complete', 'targetVersion': queue.manage.INSTALL_VERSION})
        path.symlink_to(target)
        self.assertIsNone(queue.control.pending_update(self.support))


if __name__ == '__main__':
    unittest.main()
