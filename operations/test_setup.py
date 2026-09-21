"""Fresh-install safety, profile preservation, and private pairing disclosure."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import common
import setup


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.support = self.root / 'support'
        self.config = self.root / 'profile/config.json'
        self.project = self.root / 'project'
        self.project.mkdir()
        self.record = {'configPath': str(self.config), 'activeRelease': {'name': 'test'}}

    def write_config(self, mode='tailscale'):
        config = setup.create_config(self.config, self.project)
        config['network'] = {'mode': mode, **({'name': 'en7'} if mode == 'interface' else {})}
        config['token'] = 'test-only-token +/?'
        common.atomic_json(self.config, config)
        return config

    def test_new_config_is_private_random_and_cannot_replace_existing(self):
        original = self.write_config()
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        before = self.config.read_bytes()
        with self.assertRaises(FileExistsError):
            setup.create_config(self.config, self.project)
        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(original['provider'], 'codex')

    def test_existing_profiles_preserve_network_cwd_and_token(self):
        for mode in ('tailscale', 'lan', 'interface'):
            if self.config.exists():
                self.config.unlink()
            original = self.write_config(mode)
            before = self.config.read_bytes()
            self.assertEqual(setup.existing_config(self.config), original)
            self.assertEqual(self.config.read_bytes(), before)

    def test_other_provider_or_public_tunnel_is_not_silently_migrated(self):
        config = self.write_config()
        for update in ({'provider': 'claude'}, {'network': {'mode': 'expose', 'provider': 'ngrok'}}):
            common.atomic_json(self.config, {**config, **update})
            before = self.config.read_bytes()
            with self.assertRaises(common.BridgeError):
                setup.existing_config(self.config)
            self.assertEqual(self.config.read_bytes(), before)

    def test_malformed_network_or_provider_options_are_rejected_without_rewrite(self):
        config = self.write_config()
        for update in ({'network': []}, {'claude': []}, {'claude': {'useSystemCli': 'yes'}},
                       {'claude': {'allowedTools': [None]}}):
            common.atomic_json(self.config, {**config, **update})
            before = self.config.read_bytes()
            with self.assertRaises(common.BridgeError):
                setup.existing_config(self.config)
            self.assertEqual(self.config.read_bytes(), before)

    def test_symlink_and_publicly_readable_profile_are_rejected(self):
        self.write_config()
        self.config.chmod(0o644)
        with self.assertRaises(common.BridgeError):
            setup.existing_config(self.config)
        self.config.chmod(0o600)
        link = self.config.parent / 'link.json'
        link.symlink_to(self.config)
        with self.assertRaises(common.BridgeError):
            setup.existing_config(link)

    def test_existing_managed_install_cannot_be_replaced_by_setup(self):
        common.private_directory(self.support)
        (self.support / 'control.json').write_text('{"sentinel":true}')
        with patch.object(setup.manage, 'prepare_release') as prepare:
            with self.assertRaisesRegex(common.BridgeError, 'already installed'):
                setup.create(self.root / 'runtime', Path('/reviewed/node'), {}, self.support, self.config)
            prepare.assert_not_called()
        self.assertFalse(self.config.exists())
        self.assertEqual((self.support / 'control.json').read_text(), '{"sentinel":true}')

    def test_port_collision_does_not_generate_credentials_or_freeze_release(self):
        with patch.object(setup.manage, 'loaded', return_value=False), \
             patch.object(setup.manage, 'plist_path', return_value=self.root / 'agent.plist'), \
             patch.object(setup, 'inspect', return_value={'ready': True}), \
             patch.object(setup.manage, 'reviewed_node_version'), \
             patch.object(common, 'port_available', return_value=False), \
             patch.object(setup.manage, 'prepare_release') as prepare:
            with self.assertRaisesRegex(common.BridgeError, 'port is in use'):
                setup.create(self.root / 'runtime', Path('/reviewed/node'),
                             {'projectDirectory': str(self.project)}, self.support, self.config)
            prepare.assert_not_called()
        self.assertFalse(self.config.exists())

    def test_fresh_install_uses_managed_switch_and_preserves_config_after_failure(self):
        calls = []
        def failed_switch(support, record, previous, config):
            calls.append((record, previous, config))
            raise common.BridgeError('Synthetic startup failure')
        with patch.object(setup.manage, 'loaded', return_value=False), \
             patch.object(setup.manage, 'plist_path', return_value=self.root / 'agent.plist'), \
             patch.object(setup, 'inspect', return_value={'ready': True}), \
             patch.object(setup.manage, 'reviewed_node_version'), \
             patch.object(common, 'port_available', return_value=True), \
             patch.object(setup.manage, 'prepare_release', return_value={'name': 'verified'}), \
             patch.object(setup.manage, 'source_fingerprint', return_value={'source': 'verified'}), \
             patch.object(setup.manage, 'switch_release', side_effect=failed_switch):
            with self.assertRaisesRegex(common.BridgeError, 'Synthetic'):
                setup.create(self.root / 'runtime', Path('/reviewed/node'),
                             {'projectDirectory': str(self.project)}, self.support, self.config)
        self.assertEqual(calls[0][0]['previousRelease'], None)
        self.assertEqual(setup.existing_config(self.config)['token'], calls[0][2]['token'])
        self.assertEqual(len(calls[0][2]['token']), 64)

    def test_pair_requires_explicit_reveal_before_reading_any_credentials(self):
        with patch.object(setup.control, 'installation') as installation:
            with self.assertRaisesRegex(common.BridgeError, 'private access token'):
                setup.pair(self.support)
            installation.assert_not_called()

    def test_pair_matches_upstream_url_contract_and_does_not_change_config(self):
        config = self.write_config('lan')
        before = self.config.read_bytes()
        manifest = {'nodeExecutable': '/reviewed/node', 'bridgeVersion': 'G2 Desktop Bridge test'}
        with patch.object(setup.control, 'installation', return_value=self.record), \
             patch.object(setup.control, 'release_summary', return_value=manifest), \
             patch.object(common, 'command_output', return_value=common.EXPECTED_NODE_VERSION), \
             patch.object(setup, 'network_address', return_value='192.168.4.2'), \
             patch.object(common, 'api', return_value={'version': manifest['bridgeVersion']}) as api:
            result = setup.pair(self.support, reveal=True)
        parsed = urlsplit(result['url'])
        self.assertEqual(parsed.netloc, '192.168.4.2:3456')
        self.assertEqual(parse_qs(parsed.query), {'token': [config['token']], 'defaultProvider': ['codex'], 'name': ['Even Terminal for Codex Mac App']})
        self.assertEqual(result['network'], 'lan')
        self.assertEqual(self.config.read_bytes(), before)
        api.assert_called_once_with(config, '/api/info?provider=codex', timeout=3)

    def test_pair_wrong_live_service_cannot_disclose_token(self):
        self.write_config()
        manifest = {'nodeExecutable': '/reviewed/node', 'bridgeVersion': 'G2 Desktop Bridge test'}
        with patch.object(setup.control, 'installation', return_value=self.record), \
             patch.object(setup.control, 'release_summary', return_value=manifest), \
             patch.object(common, 'command_output', return_value=common.EXPECTED_NODE_VERSION), \
             patch.object(setup, 'network_address', return_value='100.80.4.2'), \
             patch.object(common, 'api', return_value={'version': 'different service'}):
            with self.assertRaisesRegex(common.BridgeError, 'not ready'):
                setup.pair(self.support, reveal=True)

    def test_network_address_matches_lan_and_interface_selection(self):
        interfaces = {'lo0': [{'family': 'IPv4', 'internal': True, 'address': '127.0.0.1'}],
                      'utun0': [{'family': 'IPv4', 'internal': False, 'address': '100.80.2.3'}],
                      'en7': [{'family': 'IPv4', 'internal': False, 'address': '172.19.2.4'}],
                      'en0': [{'family': 'IPv4', 'internal': False, 'address': '192.168.2.1'}]}
        with patch.object(common, 'command_output', return_value=json.dumps(interfaces)):
            self.assertEqual(setup.network_address({'network': {'mode': 'lan'}}, '/reviewed/node'), '172.19.2.4')
            self.assertEqual(setup.network_address({'network': {'mode': 'interface', 'name': 'en0'}}, '/reviewed/node'), '192.168.2.1')
            self.assertIsNone(setup.network_address({'network': {'mode': 'interface', 'name': 'missing'}}, '/reviewed/node'))

    def test_inspect_never_includes_private_pairing_token(self):
        config = self.write_config('lan')
        with patch.object(common, 'desktop_build', return_value=common.EXPECTED_BUILD), \
             patch.object(common, 'command_output', return_value='Python 3.9.6'), \
             patch.object(setup, 'network_address', return_value='192.168.1.2'):
            result = setup.inspect(self.support, self.config)
        self.assertNotIn(config['token'], json.dumps(result))
        self.assertTrue(result['ready'])
        self.assertFalse(self.support.exists())

    def test_tailscale_discovery_accepts_official_bundle_without_global_launcher(self):
        app = self.root / 'Applications/Tailscale.app/Contents'
        (app / 'MacOS').mkdir(parents=True)
        executable = app / 'MacOS/Tailscale'
        executable.write_text('#!/bin/sh\nexit 0\n')
        executable.chmod(0o700)
        (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'io.tailscale.ipn.macsys'}))
        self.assertEqual(common.tailscale_executable([], [self.root / 'Applications']), executable)
        (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'unrelated.app'}))
        self.assertIsNone(common.tailscale_executable([], [self.root / 'Applications']))

    def test_only_discovered_tailscale_tool_gets_explicit_cli_mode(self):
        with patch.object(common, 'tailscale_executable', return_value=Path('/trusted/Tailscale')), \
             patch.object(common.subprocess, 'check_output', return_value='100.80.2.3') as run, \
             patch.dict(os.environ, {'TAILSCALE_BE_CLI': 'bad-value'}):
            common.command_output(['/trusted/Tailscale', 'ip', '-4'])
            self.assertEqual(run.call_args.kwargs['env']['TAILSCALE_BE_CLI'], '1')
            common.command_output(['/usr/bin/python3', '--version'])
            self.assertNotIn('TAILSCALE_BE_CLI', run.call_args.kwargs['env'])

    def test_private_tailscale_shim_preserves_arguments_and_never_evaluates_them(self):
        executable = self.root / 'a path with spaces/Tailscale'
        executable.parent.mkdir()
        executable.write_text('#!/bin/sh\nprintf \'%s\\n\' "$TAILSCALE_BE_CLI" "$@"\n')
        executable.chmod(0o700)
        setup.manage.install_operations(self.support)
        with patch.object(common, 'tailscale_executable', return_value=executable):
            environment = common.child_environment(self.support)
        result = subprocess.check_output([str(self.support / 'operations/tailscale'),
                                          'ip', '-4', 'literal $(touch no-such-file)'],
                                         env=environment, text=True)
        self.assertEqual(result.splitlines(), ['1', 'ip', '-4', 'literal $(touch no-such-file)'])
        self.assertEqual((self.support / 'operations').stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.support / 'operations/tailscale').stat().st_mode & 0o777, 0o700)


if __name__ == '__main__':
    unittest.main()
