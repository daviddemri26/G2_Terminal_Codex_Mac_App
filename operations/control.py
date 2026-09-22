"""Small JSON-only interface for the native Even Terminal for Codex Mac App control application.

No command sends prompts, starts a Codex engine, exposes configuration tokens,
or selects arbitrary executables. Read-only polling does not hash runtime files.
"""
import argparse
from contextlib import suppress
import json
import os
from pathlib import Path
import plistlib
import re
import socket
import stat
import subprocess
import sys
import time

import common
import manage
from supervisor import network_address


MAX_INPUT_BYTES = 4096
MAX_JSON_BYTES = 4 * 1024 * 1024
DEFAULT_TEXT_FORMATTING = {'showTimestamps': True, 'showProgressUpdates': True,
                           'paragraphSpacing': 'original'}
FORMATTING_VERSIONS = ('G2 Desktop Bridge 0.2.8', 'G2 Desktop Bridge 0.2.9')
STATES = {
    'not_installed': ('The managed bridge is not installed.', 'Install a reviewed release from the project.'),
    'stopped': ('The bridge is stopped.', 'Start the bridge when you are ready.'),
    'ready': ('The local bridge is ready.', 'The glasses connection is not measured by this application.'),
    'busy': ('A bridge task is active.', 'Wait for it to finish before changing the service.'),
    'delivery_pending': ('A previous delivery still needs confirmation.', 'Check the selected task in the Codex Mac App before changing the service.'),
    'starting': ('The supervised bridge is starting.', 'The service will reconnect automatically.'),
    'waiting_for_desktop': ('The Codex Mac App is unavailable.', 'Open the Codex Mac App; the bridge will reconnect automatically.'),
    'waiting_for_tailscale': ('Waiting for the configured network.', 'Open Tailscale on this Mac and connect it.'),
    'desktop_update_required': ('The Codex Mac App version needs compatibility verification.', 'Review a compatible bridge release before using this version.'),
    'unreachable': ('The supervised bridge is not responding.', 'Run diagnostics. Unconfirmed messages are never resent automatically.'),
    'unmanaged_service': ('Another service owns the bridge port.', 'Inspect the existing service before starting this bridge.'),
    'invalid_installation': ('The managed installation needs attention.', 'Run diagnostics or reinstall a reviewed release.'),
    'update_required': ('The verified bridge cannot start.', 'Run diagnostics and review the installed runtime.'),
    'reconnecting': ('The bridge is reconnecting.', 'Desktop tasks continue in the Codex Mac App.'),
    'reconnect_pending': ('The network changed while a bridge task was active.', 'The bridge will reconnect after the task finishes.'),
    'restart_pending': ('The bridge supervisor is waiting to retry.', 'The same installed release will be used.'),
    'port_in_use': ('Another process is using the bridge port.', 'Run diagnostics; a second bridge will not be started.'),
    'unexpected_service': ('The local service does not match the installed release.', 'Inspect the installation before using the bridge.'),
}


def checked_at():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def owned_file(path):
    path = Path(path)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
        raise common.BridgeError('A managed file has unexpected ownership or permissions. Reinstall the reviewed bridge.')
    return path


def read_record(path):
    path = owned_file(path)
    with path.open('rb') as stream:
        data = stream.read(MAX_JSON_BYTES + 1)
    if len(data) > MAX_JSON_BYTES:
        raise common.BridgeError('A managed record is too large. Run diagnostics.')
    value = json.loads(data)
    if not isinstance(value, dict):
        raise common.BridgeError('A managed record is invalid. Reinstall the reviewed bridge.')
    return value


def installation(support):
    support = Path(support)
    metadata = support.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
        raise common.BridgeError('The managed installation directory has unexpected ownership or permissions.')
    control = read_record(support / 'control.json')
    if control.get('format') != 1 or control.get('label') != common.LABEL:
        raise common.BridgeError('The managed installation record is invalid. Reinstall the reviewed bridge.')
    config_path = control.get('configPath')
    if not isinstance(config_path, str) or not Path(config_path).is_absolute():
        raise common.BridgeError('The saved configuration path is invalid.')
    return control


def release_summary(support, reference):
    """Verify the small manifest only. Full integrity is a mutation/diagnostic gate."""
    if not isinstance(reference, dict):
        raise common.BridgeError('The selected bridge release is invalid.')
    name = reference.get('name')
    if not isinstance(name, str) or not name or Path(name).name != name or name.startswith('.'):
        raise common.BridgeError('The selected bridge release is invalid.')
    root = Path(support) / 'releases' / name
    if root.is_symlink() or not root.is_dir():
        raise common.BridgeError('The verified bridge release is missing. Reinstall the bridge.')
    path = owned_file(root / 'manifest.json')
    if path.stat().st_size > MAX_JSON_BYTES or common.digest(path) != reference.get('manifestSha256'):
        raise common.BridgeError('The bridge verification record changed. Reinstall a verified release.')
    manifest = read_record(path)
    if manifest.get('bridgeVersion') not in manage.VERSIONS:
        raise common.BridgeError('The installed bridge version is not reviewed.')
    if manifest.get('nodeVersion') != common.EXPECTED_NODE_VERSION:
        raise common.BridgeError('The installed Node.js version is not reviewed.')
    return manifest


def assert_owned_plist(support, missing_ok=False):
    path = manage.plist_path()
    if not path.exists() and not path.is_symlink() and missing_ok:
        return
    path = owned_file(path)
    if path.stat().st_size > 65536:
        raise common.BridgeError('The LaunchAgent record is invalid.')
    actual = plistlib.loads(path.read_bytes())
    expected = common.make_plist(support, '/usr/bin/python3')
    if actual != expected:
        raise common.BridgeError('LaunchAgent ownership changed. No service was modified.')


def service_snapshot(support):
    result = manage.launchctl('print', manage.domain() + '/' + common.LABEL, check=False, timeout=3)
    if result.returncode:
        return {'loaded': False, 'pid': None}
    assert_owned_plist(support)
    match = re.search(r'(?ms)^\s*arguments = \{\s*\n(.*?)^\s*\}', result.stdout)
    arguments = [line.strip() for line in match.group(1).splitlines() if line.strip()] if match else []
    expected = common.make_plist(support, '/usr/bin/python3')['ProgramArguments']
    if arguments != expected:
        raise common.BridgeError('The loaded LaunchAgent has a different owner. No service was modified.')
    pid_match = re.search(r'(?m)^\s*pid = (\d+)\s*$', result.stdout)
    return {'loaded': True, 'pid': int(pid_match.group(1)) if pid_match else None}


def desktop_available():
    """A socket connection is a reachability probe, never an IPC request."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(.25)
        try:
            probe.connect(str(Path.home() / '.codex/ipc/ipc.sock'))
            return True
        except OSError:
            return False


def safe_to_change(config, support):
    try:
        manage.assert_idle(config, support)
        return True
    except Exception:
        return False


def validate_formatting(value):
    if (not isinstance(value, dict) or set(value) != set(DEFAULT_TEXT_FORMATTING)
            or type(value.get('showTimestamps')) is not bool
            or type(value.get('showProgressUpdates')) is not bool
            or value.get('paragraphSpacing') not in ('original', 'compact', 'comfortable')):
        raise common.BridgeError('Text settings require boolean showTimestamps and showProgressUpdates values, '
                                 'and paragraphSpacing set to original, compact, or comfortable.')
    return {name: value[name] for name in DEFAULT_TEXT_FORMATTING}


def saved_formatting(support):
    path = Path(support) / 'preferences.json'
    try:
        path = owned_file(path)
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise ValueError('Oversized preferences')
        record = read_record(path)
        if type(record.get('format')) is not int or record['format'] != 1 or set(record) != {'format', 'textFormatting'}:
            raise ValueError('Invalid preferences format')
        return validate_formatting(record['textFormatting']), True
    except FileNotFoundError:
        return dict(DEFAULT_TEXT_FORMATTING), True
    except Exception:
        # Match the runtime fallback, never publish corrupted file contents.
        return dict(DEFAULT_TEXT_FORMATTING), False


def network_mode(config):
    mode = config.get('network', {}).get('mode', 'lan')
    return mode if mode in ('tailscale', 'lan', 'interface', 'expose') else 'unknown'


def pending_update(support):
    """A bounded, sanitized UI hint; it never authorizes a lifecycle change."""
    try:
        path = owned_file(Path(support) / 'pending-update.json')
        if path.stat().st_size > MAX_INPUT_BYTES:
            return None
        record = read_record(path)
        state = record.get('state')
        if state not in ('waiting', 'complete', 'stopped') or record.get('targetVersion') not in manage.VERSIONS:
            return None
        if state == 'waiting':
            expiry = record.get('expiresAt')
            if type(expiry) not in (int, float) or not time.time() < expiry <= time.time() + 3900:
                state = 'stopped'
        return {'state': state, 'targetVersion': record['targetVersion']}
    except Exception:
        return None


def status(support):
    support = Path(support)
    result = {'installed': (support / 'control.json').is_file(), 'running': False,
        'launchAtLogin': False, 'bridgeVersion': None, 'previousVersion': None,
        'state': 'not_installed', 'message': '', 'action': '', 'desktopCompatible': False,
        'desktopAvailable': desktop_available(), 'networkAvailable': False,
        'networkMode': 'unknown', 'networkVerified': False,
        'safeToChange': False, 'canStart': False, 'canChangePreferences': False, 'canRollback': False,
        'textFormatting': dict(DEFAULT_TEXT_FORMATTING), 'formattingPreferencesValid': True,
        'formattingSupported': False, 'canChangeFormatting': False,
        'pendingUpdate': None,
        'supportPath': str(support), 'checkedAt': checked_at()}
    result['desktopCompatible'] = common.desktop_build() == common.EXPECTED_BUILD
    if result['installed']:
        try:
            control = installation(support)
            result['pendingUpdate'] = pending_update(support)
            manifest = release_summary(support, control['activeRelease'])
            result['bridgeVersion'] = manifest['bridgeVersion']
            result['formattingSupported'] = manifest['bridgeVersion'] in FORMATTING_VERSIONS
            result['textFormatting'], result['formattingPreferencesValid'] = saved_formatting(support)
            if control.get('previousRelease'):
                with suppress(Exception):
                    previous = release_summary(support, control['previousRelease'])
                    result['previousVersion'] = previous['bridgeVersion']
                    result['canRollback'] = True
            service = service_snapshot(support)
            assert_owned_plist(support, missing_ok=True)
            result['running'] = service['loaded']
            result['launchAtLogin'] = manage.launch_at_login() and manage.plist_path().exists()
            result['canChangePreferences'] = manage.plist_path().exists()
            result['canChangeFormatting'] = result['formattingSupported'] and manage.plist_path().exists()
            config = common.load_config(owned_file(control['configPath']))
            result['networkAvailable'] = network_address(config) is not None
            result['networkMode'] = network_mode(config)
            result['networkVerified'] = result['networkMode'] == 'tailscale'
            result['safeToChange'] = safe_to_change(config, support)
            available, responded = False, False
            if not common.port_available(config.get('port', 3456)):
                with suppress(Exception):
                    info = common.api(config, '/api/info?provider=codex', timeout=1)
                    available = info.get('version') == manifest['bridgeVersion']
                    responded = True
                if not available:
                    result['safeToChange'] = False
            if not service['loaded']:
                state = 'stopped' if common.port_available(config.get('port', 3456)) else 'unmanaged_service'
                if state == 'unmanaged_service':
                    result['safeToChange'] = False
                elif result['desktopCompatible']:
                    with suppress(Exception):
                        assert_startable(support, control, config)
                        result['canStart'] = True
            elif available:
                if not result['desktopCompatible']:
                    state = 'desktop_update_required'
                elif not result['desktopAvailable']:
                    state = 'waiting_for_desktop'
                elif not result['networkAvailable']:
                    state = 'waiting_for_tailscale'
                else:
                    state = 'ready' if result['safeToChange'] else 'busy'
            elif responded:
                state = 'unexpected_service'
                result['safeToChange'] = False
            else:
                state = 'starting'
                with suppress(Exception):
                    operational = read_record(support / 'status.json')
                    if (service['pid'] and operational.get('supervisorPid') == service['pid'] and
                            time.time() - (support / 'status.json').stat().st_mtime < 60):
                        candidate = operational.get('status')
                        if candidate in STATES and candidate not in ('ready', 'stopped'):
                            state = candidate
                        elif candidate == 'ready':
                            state = 'unreachable'
                if state == 'starting' and not result['networkAvailable']:
                    state = 'waiting_for_tailscale'
            if common.pending_delivery(support):
                state = 'delivery_pending'
                result['safeToChange'] = False
            result['state'] = state
        except Exception:
            result.update(state='invalid_installation', safeToChange=False, canStart=False,
                          canChangePreferences=False, canChangeFormatting=False, canRollback=False)
    result['message'], result['action'] = STATES[result['state']]
    return result


def diagnostics(support):
    """Strict output allowlist: no raw status, config, subprocess, or task data."""
    result = status(support)
    detail = {'runtimeVerified': False, 'previousRuntimeVerified': None,
              'sourceAvailable': False, 'sourceChanged': None, 'checks': []}
    if result['installed']:
        try:
            control = installation(support)
            common.validate_release(support, control['activeRelease'])
            detail['runtimeVerified'] = True
            detail['checks'].append('The complete installed runtime and Node version passed verification.')
            if control.get('previousRelease'):
                try:
                    common.validate_release(support, control['previousRelease'])
                    detail['previousRuntimeVerified'] = True
                except Exception:
                    detail['previousRuntimeVerified'] = False
                    result['canRollback'] = False
                    detail['checks'].append('The previous release is unavailable or failed verification.')
            source = control.get('sourcePackage')
            if source and control.get('sourceFingerprint'):
                with suppress(OSError, ValueError):
                    fingerprint = manage.source_fingerprint(source)
                    detail.update(sourceAvailable=True, sourceChanged=fingerprint != control['sourceFingerprint'])
        except Exception:
            detail['checks'].append('The installed runtime failed verification. Reinstall a reviewed release.')
            result.update(state='invalid_installation', safeToChange=False, canStart=False)
            result['message'], result['action'] = STATES[result['state']]
    detail['checks'].append('Glasses connectivity is not measured; this checks the local service and its dependencies.')
    result['diagnostics'] = detail
    return result


def read_settings_input(stream):
    data = stream.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise common.BridgeError('The settings request is too large.')
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise common.BridgeError('The settings request must be valid JSON.') from None
    return value


def read_preferences(stream):
    value = read_settings_input(stream)
    if not isinstance(value, dict) or set(value) != {'launchAtLogin'} or type(value['launchAtLogin']) is not bool:
        raise common.BridgeError('Settings must contain only a boolean launchAtLogin value.')
    return value


def read_formatting(stream):
    return validate_formatting(read_settings_input(stream))


def check_start(support, control):
    common.validate_release(support, control['activeRelease'])
    build = common.desktop_build()
    if build is not None and build != common.EXPECTED_BUILD:
        raise common.BridgeError('The Codex Mac App version needs compatibility verification before starting this bridge.')
    for name in manage.OPERATIONS:
        owned_file(Path(support) / 'operations' / name)


def assert_control_idle(support, control, config):
    manage.assert_idle(config, support)
    if not common.port_available(config.get('port', 3456)):
        expected = release_summary(support, control['activeRelease'])['bridgeVersion']
        try:
            actual = common.api(config, '/api/info?provider=codex', timeout=2).get('version')
        except Exception:
            raise common.BridgeError('The bridge identity cannot be verified. No service was modified.') from None
        if actual != expected:
            raise common.BridgeError('The local service does not match the installed release. No service was modified.')


def assert_startable(support, control, config):
    """Same-release recovery may reconcile a journal but may never replay it."""
    if service_snapshot(support)['loaded'] or not common.port_available(config.get('port', 3456)):
        raise common.BridgeError('The bridge is not fully stopped. No second bridge was started.')
    try:
        operational = read_record(Path(support) / 'status.json')
    except FileNotFoundError:
        operational = {}
    if manage.managed_bridge_pid_alive(support, operational.get('bridgePid')):
        raise common.BridgeError('A managed bridge process is still running. No second bridge was started.')


def start_service(support, control, config):
    if service_snapshot(support)['loaded']:
        return
    check_start(support, control)
    assert_owned_plist(support, missing_ok=True)
    assert_startable(support, control, config)
    manage.write_plist(support)
    manage.wait_unloaded()
    assert_startable(support, control, config)
    manage.bootstrap()


def stop_service(support, control, config):
    assert_control_idle(support, control, config)
    if not service_snapshot(support)['loaded']:
        return
    # Recheck the launchd record immediately before targeting its stable label.
    if service_snapshot(support)['loaded']:
        assert_control_idle(support, control, config)
        manage.launchctl('bootout', manage.domain() + '/' + common.LABEL)
        manage.wait_unloaded()
        manage.wait_port_free(config.get('port', 3456))
    common.status(support, 'stopped', 'Bridge supervision was stopped for this login session.',
                  'The launch-at-login preference is unchanged. Desktop tasks remain in the Codex Mac App.')


def mutate(command, support, preferences=None):
    support = Path(support)
    # Validate before creating the lock directory; never manufacture an installation.
    installation(support)
    with common.exclusive_lock(support / 'run/management.lock'):
        control = installation(support)
        config = common.load_config(owned_file(control['configPath']))
        assert_owned_plist(support, missing_ok=command == 'start')
        service_snapshot(support)
        if command == 'start':
            start_service(support, control, config)
        elif command == 'stop':
            stop_service(support, control, config)
        elif command == 'restart':
            check_start(support, control)
            assert_control_idle(support, control, config)
            stop_service(support, control, config)
            start_service(support, control, config)
        elif command == 'set-preferences':
            # enable/disable changes next-login policy without unloading or
            # interrupting the currently registered service or its interactions.
            service_snapshot(support)
            manage.launchctl('enable' if preferences['launchAtLogin'] else 'disable',
                             manage.domain() + '/' + common.LABEL)
        elif command in ('set-formatting', 'reset-formatting'):
            if release_summary(support, control['activeRelease'])['bridgeVersion'] not in FORMATTING_VERSIONS:
                raise common.BridgeError('Install a bridge release with text settings before changing formatting.')
            formatting = validate_formatting(DEFAULT_TEXT_FORMATTING if command == 'reset-formatting' else preferences)
            path = support / 'preferences.json'
            if path.exists() or path.is_symlink():
                owned_file(path)
            common.atomic_json(path, {'format': 1, 'textFormatting': formatting})
        elif command == 'rollback':
            if not control.get('previousRelease'):
                raise common.BridgeError('No verified previous release is available.')
            common.validate_release(support, control['previousRelease'])
            assert_control_idle(support, control, config)
            service_snapshot(support)
            target = dict(control, activeRelease=control['previousRelease'], previousRelease=control['activeRelease'])
            manage.switch_release(support, target, control, config)
        else:
            raise common.BridgeError('This control command is not supported.')


def public_error(error):
    if isinstance(error, common.BridgeError):
        message = str(error)
        if message.startswith('launchd could not complete'):
            return 'macOS could not complete the service operation. Run diagnostics and retry.'
        return message
    if isinstance(error, subprocess.TimeoutExpired):
        return 'The service operation timed out. Refresh status before trying again.'
    return 'The operation could not be completed. Run diagnostics and check the managed installation.'


class JSONArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise common.BridgeError('Invalid command arguments. Use status, diagnose, start, stop, restart, '
                                 'set-preferences, set-formatting, reset-formatting, or rollback.')


def main(argv=None):
    support = common.DEFAULT_SUPPORT
    try:
        parser = JSONArgumentParser(description=__doc__)
        parser.add_argument('command', choices=('status', 'diagnose', 'start', 'stop', 'restart', 'set-preferences',
                                               'set-formatting', 'reset-formatting', 'rollback'))
        parser.add_argument('--support', type=Path, default=common.DEFAULT_SUPPORT)
        parser.add_argument('--apply', action='store_true')
        args = parser.parse_args(argv)
        support = args.support.absolute()
        os.umask(0o077)
        if args.command == 'status':
            result = status(support)
        elif args.command == 'diagnose':
            result = diagnostics(support)
        else:
            if not args.apply:
                raise common.BridgeError('Changing the service requires --apply.')
            preferences = read_preferences(sys.stdin.buffer) if args.command == 'set-preferences' else None
            if args.command == 'set-formatting':
                preferences = read_formatting(sys.stdin.buffer)
            mutate(args.command, support, preferences)
            result = status(support)
        result['ok'] = True
        print(json.dumps(result))
        return 0
    except Exception as error:
        # Never include an exception repr, child output, configuration, or traceback.
        result = status(support)
        result.update(ok=False, error=public_error(error))
        print(json.dumps(result))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
