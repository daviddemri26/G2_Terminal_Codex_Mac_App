"""Offline lifecycle tests: no launchd calls, real processes, tokens, or live API use."""
import json
import os
from pathlib import Path
import plistlib
import signal
import tempfile
import unittest
from unittest.mock import Mock, patch

import common
import manage
import supervisor


class OperationsTests(unittest.TestCase):
    def setUp(self):
        login_preference = patch.object(manage, 'launch_at_login', return_value=True)
        login_preference.start()
        self.addCleanup(login_preference.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.support = self.root / 'support'
        self.source = self.root / 'source'
        for path in ('dist/routes', 'dist/desktop-bridge', 'dist/startup', 'dist/codex', 'bin', 'node_modules/library'):
            (self.source / path).mkdir(parents=True, exist_ok=True)
        (self.source / 'dist/routes/core.js').write_text(
            'createDesktopProvider desktopBridgeEnabled EVEN_CODEX_DESKTOP_BRIDGE ensure-app-server')
        (self.source / 'dist/routes/events.js').write_text('events')
        (self.source / 'dist/codex/session.js').write_text('patched session')
        (self.source / 'dist/startup/common.js').write_text('startup')
        (self.source / 'dist/desktop-bridge/provider.mjs').write_text("version: 'G2 Desktop Bridge 0.2'")
        (self.source / 'bin/cli.js').write_text('verified CLI')
        (self.source / 'node_modules/library/index.js').write_text('frozen dependency')
        (self.source / 'package.json').write_text(json.dumps({'version': '0.10.4'}))
        self.config_path = self.root / 'config.json'
        self.config_path.write_text(json.dumps({'token': 'SYNTHETIC_TEST_SECRET', 'port': 3456}))
        self.config = common.load_config(self.config_path)

    def tearDown(self):
        self.temp.cleanup()

    def release(self):
        with patch.object(manage, 'command_output', return_value=common.EXPECTED_NODE_VERSION):
            return manage.prepare_release(self.source, self.support, '/test/node')

    def control(self, active, previous=None):
        return {'format': 1, 'activeRelease': active, 'previousRelease': previous,
            'configPath': str(self.config_path), 'sourcePackage': str(self.source),
            'sourceFingerprint': manage.source_fingerprint(self.source), 'label': common.LABEL}

    def test_snapshot_copies_dependencies_and_survives_npm_replacement(self):
        reference = self.release()
        (self.source / 'node_modules/library/index.js').write_text('replacement engine')
        with patch.object(common, 'command_output', return_value=common.EXPECTED_NODE_VERSION):
            root, _ = common.validate_release(self.support, reference)
        self.assertEqual((root / 'package/node_modules/library/index.js').read_text(), 'frozen dependency')
        self.assertFalse(any(path.is_symlink() for path in root.rglob('*')))

    def test_tampered_frozen_runtime_is_rejected(self):
        reference = self.release()
        path = self.support / 'releases' / reference['name'] / 'package/bin/cli.js'
        path.write_text('unreviewed CLI')
        with self.assertRaises(common.BridgeError):
            common.validate_release(self.support, reference, node_check=False)

    def test_new_unlisted_runtime_file_is_rejected(self):
        reference = self.release()
        path = self.support / 'releases' / reference['name'] / 'package/new.js'
        path.write_text('unreviewed import')
        with self.assertRaises(common.BridgeError):
            common.validate_release(self.support, reference, node_check=False)

    def test_node_upgrade_requires_validation(self):
        reference = self.release()
        with patch.object(common, 'command_output', return_value='vUPDATED'):
            with self.assertRaisesRegex(common.BridgeError, 'Node.js was updated'):
                common.validate_release(self.support, reference)

    def test_reviewed_node_pin_matches_repository_compatibility(self):
        compatibility = common.read_json(Path(__file__).resolve().parent.parent / 'compatibility.json')
        self.assertEqual(common.EXPECTED_NODE_VERSION, compatibility['nodeVersion'])

    def test_wrong_node_is_rejected_before_any_release_is_staged(self):
        with patch.object(manage, 'command_output', return_value='v99.0.0'):
            with self.assertRaisesRegex(common.BridgeError, 'reviewed version'):
                manage.prepare_release(self.source, self.support, '/test/node')
        self.assertFalse((self.support / 'releases').exists())

    def test_generated_runtime_metadata_cannot_bless_unreviewed_node(self):
        metadata = {'nodeVersion': 'v99.0.0', 'compatibility': {'nodeVersion': 'v99.0.0',
            'desktop': {'version': common.EXPECTED_BUILD['CFBundleShortVersionString'],
                        'build': common.EXPECTED_BUILD['CFBundleVersion']}}}
        common.atomic_json(self.source / 'bridge-build.json', metadata)
        with patch.object(manage, 'command_output', return_value='v99.0.0') as node:
            with self.assertRaisesRegex(common.BridgeError, 'compatibility'):
                manage.prepare_release(self.source, self.support, '/test/node')
        node.assert_not_called()
        self.assertFalse((self.support / 'releases').exists())

    def test_generated_metadata_must_contain_the_reviewed_node_and_desktop(self):
        metadata = {'nodeVersion': common.EXPECTED_NODE_VERSION,
            'compatibility': {'nodeVersion': common.EXPECTED_NODE_VERSION,
                'desktop': {'version': 'UNREVIEWED', 'build': 'UNREVIEWED'}}}
        common.atomic_json(self.source / 'bridge-build.json', metadata)
        with self.assertRaisesRegex(common.BridgeError, 'compatibility'):
            self.release()
        common.atomic_json(self.source / 'bridge-build.json', {'nodeVersion': common.EXPECTED_NODE_VERSION})
        with self.assertRaisesRegex(common.BridgeError, 'metadata'):
            self.release()
        self.assertFalse((self.support / 'releases').exists())

    def test_frozen_manifest_cannot_bless_a_different_node_version(self):
        reference = self.release()
        path = self.support / 'releases' / reference['name'] / 'manifest.json'
        manifest = common.read_json(path)
        manifest['nodeVersion'] = 'v99.0.0'
        common.atomic_json(path, manifest)
        reference['manifestSha256'] = common.digest(path)
        with patch.object(common, 'command_output', return_value='v99.0.0'):
            with self.assertRaisesRegex(common.BridgeError, 'unreviewed Node'):
                common.validate_release(self.support, reference)

    def test_source_fingerprint_covers_custom_provider_and_all_integration_files(self):
        first = manage.source_fingerprint(self.source)
        self.assertIn('dist/codex/session.js', first)
        self.assertIn('dist/desktop-bridge/provider.mjs', first)
        self.assertEqual(list(first), sorted(first))
        (self.source / 'dist/desktop-bridge/provider.mjs').write_text('changed provider')
        changed = manage.source_fingerprint(self.source)
        self.assertNotEqual(first, changed)
        self.assertEqual([name for name in first if first[name] != changed[name]], ['dist/desktop-bridge/provider.mjs'])

    def test_source_fingerprint_tracks_added_removed_modules_and_metadata_but_excludes_tests(self):
        baseline = manage.source_fingerprint(self.source)
        for name in ('provider.test.mjs', 'test_catalog.py'):
            (self.source / 'dist/desktop-bridge' / name).write_text('offline test')
        self.assertEqual(baseline, manage.source_fingerprint(self.source))
        module = self.source / 'dist/desktop-bridge/new-module.mjs'
        module.write_text('production module')
        self.assertNotEqual(baseline, manage.source_fingerprint(self.source))
        module.unlink()
        self.assertEqual(baseline, manage.source_fingerprint(self.source))
        (self.source / 'bridge-build.json').write_text('{"sourceRevision":"fixture"}')
        self.assertIn('bridge-build.json', manage.source_fingerprint(self.source))

    def test_internal_dependency_links_are_preserved_and_guarded(self):
        (self.source / 'node_modules/.bin').mkdir()
        (self.source / 'node_modules/.bin/tool').symlink_to('../library/index.js')
        reference = self.release()
        with patch.object(common, 'command_output', return_value=common.EXPECTED_NODE_VERSION):
            root, _ = common.validate_release(self.support, reference)
        link = root / 'package/node_modules/.bin/tool'
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.read_text(), 'frozen dependency')
        link.unlink()
        link.symlink_to(self.source / 'node_modules/library/index.js')
        with self.assertRaises(common.BridgeError):
            common.validate_release(self.support, reference, node_check=False)

    def test_external_dependency_links_are_rejected_before_chmod(self):
        external = self.root / 'external.js'
        external.write_text('outside source')
        external.chmod(0o644)
        (self.source / 'node_modules/external').symlink_to(external)
        with self.assertRaises(common.BridgeError):
            self.release()
        self.assertEqual(external.stat().st_mode & 0o777, 0o644)

    def test_original_npm_provider_is_never_accepted_as_fallback(self):
        (self.source / 'dist/desktop-bridge/provider.mjs').write_text('createSeparateEngine()')
        with self.assertRaises(common.BridgeError):
            manage.source_version(self.source)

    def test_source_version_requires_the_exact_reviewed_patch_version(self):
        provider = self.source / 'dist/desktop-bridge/provider.mjs'
        for version in manage.VERSIONS:
            provider.write_text("version: '" + version + "'")
            self.assertEqual(manage.source_version(self.source), version)
        self.assertEqual(manage.INSTALL_VERSION, 'G2 Desktop Bridge 0.2.7')
        for version in ('0.2.10', '0.2.20', '0.2.30', '0.2.40', '0.2.50', '0.2.60', '0.2.70', '0.2.3-beta', '0.2.4-beta', '0.2.5-beta', '0.2.6-beta', '0.2.7-beta'):
            provider.write_text("version: 'G2 Desktop Bridge " + version + "'")
            with self.assertRaises(common.BridgeError):
                manage.source_version(self.source)
        provider.write_text("version: 'G2 Desktop Bridge 0.2.7'; version: 'G2 Desktop Bridge 0.2.6'")
        with self.assertRaises(common.BridgeError):
            manage.source_version(self.source)

    def test_version_mentions_cannot_hide_a_different_exported_version(self):
        provider = self.source / 'dist/desktop-bridge/provider.mjs'
        provider.write_text("// previously G2 Desktop Bridge 0.2.6\nversion: 'G2 Desktop Bridge 0.2.7'")
        self.assertEqual(manage.source_version(self.source), 'G2 Desktop Bridge 0.2.7')
        provider.write_text("// G2 Desktop Bridge 0.2.7\nversion: 'Unreviewed provider'")
        with self.assertRaises(common.BridgeError):
            manage.source_version(self.source)

    def test_install_target_preserves_all_reviewed_rollback_versions(self):
        self.assertEqual(set(manage.VERSIONS), {
            'G2 Desktop Bridge 0.1', 'G2 Desktop Bridge 0.2', 'G2 Desktop Bridge 0.2.1',
            'G2 Desktop Bridge 0.2.2', 'G2 Desktop Bridge 0.2.3', 'G2 Desktop Bridge 0.2.4',
            'G2 Desktop Bridge 0.2.5',
            'G2 Desktop Bridge 0.2.6',
            'G2 Desktop Bridge 0.2.7',
        })
        self.assertIn(manage.INSTALL_VERSION, manage.VERSIONS)

    def test_private_atomic_files_and_exclusive_lock(self):
        path = self.support / 'status.json'
        common.atomic_json(path, {'status': 'ready'})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.support.stat().st_mode & 0o777, 0o700)
        lock = self.support / 'run/lock'
        with common.exclusive_lock(lock):
            with self.assertRaises(common.BridgeError):
                with common.exclusive_lock(lock):
                    self.fail('duplicate lock acquired')
        with common.exclusive_lock(lock):
            pass  # stale PID content does not prevent recovery

    def test_environment_preserves_config_and_forces_only_desktop_provider(self):
        with patch.dict(os.environ, {'NODE_OPTIONS': '--require=/bad.js', 'BRIDGE_TOKEN': 'bad',
                'PORT': '9000', 'CODEX_CLI_PATH': '/bad', 'EVEN_CODEX_DESKTOP_BRIDGE': '0'}):
            env = common.child_environment(self.support)
        for key in ('NODE_OPTIONS', 'BRIDGE_TOKEN', 'PORT', 'CODEX_CLI_PATH'):
            self.assertNotIn(key, env)
        self.assertEqual(env['EVEN_CODEX_DESKTOP_BRIDGE'], '1')
        self.assertEqual(env['EVEN_CODEX_BRIDGE_STATE_DIR'], str(self.support / 'state'))

    def test_child_uses_frozen_entrypoint_and_discards_raw_logs(self):
        service = supervisor.Supervisor(self.support)
        manifest = {'nodeExecutable': '/test/node'}
        root = self.support / 'releases/test'
        with patch.object(supervisor.subprocess, 'Popen') as spawn:
            service.spawn(root, manifest, self.config_path)
        args, kwargs = spawn.call_args
        self.assertEqual(args[0][1], str(root / 'package/bin/cli.js'))
        self.assertEqual(args[0][-1], '/dev/null')
        self.assertNotIn('start_new_session', kwargs)
        self.assertEqual(kwargs['stdout'], supervisor.subprocess.DEVNULL)
        self.assertEqual(kwargs['stderr'], supervisor.subprocess.DEVNULL)
        self.assertNotIn('SYNTHETIC_TEST_SECRET', repr(spawn.call_args))

    def test_launchagent_is_user_session_only_and_supervised(self):
        plist = common.make_plist(self.support, '/test/python')
        self.assertTrue(plist['RunAtLoad'])
        self.assertTrue(plist['KeepAlive'])
        self.assertEqual(plist['LimitLoadToSessionType'], 'Aqua')
        self.assertEqual(plist['Umask'], 0o077)
        self.assertNotIn('UserName', plist)
        self.assertNotIn('SYNTHETIC_TEST_SECRET', plistlib.dumps(plist).decode())

    def test_restart_gate_rejects_pending_submission_even_if_ui_idle(self):
        with patch.object(common, 'api', return_value={'codex': {'subscribedSessions': [
                {'status': 'idle', 'submissionPending': True}]}}):
            self.assertFalse(common.idle(self.config))

    def test_a_completed_watched_task_does_not_require_disconnect_for_migration(self):
        with patch.object(common, 'api', return_value={'codex': {'subscribedSessions': [
                {'threadId': 'completed-test', 'status': 'idle', 'submissionPending': False,
                 'connectedClients': 1}]}}):
            self.assertTrue(common.idle(self.config))
            manage.assert_idle(self.config, self.support)

    def test_failed_migration_restores_only_verified_previous_release(self):
        previous = self.release()
        current = self.release()
        control = self.control(current, previous)
        launched = {'loaded': False}
        calls = []
        def fake_launchctl(*args, **_):
            calls.append(args)
            if args[0] == 'bootstrap': launched['loaded'] = True
            if args[0] == 'bootout': launched['loaded'] = False
            return Mock(returncode=0)
        with patch.object(manage, 'loaded', side_effect=lambda: launched['loaded']), \
             patch.object(manage, 'process_identity', return_value=('uid', 'known bridge', 'start')), \
             patch.object(manage, 'assert_idle'), patch.object(manage.os, 'kill') as kill, \
             patch.object(manage, 'wait_port_free'), patch.object(manage, 'port_available', return_value=True), \
             patch.object(manage, 'install_operations'), \
             patch.object(manage, 'write_plist'), patch.object(manage, 'launchctl', side_effect=fake_launchctl), \
             patch.object(manage, 'wait_healthy', side_effect=[False, True]), \
             patch.object(common, 'command_output', return_value=common.EXPECTED_NODE_VERSION):
            with self.assertRaisesRegex(common.BridgeError, 'did not become healthy'):
                manage.switch_release(self.support, control, None, self.config, adopt_pid=12345)
        self.assertEqual(common.read_json(self.support / 'control.json')['activeRelease'], previous)
        self.assertEqual(common.read_json(self.support / 'transition.json')['phase'], 'recovered')
        kill.assert_called_once_with(12345, signal.SIGTERM)
        self.assertEqual(sum(args[0] == 'bootstrap' for args in calls), 2)
        self.assertNotIn('SYNTHETIC_TEST_SECRET', (self.support / 'transition.json').read_text())

    def test_successful_migration_preserves_config_and_records_completion(self):
        control = self.control(self.release())
        before = common.digest(self.config_path)
        with patch.object(manage, 'loaded', return_value=False), \
             patch.object(manage, 'port_available', return_value=True), \
             patch.object(manage, 'wait_port_free'), patch.object(manage, 'install_operations'), \
             patch.object(manage, 'write_plist'), patch.object(manage, 'launchctl'), \
             patch.object(manage, 'wait_healthy', return_value=True), \
             patch.object(common, 'command_output', return_value=common.EXPECTED_NODE_VERSION):
            manage.switch_release(self.support, control, None, self.config)
        self.assertEqual(common.digest(self.config_path), before)
        self.assertTrue(common.read_json(self.support / 'transition.json')['configurationUnchanged'])

    def test_migration_waits_for_launchd_removal_after_http_port_is_free(self):
        previous, current = self.release(), self.release()
        old, control = self.control(previous), self.control(current, previous)
        lifecycle = {'registered': True, 'unloading': False, 'remainingPolls': 0}
        calls = []
        def fake_loaded():
            if lifecycle['unloading']:
                if lifecycle['remainingPolls']:
                    lifecycle['remainingPolls'] -= 1
                    return True
                lifecycle['registered'] = False
            return lifecycle['registered']
        def fake_launchctl(*args, **_):
            calls.append(args[0])
            if args[0] == 'bootout':
                lifecycle.update(unloading=True, remainingPolls=3)
            if args[0] == 'bootstrap':
                self.assertFalse(lifecycle['registered'], 'bootstrap raced the old service removal')
                self.assertEqual(lifecycle['remainingPolls'], 0)
                lifecycle.update(registered=True, unloading=False)
            return Mock(returncode=0)
        with patch.object(manage, 'loaded', side_effect=fake_loaded), \
             patch.object(manage, 'launchctl', side_effect=fake_launchctl), \
             patch.object(manage, 'assert_idle'), patch.object(manage, 'wait_port_free'), \
             patch.object(manage, 'install_operations'), patch.object(manage, 'write_plist'), \
             patch.object(manage, 'wait_healthy', return_value=True), \
             patch.object(manage.time, 'sleep') as sleep, \
             patch.object(common, 'command_output', return_value=common.EXPECTED_NODE_VERSION):
            manage.switch_release(self.support, control, old, self.config)
        self.assertEqual(calls, ['bootout', 'bootstrap'])
        self.assertEqual(sleep.call_count, 3)
        self.assertEqual(common.read_json(self.support / 'transition.json')['phase'], 'complete')

    def test_wait_unloaded_is_bounded_and_never_bootstraps_on_timeout(self):
        with patch.object(manage, 'loaded', return_value=True), \
             patch.object(manage.time, 'monotonic', side_effect=[0, 0, 16]), \
             patch.object(manage.time, 'sleep'), patch.object(manage, 'launchctl') as launch:
            with self.assertRaisesRegex(common.BridgeError, 'has not finished unloading'):
                manage.wait_unloaded(timeout=15)
        launch.assert_not_called()

    def test_launchctl_failure_reports_exit_and_only_the_first_safe_diagnostic(self):
        result = Mock(returncode=5, stderr='Bootstrap failed: 5: Input/output error\nSYNTHETIC_TEST_SECRET')
        with patch.object(manage.subprocess, 'run', return_value=result):
            with self.assertRaises(common.BridgeError) as caught:
                manage.launchctl('bootstrap', 'gui/test', '/test/service.plist')
        self.assertIn('(exit 5)', str(caught.exception))
        self.assertIn('Bootstrap failed: 5: Input/output error', str(caught.exception))
        self.assertNotIn('SYNTHETIC_TEST_SECRET', str(caught.exception))
        redacted = manage.launchctl_diagnostic('Bootstrap failed: 5: token=TOKEN_SECRET Bearer AUTH_SECRET https://example.test/?secret=URL_SECRET')
        self.assertNotIn('TOKEN_SECRET', redacted)
        self.assertNotIn('AUTH_SECRET', redacted)
        self.assertNotIn('URL_SECRET', redacted)
        self.assertNotIn('SYNTHETIC_TEST_SECRET', manage.launchctl_diagnostic('SYNTHETIC_TEST_SECRET'))

    def test_pruning_keeps_current_and_previous_only(self):
        first, second, extra = self.release(), self.release(), self.release()
        manage.prune_releases(self.support, self.control(second, first))
        self.assertEqual({path.name for path in (self.support / 'releases').iterdir()},
                         {first['name'], second['name']})

    def test_durable_uncertain_delivery_blocks_controlled_upgrade(self):
        common.atomic_json(self.support / 'state/delivery.json',
                           {'version': 1, 'prompts': {'thread': {'phase': 'unknown'}}, 'actions': {}})
        with patch.object(manage, 'idle', return_value=True):
            with self.assertRaisesRegex(common.BridgeError, 'unconfirmed submission'):
                manage.assert_idle(self.config, self.support)

    def test_corrupt_delivery_history_fails_closed(self):
        common.private_directory(self.support / 'state')
        (self.support / 'state/delivery.json').write_text('broken')
        self.assertTrue(common.pending_delivery(self.support))

    def test_incomplete_delivery_schema_is_not_safe_to_restart(self):
        common.atomic_json(self.support / 'state/delivery.json',
                           {'version': 1, 'prompts': {}, 'actions': {}})
        self.assertTrue(common.pending_delivery(self.support))
        common.atomic_json(self.support / 'state/delivery.json',
                           {'version': 1, 'prompts': {}, 'actions': {}, 'receipts': {}})
        self.assertFalse(common.pending_delivery(self.support))


class LaunchAtLoginTests(unittest.TestCase):
    def test_current_and_legacy_launchctl_disabled_output(self):
        for value, expected in (('disabled', False), ('enabled', True), ('true', False), ('false', True)):
            output = 'disabled services = {\n\t"another.service" => disabled\n\t"' + common.LABEL + '" => ' + value + '\n}\n'
            with self.subTest(value=value), patch.object(manage, 'launchctl', return_value=Mock(stdout=output)):
                self.assertEqual(manage.launch_at_login(), expected)

    def test_absent_override_uses_enabled_default(self):
        output = 'disabled services = {\n\t"another.service" => disabled\n}\n'
        with patch.object(manage, 'launchctl', return_value=Mock(stdout=output)):
            self.assertTrue(manage.launch_at_login())

    def test_unknown_or_ambiguous_override_fails_instead_of_claiming_enabled(self):
        for output in ('"' + common.LABEL + '" => unknown',
                       '"' + common.LABEL + '" = disabled',
                       '"' + common.LABEL + '" => disabled\n"' + common.LABEL + '" => enabled'):
            with self.subTest(output=output), patch.object(manage, 'launchctl', return_value=Mock(stdout=output)):
                with self.assertRaisesRegex(common.BridgeError, 'could not be read reliably'):
                    manage.launch_at_login()


if __name__ == '__main__':
    unittest.main()
