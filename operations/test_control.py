"""Offline controller contracts and lifecycle failure gates. Never touch launchd."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import common
import control
import manage


SECRET = 'SYNTHETIC_CONTROLLER_SECRET'


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.support = common.private_directory(self.root / 'support')
        self.source = self.root / 'source'
        for name in ('dist/routes', 'dist/startup', 'dist/desktop-bridge', 'dist/codex', 'bin', 'node_modules/library'):
            (self.source / name).mkdir(parents=True, exist_ok=True)
        (self.source / 'dist/routes/core.js').write_text(
            'createDesktopProvider desktopBridgeEnabled EVEN_CODEX_DESKTOP_BRIDGE ensure-app-server')
        (self.source / 'dist/routes/events.js').write_text('events')
        (self.source / 'dist/codex/session.js').write_text('patched session')
        (self.source / 'dist/startup/common.js').write_text('startup')
        (self.source / 'dist/desktop-bridge/provider.mjs').write_text("version: 'G2 Desktop Bridge 0.2.7'")
        (self.source / 'bin/cli.js').write_text('reviewed bridge')
        (self.source / 'node_modules/library/index.js').write_text('frozen dependency')
        (self.source / 'package.json').write_text(json.dumps({'version': '0.10.4'}))
        (self.source / 'src').mkdir()
        (self.source / 'src/wrapper.js').write_text('upstream source wrapper')
        (self.source / 'bridge-build.json').write_text(json.dumps({'sourceRevision': 'fixture',
            'nodeVersion': common.EXPECTED_NODE_VERSION,
            'compatibility': {'nodeVersion': common.EXPECTED_NODE_VERSION,
                'desktop': {'version': common.EXPECTED_BUILD['CFBundleShortVersionString'],
                            'build': common.EXPECTED_BUILD['CFBundleVersion']}}}))
        (self.source / 'README.md').write_text('upstream readme')
        self.config_path = self.root / 'config.json'
        common.atomic_json(self.config_path, {'token': SECRET, 'port': 3456})
        self.config = common.load_config(self.config_path)
        self.launch_path = self.root / 'LaunchAgents' / (common.LABEL + '.plist')
        self.registered = True
        self.listener = True
        self.disabled = False
        self.busy = False
        self.calls = []
        self.patches = [
            patch.object(manage, 'command_output', return_value=common.EXPECTED_NODE_VERSION),
            patch.object(common, 'command_output', return_value=common.EXPECTED_NODE_VERSION),
            patch.object(manage, 'plist_path', return_value=self.launch_path),
            patch.object(manage, 'launchctl', side_effect=self.launchctl),
            patch.object(common, 'port_available', side_effect=lambda *_: not self.listener),
            patch.object(manage, 'port_available', side_effect=lambda *_: not self.listener),
            patch.object(common, 'api', side_effect=self.api),
            patch.object(common, 'desktop_build', return_value=dict(common.EXPECTED_BUILD)),
            patch.object(control, 'desktop_available', return_value=True),
            patch.object(control, 'network_address', return_value='configured-network'),
        ]
        for entry in self.patches:
            entry.start()
            self.addCleanup(entry.stop)
        self.active = manage.prepare_release(self.source, self.support, '/test/node')
        self.previous = manage.prepare_release(self.source, self.support, '/test/node')
        self.record = {'format': 1, 'label': common.LABEL, 'activeRelease': self.active,
            'previousRelease': self.previous, 'configPath': str(self.config_path),
            'sourcePackage': str(self.source), 'sourceFingerprint': manage.source_fingerprint(self.source)}
        common.atomic_json(self.support / 'control.json', self.record)
        manage.install_operations(self.support)
        manage.write_plist(self.support)

    def api(self, config, path, **kwargs):
        if not self.listener:
            raise ConnectionRefusedError(SECRET)
        if path.startswith('/api/info'):
            return {'version': 'G2 Desktop Bridge 0.2.7'}
        return {'codex': {'subscribedSessions': [
            {'status': 'busy' if self.busy else 'idle', 'submissionPending': False}]}}

    def launchctl(self, *args, **kwargs):
        self.calls.append(args)
        if args[0] == 'print':
            arguments = common.make_plist(self.support, '/usr/bin/python3')['ProgramArguments']
            return Mock(returncode=0 if self.registered else 113,
                stdout='arguments = {\n' + '\n'.join(arguments) + '\n}\npid = 991234\n', stderr='')
        if args[0] == 'print-disabled':
            return Mock(returncode=0, stdout='"' + common.LABEL + '" => ' +
                        ('disabled' if self.disabled else 'enabled'), stderr='')
        if args[0] == 'bootout':
            self.registered = self.listener = False
        elif args[0] == 'bootstrap':
            self.registered = self.listener = True
        elif args[0] == 'disable':
            self.disabled = True
        elif args[0] == 'enable':
            self.disabled = False
        return Mock(returncode=0, stdout='', stderr='')

    def mutations(self):
        return [entry[0] for entry in self.calls if entry[0] not in ('print', 'print-disabled')]

    def pending(self):
        common.atomic_json(self.support / 'state/delivery.json',
            {'version': 1, 'prompts': {'synthetic-task': {'phase': 'unknown'}}, 'actions': {}, 'receipts': {}})

    def test_status_reports_fresh_state_without_full_integrity_walk(self):
        with patch.object(common, 'validate_release', side_effect=AssertionError('full runtime walk')):
            result = control.status(self.support)
        self.assertEqual(result['state'], 'ready')
        self.assertTrue(result['running'])
        self.assertTrue(result['safeToChange'])
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertNotIn('glassesConnected', result)
        self.assertEqual(self.mutations(), [])

    def test_stopped_service_does_not_inherit_stale_ready_status(self):
        self.registered = self.listener = False
        common.atomic_json(self.support / 'status.json', {'status': 'ready', 'supervisorPid': 991234})
        result = control.status(self.support)
        self.assertFalse(result['running'])
        self.assertEqual(result['state'], 'stopped')
        self.assertTrue(result['safeToChange'])

    def test_unmanaged_listener_is_never_presented_as_owned_running_service(self):
        self.registered = False
        result = control.status(self.support)
        self.assertEqual(result['state'], 'unmanaged_service')
        self.assertFalse(result['running'])
        self.assertFalse(result['safeToChange'])
        with self.assertRaises(common.BridgeError):
            control.mutate('start', self.support)
        self.assertEqual(self.mutations(), [])

    def test_active_task_prevents_stop_and_restart(self):
        self.busy = True
        for command in ('stop', 'restart'):
            with self.subTest(command=command), self.assertRaises(common.BridgeError):
                control.mutate(command, self.support, {'launchAtLogin': False})
        self.assertEqual(self.mutations(), [])

    def test_stopped_pending_delivery_allows_only_same_release_start_and_preserves_journal(self):
        self.registered = self.listener = False
        self.pending()
        result = control.status(self.support)
        self.assertEqual(result['state'], 'delivery_pending')
        self.assertFalse(result['safeToChange'])
        self.assertTrue(result['canStart'])
        before = common.digest(self.support / 'state/delivery.json')
        active_before = common.read_json(self.support / 'control.json')['activeRelease']
        control.mutate('start', self.support)
        self.assertEqual(self.mutations(), ['bootstrap'])
        self.assertEqual(before, common.digest(self.support / 'state/delivery.json'))
        self.assertEqual(active_before, common.read_json(self.support / 'control.json')['activeRelease'])

    def test_stopped_pending_delivery_blocks_stop_restart_and_rollback(self):
        self.registered = self.listener = False
        self.pending()
        for command in ('stop', 'restart', 'rollback'):
            with self.subTest(command=command), self.assertRaises(common.BridgeError):
                control.mutate(command, self.support)
        self.assertEqual(self.mutations(), [])

    def test_pending_delivery_cannot_start_while_owned_child_is_alive(self):
        self.registered = self.listener = False
        self.pending()
        with patch.object(manage, 'managed_bridge_pid_alive', return_value=True):
            self.assertFalse(control.status(self.support)['canStart'])
            with self.assertRaises(common.BridgeError):
                control.mutate('start', self.support)
        self.assertEqual(self.mutations(), [])

    def test_start_rechecks_free_port_immediately_before_bootstrap(self):
        self.registered = self.listener = False
        self.pending()
        def listener_appeared():
            self.listener = True
        with patch.object(manage, 'wait_unloaded', side_effect=listener_appeared):
            with self.assertRaises(common.BridgeError):
                control.mutate('start', self.support)
        self.assertEqual(self.mutations(), [])

    def test_stopped_dead_child_can_be_started_without_http(self):
        self.registered = self.listener = False
        common.atomic_json(self.support / 'status.json', {'status': 'ready', 'bridgePid': 991234})
        with patch.object(manage, 'command_output', side_effect=subprocess.CalledProcessError(1, '/bin/ps')):
            control.mutate('start', self.support)
        self.assertEqual(self.mutations(), ['bootstrap'])

    def test_unreachable_live_child_blocks_restart(self):
        self.listener = False
        common.atomic_json(self.support / 'status.json', {'status': 'ready', 'bridgePid': 991234})
        with patch.object(manage, 'managed_bridge_pid_alive', return_value=True):
            with self.assertRaises(common.BridgeError):
                control.mutate('restart', self.support)
        self.assertEqual(self.mutations(), [])

    def test_disable_login_keeps_current_service_loaded(self):
        control.mutate('set-preferences', self.support, {'launchAtLogin': False})
        self.assertTrue(self.registered)
        self.assertTrue(self.listener)
        self.assertEqual(self.mutations(), ['disable'])
        self.assertFalse(control.status(self.support)['launchAtLogin'])

    def test_preferences_can_change_during_active_and_pending_delivery(self):
        self.busy = True
        self.pending()
        result = control.status(self.support)
        self.assertFalse(result['safeToChange'])
        self.assertTrue(result['canChangePreferences'])
        control.mutate('set-preferences', self.support, {'launchAtLogin': False})
        self.assertTrue(self.registered)
        self.assertTrue(self.listener)
        self.assertEqual(self.mutations(), ['disable'])
        self.assertTrue(common.pending_delivery(self.support))

    def test_pid_reused_by_unrelated_process_does_not_block_start(self):
        self.registered = self.listener = False
        common.atomic_json(self.support / 'status.json', {'status': 'ready', 'bridgePid': 991234})
        def reused_pid(args, **kwargs):
            return str(os.getuid()) if args[-1] == 'uid=' else '/Applications/Other.app/Contents/MacOS/Other'
        with patch.object(manage, 'command_output', side_effect=reused_pid):
            control.mutate('start', self.support)
        self.assertEqual(self.mutations(), ['bootstrap'])

    def test_actual_managed_child_blocks_restart_when_port_is_free(self):
        self.listener = False
        common.atomic_json(self.support / 'status.json', {'status': 'ready', 'bridgePid': 991234})
        root = self.support / 'releases' / self.active['name']
        expected = ' '.join(['/test/node', str(root / 'package/bin/cli.js'), '--config', str(self.config_path),
                             '--log-level', 'info', '--log-file', '/dev/null'])
        def bridge_ps(args, **kwargs):
            if args[-1] == 'uid=':
                return str(os.getuid())
            if args[-1] == 'ppid=':
                return '991235'
            if args[2] == '991234':
                return expected
            return '/usr/bin/python3 ' + str(self.support / 'operations/supervisor.py') + ' --support ' + str(self.support)
        with patch.object(manage, 'command_output', side_effect=bridge_ps):
            with self.assertRaises(common.BridgeError):
                control.mutate('restart', self.support)
        self.assertEqual(self.mutations(), [])

    def test_wrong_listener_version_fails_closed_even_with_idle_metrics(self):
        def wrong_version(config, path, **kwargs):
            if path.startswith('/api/info'):
                return {'version': 'Unexpected provider ' + SECRET}
            return self.api(config, path, **kwargs)
        with patch.object(common, 'api', side_effect=wrong_version):
            result = control.status(self.support)
            self.assertEqual(result['state'], 'unexpected_service')
            self.assertFalse(result['safeToChange'])
            self.assertNotIn(SECRET, json.dumps(result))
            for command in ('stop', 'restart', 'rollback'):
                with self.subTest(command=command), self.assertRaises(common.BridgeError):
                    control.mutate(command, self.support)
        self.assertEqual(self.mutations(), [])

    def test_manual_start_preserves_disabled_login_preference(self):
        self.disabled = True
        self.registered = self.listener = False
        control.mutate('start', self.support)
        self.assertTrue(self.registered)
        self.assertTrue(self.disabled)
        self.assertEqual(self.mutations(), ['enable', 'bootstrap', 'disable'])

    def test_failed_bootstrap_still_restores_disabled_login_preference(self):
        self.disabled = True
        def fail_bootstrap(*args, **kwargs):
            if args[0] == 'bootstrap':
                raise common.BridgeError('Synthetic bootstrap failure.')
            return self.launchctl(*args, **kwargs)
        with patch.object(manage, 'launchctl', side_effect=fail_bootstrap):
            with self.assertRaises(common.BridgeError):
                manage.bootstrap()
        self.assertTrue(self.disabled)
        self.assertEqual(self.mutations(), ['enable', 'disable'])

    def test_stop_is_for_session_and_keeps_login_preference(self):
        control.mutate('stop', self.support)
        self.assertEqual(self.mutations(), ['bootout'])
        self.assertFalse(self.registered)
        self.assertTrue(control.status(self.support)['launchAtLogin'])

    def test_wrong_plist_owner_is_preserved(self):
        plist = plistlib.loads(self.launch_path.read_bytes())
        plist['ProgramArguments'] = ['/test/other-program']
        self.launch_path.write_bytes(plistlib.dumps(plist))
        with self.assertRaises(common.BridgeError):
            control.mutate('stop', self.support)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(plistlib.loads(self.launch_path.read_bytes()), plist)

    def test_loaded_identity_must_match_even_if_plist_is_owned(self):
        def different_loaded(*args, **kwargs):
            if args[0] == 'print':
                return Mock(returncode=0, stdout='arguments = {\n/test/other-program\n}\npid = 991234')
            return self.launchctl(*args, **kwargs)
        with patch.object(manage, 'launchctl', side_effect=different_loaded):
            with self.assertRaises(common.BridgeError):
                control.mutate('stop', self.support)
        self.assertEqual(self.mutations(), [])

    def test_full_integrity_failure_blocks_restart_before_stop(self):
        (self.support / 'releases' / self.active['name'] / 'package/bin/cli.js').write_text('unreviewed')
        with self.assertRaises(common.BridgeError):
            control.mutate('restart', self.support)
        self.assertEqual(self.mutations(), [])
        self.assertTrue(self.registered)

    def test_idle_is_rechecked_after_integrity_verification(self):
        original = common.validate_release
        def active_during_validation(*args, **kwargs):
            result = original(*args, **kwargs)
            self.busy = True
            return result
        with patch.object(common, 'validate_release', side_effect=active_during_validation):
            with self.assertRaises(common.BridgeError):
                control.mutate('restart', self.support)
        self.assertEqual(self.mutations(), [])

    def test_shared_management_lock_prevents_concurrent_mutation(self):
        with common.exclusive_lock(self.support / 'run/management.lock'):
            with self.assertRaises(common.BridgeError):
                control.mutate('stop', self.support)
        self.assertEqual(self.mutations(), [])

    def test_rollback_is_available_between_distinct_same_version_builds(self):
        self.assertTrue(control.status(self.support)['canRollback'])
        with patch.object(manage, 'wait_healthy', return_value=True):
            control.mutate('rollback', self.support)
        current = common.read_json(self.support / 'control.json')
        self.assertEqual(current['activeRelease'], self.previous)
        self.assertEqual(current['previousRelease'], self.active)
        self.assertEqual(self.mutations(), ['bootout', 'bootstrap'])

    def test_pending_delivery_blocks_rollback_without_altering_control(self):
        self.pending()
        before = common.digest(self.support / 'control.json')
        with self.assertRaises(common.BridgeError):
            control.mutate('rollback', self.support)
        self.assertEqual(common.digest(self.support / 'control.json'), before)
        self.assertEqual(self.mutations(), [])

    def test_diagnostic_is_redacted_even_when_probe_exception_contains_secret(self):
        with patch.object(common, 'validate_release', side_effect=OSError(SECRET)):
            result = control.diagnostics(self.support)
        self.assertFalse(result['diagnostics']['runtimeVerified'])
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertFalse(result['safeToChange'])

    def test_missing_build_source_does_not_break_installed_diagnostics(self):
        shutil.rmtree(self.source)
        result = control.diagnostics(self.support)
        self.assertTrue(result['diagnostics']['runtimeVerified'])
        self.assertFalse(result['diagnostics']['sourceAvailable'])
        self.assertIsNone(result['diagnostics']['sourceChanged'])

    def test_freeze_includes_upstream_source_and_build_provenance(self):
        root, manifest = common.validate_release(self.support, self.active)
        for name in ('src/wrapper.js', 'README.md', 'bridge-build.json'):
            self.assertIn(name, manifest['files'])
            self.assertTrue((root / 'package' / name).is_file())

    def test_settings_input_is_bounded_and_typed(self):
        self.assertEqual(control.read_preferences(io.BytesIO(b'{"launchAtLogin":false}')), {'launchAtLogin': False})
        for data in (b'{"launchAtLogin":1}', b'{"launchAtLogin":true,"token":"bad"}',
                     b'{}', b'[]', b'not JSON', b' ' * 4097):
            with self.subTest(data=data[:60]), self.assertRaises(common.BridgeError):
                control.read_preferences(io.BytesIO(data))

    def activate_formatting_release(self, version='G2 Desktop Bridge 0.3.2'):
        (self.source / 'dist/desktop-bridge/provider.mjs').write_text("version: '" + version + "'")
        self.record['activeRelease'] = manage.prepare_release(self.source, self.support, '/test/node')
        common.atomic_json(self.support / 'control.json', self.record)

    def test_current_and_previous_formatting_releases_keep_text_settings_available(self):
        for version in ('G2 Desktop Bridge 0.2.8', 'G2 Desktop Bridge 0.2.9', 'G2 Desktop Bridge 0.3.0', 'G2 Desktop Bridge 0.3.1', 'G2 Desktop Bridge 0.3.2'):
            with self.subTest(version=version):
                self.activate_formatting_release(version)
                self.assertIn(version, control.FORMATTING_VERSIONS)
                result = control.status(self.support)
                self.assertTrue(result['formattingSupported'])
                self.assertTrue(result['canChangeFormatting'])
                control.mutate('reset-formatting', self.support)
                self.assertEqual(common.read_json(self.support / 'preferences.json')['textFormatting'],
                                 control.DEFAULT_TEXT_FORMATTING)
        self.assertEqual(self.mutations(), [])

    def test_old_release_reports_default_settings_but_cannot_save_unsupported_formatting(self):
        result = control.status(self.support)
        self.assertFalse(result['formattingSupported'])
        self.assertFalse(result['canChangeFormatting'])
        self.assertEqual(result['textFormatting'], control.DEFAULT_TEXT_FORMATTING)
        with self.assertRaisesRegex(common.BridgeError, 'Install a bridge release'):
            control.mutate('set-formatting', self.support, dict(control.DEFAULT_TEXT_FORMATTING))
        self.assertFalse((self.support / 'preferences.json').exists())
        self.assertEqual(self.mutations(), [])

    def test_formatting_saves_atomically_while_busy_and_preserves_pairing_journal_and_release(self):
        self.activate_formatting_release()
        self.busy = True
        self.pending()
        before = {name: common.digest(path) for name, path in {
            'config': self.config_path, 'journal': self.support / 'state/delivery.json',
            'control': self.support / 'control.json', 'plist': self.launch_path}.items()}
        custom = {'showTimestamps': False, 'showProgressUpdates': False, 'paragraphSpacing': 'compact'}
        control.mutate('set-formatting', self.support, custom)
        record = common.read_json(self.support / 'preferences.json')
        self.assertEqual(record, {'format': 1, 'textFormatting': custom})
        self.assertEqual((self.support / 'preferences.json').stat().st_mode & 0o777, 0o600)
        result = control.status(self.support)
        self.assertTrue(result['formattingSupported'])
        self.assertTrue(result['canChangeFormatting'])
        self.assertEqual(result['textFormatting'], custom)
        after = {name: common.digest(path) for name, path in {
            'config': self.config_path, 'journal': self.support / 'state/delivery.json',
            'control': self.support / 'control.json', 'plist': self.launch_path}.items()}
        self.assertEqual(before, after)
        self.assertTrue(self.registered)
        self.assertTrue(self.listener)
        self.assertEqual(self.mutations(), [])

    def test_invalid_formatting_is_rejected_without_touching_saved_preferences(self):
        self.activate_formatting_release()
        control.mutate('reset-formatting', self.support)
        before = common.digest(self.support / 'preferences.json')
        for value in ({}, [], {**control.DEFAULT_TEXT_FORMATTING, 'token': SECRET},
                      {**control.DEFAULT_TEXT_FORMATTING, 'showTimestamps': 1},
                      {**control.DEFAULT_TEXT_FORMATTING, 'paragraphSpacing': 'wide'}):
            with self.subTest(value=value), self.assertRaises(common.BridgeError):
                control.mutate('set-formatting', self.support, value)
        self.assertEqual(before, common.digest(self.support / 'preferences.json'))
        self.assertEqual(self.mutations(), [])

    def test_corrupt_formatting_uses_defaults_and_reset_repairs_only_preferences(self):
        self.activate_formatting_release()
        path = self.support / 'preferences.json'
        path.write_text(SECRET)
        result = control.status(self.support)
        self.assertFalse(result['formattingPreferencesValid'])
        self.assertTrue(result['canChangeFormatting'])
        self.assertEqual(result['textFormatting'], control.DEFAULT_TEXT_FORMATTING)
        self.assertNotIn(SECRET, json.dumps(result))
        control.mutate('reset-formatting', self.support)
        self.assertTrue(control.status(self.support)['formattingPreferencesValid'])

    def test_formatting_file_links_and_unsafe_permissions_are_not_written(self):
        self.activate_formatting_release()
        path = self.support / 'preferences.json'
        path.symlink_to(self.config_path)
        before = common.digest(self.config_path)
        with self.assertRaises(common.BridgeError):
            control.mutate('reset-formatting', self.support)
        self.assertEqual(before, common.digest(self.config_path))
        path.unlink()
        path.write_text('{}')
        path.chmod(0o666)
        with self.assertRaises(common.BridgeError):
            control.mutate('reset-formatting', self.support)

    def test_formatting_input_is_bounded_strict_and_separate_from_login_preference(self):
        self.assertEqual(control.read_formatting(io.BytesIO(json.dumps(control.DEFAULT_TEXT_FORMATTING).encode())),
                         control.DEFAULT_TEXT_FORMATTING)
        for data in (b'{"launchAtLogin":true}', b'null', b'[]', b'{}', b'not JSON', b' ' * 4097):
            with self.subTest(data=data[:60]), self.assertRaises(common.BridgeError):
                control.read_formatting(io.BytesIO(data))

    def test_non_tailscale_network_status_never_claims_a_verified_connection(self):
        for mode in ('lan', 'interface', 'expose', 'unsupported'):
            common.atomic_json(self.config_path, {'token': SECRET, 'network': {'mode': mode}})
            result = control.status(self.support)
            self.assertEqual(result['networkMode'], mode if mode != 'unsupported' else 'unknown')
            self.assertFalse(result['networkVerified'])
            self.assertNotIn(SECRET, json.dumps(result))
        common.atomic_json(self.config_path, {'token': SECRET, 'network': {'mode': 'tailscale'}})
        self.assertTrue(control.status(self.support)['networkVerified'])

    def test_cli_requires_apply_and_returns_only_safe_json(self):
        stream = io.StringIO()
        with redirect_stdout(stream):
            code = control.main(['stop', '--support', str(self.support)])
        response = json.loads(stream.getvalue())
        self.assertEqual(code, 1)
        self.assertFalse(response['ok'])
        self.assertIn('--apply', response['error'])
        self.assertNotIn(SECRET, stream.getvalue())
        self.assertEqual(self.mutations(), [])

    def test_process_errors_do_not_echo_child_output_or_secrets(self):
        error = subprocess.CalledProcessError(1, ['/test', SECRET], output=SECRET, stderr=SECRET)
        self.assertNotIn(SECRET, control.public_error(error))
        self.assertNotIn(SECRET, control.public_error(common.BridgeError('launchd could not complete: ' + SECRET)))

    def test_command_environment_drops_runtime_and_proxy_injection(self):
        with patch.dict(os.environ, {'NODE_OPTIONS': '--require=/test/unsafe', 'PYTHONPATH': '/test/unsafe',
                'DYLD_INSERT_LIBRARIES': '/test/unsafe', 'HTTP_PROXY': SECRET, 'TOKEN': SECRET}):
            env = common.command_environment()
        for key in ('NODE_OPTIONS', 'PYTHONPATH', 'DYLD_INSERT_LIBRARIES', 'HTTP_PROXY', 'TOKEN'):
            self.assertNotIn(key, env)

    def test_local_probe_cannot_redirect_authorization_to_another_server(self):
        handler = common.LocalOnlyRedirectHandler()
        self.assertIsNone(handler.redirect_request(None, None, 302, 'Found', {}, 'https://example.test/collect'))


if __name__ == '__main__':
    unittest.main()
