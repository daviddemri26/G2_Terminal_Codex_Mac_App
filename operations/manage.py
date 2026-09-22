"""Stage, install, inspect, and roll back a user LaunchAgent. Mutations need --apply."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

from common import (APP_INFO, BridgeError, DEFAULT_CONFIG, DEFAULT_SOURCE, DEFAULT_SUPPORT,
                    EXPECTED_BUILD, EXPECTED_NODE_VERSION, LABEL, api, atomic_json, command_environment, command_output, desktop_build,
                    digest, exclusive_lock, idle, load_config, make_plist, port_available,
                    pending_delivery, private_directory, read_json, status, validate_release)

VERSIONS = ('G2 Desktop Bridge 0.1', 'G2 Desktop Bridge 0.2', 'G2 Desktop Bridge 0.2.1', 'G2 Desktop Bridge 0.2.2', 'G2 Desktop Bridge 0.2.3', 'G2 Desktop Bridge 0.2.4', 'G2 Desktop Bridge 0.2.5', 'G2 Desktop Bridge 0.2.6', 'G2 Desktop Bridge 0.2.7', 'G2 Desktop Bridge 0.2.8', 'G2 Desktop Bridge 0.2.9', 'G2 Desktop Bridge 0.3.0', 'G2 Desktop Bridge 0.3.1', 'G2 Desktop Bridge 0.3.2')
INSTALL_VERSION = 'G2 Desktop Bridge 0.3.2'
OPERATIONS = ('common.py', 'supervisor.py', 'manage.py', 'control.py', 'desktop_location.py')


def source_fingerprint(source):
    source = Path(source)
    names = {'package.json', 'bin/cli.js', 'dist/routes/core.js', 'dist/routes/events.js',
             'dist/startup/common.js', 'dist/codex/session.js'}
    bridge = source / 'dist/desktop-bridge'
    for path in bridge.rglob('*'):
        relative = path.relative_to(bridge)
        if (path.is_file() and not any(part in ('tests', '__pycache__') for part in relative.parts)
                and not path.name.startswith('test_') and '.test.' not in path.name
                and path.suffix != '.pyc' and path.name != '.DS_Store'):
            names.add(path.relative_to(source).as_posix())
    if (source / 'bridge-build.json').exists():
        names.add('bridge-build.json')
    return {name: digest(source / name) for name in sorted(names)}


def reviewed_node_version(source, node):
    """Freeze only the reviewed runtime, never whatever Node happens to run."""
    metadata_path = Path(source) / 'bridge-build.json'
    if metadata_path.exists():
        try:
            metadata = read_json(metadata_path)
            compatibility = metadata['compatibility']
            desktop = compatibility['desktop']
            if (metadata['nodeVersion'] != EXPECTED_NODE_VERSION or
                    compatibility['nodeVersion'] != EXPECTED_NODE_VERSION or
                    desktop != {'version': EXPECTED_BUILD['CFBundleShortVersionString'],
                                'build': EXPECTED_BUILD['CFBundleVersion']}):
                raise BridgeError('The generated package compatibility does not match the reviewed Node.js and Mac app versions.')
        except (OSError, ValueError, KeyError, TypeError):
            raise BridgeError('The generated package is missing valid compatibility metadata. Rebuild the reviewed runtime.') from None
    try:
        actual = command_output([str(node), '--version'])
    except (OSError, subprocess.SubprocessError):
        raise BridgeError('The reviewed Node.js runtime is unavailable.') from None
    if actual != EXPECTED_NODE_VERSION:
        raise BridgeError('Node.js does not match the reviewed version. Validate compatibility before freezing or installing a release.')
    return actual


def source_version(source):
    source = Path(source)
    core = (source / 'dist/routes/core.js').read_text()
    provider = (source / 'dist/desktop-bridge/provider.mjs').read_text()
    # Match the complete exported version literal; 0.2 must never match 0.2.1
    # or an unreviewed 0.2.10. Multiple version declarations fail closed.
    declarations = re.findall(r"\bversion\s*:\s*(['\"])(G2 Desktop Bridge [^'\"]+)\1", provider)
    version = declarations[0][1] if len(declarations) == 1 else None
    if version not in VERSIONS or not all(marker in core for marker in (
        'createDesktopProvider', 'desktopBridgeEnabled', 'EVEN_CODEX_DESKTOP_BRIDGE', 'ensure-app-server')):
        raise BridgeError('This is not a reviewed desktop bridge package. The original npm engine will not be used.')
    for name in ('bin/cli.js', 'package.json', 'node_modules'):
        if not (source / name).exists():
            raise BridgeError('The source package is incomplete.')
    return version


def prepare_release(source, support, node):
    """Copy code and all dependencies; no dependency symlink points back into npm."""
    source = Path(source).resolve()
    version = source_version(source)
    node_version = reviewed_node_version(source, node)
    releases = private_directory(Path(support) / 'releases')
    temporary = Path(tempfile.mkdtemp(prefix='.staging-', dir=releases))
    try:
        package = private_directory(temporary / 'package')
        for name in ('dist', 'bin', 'node_modules'):
            shutil.copytree(source / name, package / name, symlinks=True,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
        shutil.copy2(source / 'package.json', package / 'package.json')
        if (source / 'src').is_dir():
            shutil.copytree(source / 'src', package / 'src', symlinks=True,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
        for name in ('README.md', 'bridge-build.json'):
            if (source / name).is_file():
                shutil.copy2(source / name, package / name)
        links = {str(path.relative_to(package)): os.readlink(path)
                 for path in package.rglob('*') if path.is_symlink()}
        for relative in links:
            if not (package / relative).resolve().is_relative_to(package.resolve()):
                raise BridgeError('A dependency links outside the package. Freeze it inside the reviewed package before installation.')
        for path in temporary.rglob('*'):
            if path.is_symlink():
                continue
            if path.is_dir():
                path.chmod(0o700)
            elif path.is_file():
                path.chmod(0o700 if path.stat().st_mode & 0o111 else 0o600)
        files = {str(path.relative_to(package)): digest(path)
                 for path in sorted(package.rglob('*')) if path.is_file() and not path.is_symlink()}
        manifest = {'format': 1, 'bridgeVersion': version,
            'packageVersion': read_json(package / 'package.json')['version'],
            'nodeExecutable': str(Path(node).absolute()), 'nodeVersion': node_version,
            'desktopBuild': dict(EXPECTED_BUILD), 'files': files, 'links': links,
            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        atomic_json(temporary / 'manifest.json', manifest)
        name = time.strftime('%Y%m%d-%H%M%S', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
        destination = releases / name
        temporary.rename(destination)
        return {'name': name, 'manifestSha256': digest(destination / 'manifest.json')}
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def domain():
    return 'gui/' + str(os.getuid())


def plist_path():
    return Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')


def launchctl_diagnostic(stderr):
    line = next((line.strip() for line in (stderr or '').splitlines() if line.strip()), '')
    line = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', line)
    line = ''.join(character for character in line if character.isprintable())
    if not re.match(r'^(?:Bootstrap failed:|Boot-out failed:|Load failed:|Unload failed:|Could not find service|Could not find domain|Bad request\b)', line, re.I):
        return 'No recognized launchctl diagnostic was returned.'
    line = re.sub(r'\b(?:https?|wss?)://\S+', '[URL redacted]', line, flags=re.I)
    line = re.sub(r'\bBearer\s+\S+', 'Bearer [redacted]', line, flags=re.I)
    line = re.sub(r'\b(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|\'[^\']*\'|\S+)',
                  r'\1=[redacted]', line, flags=re.I)
    return line[:240]


def launchctl(*arguments, check=True, timeout=20):
    result = subprocess.run(['/bin/launchctl', *arguments], capture_output=True, text=True,
                            timeout=timeout, env=command_environment())
    if check and result.returncode:
        raise BridgeError('launchd could not complete ' + arguments[0] + ' (exit ' + str(result.returncode) + '): '
                          + launchctl_diagnostic(result.stderr))
    return result


def loaded():
    return launchctl('print', domain() + '/' + LABEL, check=False, timeout=2).returncode == 0


def launch_at_login():
    """Read launchd's persisted override instead of guessing from a stale UI file."""
    result = launchctl('print-disabled', domain(), timeout=3)
    prefix = r'^\s*"' + re.escape(LABEL) + r'"'
    entries = re.findall(prefix + r'\s*=>\s*(.*?)\s*$', result.stdout, re.M)
    if not entries and not re.search(prefix, result.stdout, re.M):
        return True  # No override: our LaunchAgent is enabled by default.
    if len(entries) == 1:
        value = entries[0].rstrip(',;').strip()
        if value in ('true', 'disabled'):
            return False
        if value in ('false', 'enabled'):
            return True
    raise BridgeError('The launch-at-login preference could not be read reliably. No preference was changed.')


def bootstrap():
    """A manual start preserves the user's persisted login preference."""
    auto_start = launch_at_login()
    if not auto_start:
        launchctl('enable', domain() + '/' + LABEL)
    try:
        launchctl('bootstrap', domain(), str(plist_path()))
    finally:
        if not auto_start:
            launchctl('disable', domain() + '/' + LABEL)


def wait_unloaded(timeout=15):
    """An HTTP port can close before launchd has removed its service record."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if not loaded():
            return
        time.sleep(.2)
    raise BridgeError('The previous launchd service has not finished unloading. No replacement was bootstrapped.')


def assert_idle(config, support=None):
    if support is not None and pending_delivery(support):
        raise BridgeError('A task or unconfirmed submission is active. Complete it before changing bridge supervision.')
    # A stopped service cannot answer HTTP. A live but unreachable bridge must
    # still fail closed; its durable status identifies the owned child PID.
    if support is not None and port_available(config.get('port', 3456)):
        try:
            pid = read_json(Path(support) / 'status.json').get('bridgePid')
        except FileNotFoundError:
            pid = None
        if managed_bridge_pid_alive(support, pid):
            raise BridgeError('The bridge is not responding and its task state cannot be verified. Wait or run diagnostics.')
        return
    if not idle(config):
        raise BridgeError('A task or unconfirmed submission is active. Complete it before changing bridge supervision.')


def managed_bridge_pid_alive(support, pid):
    """Reject PID reuse after a reboot; only our actual frozen bridge counts."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        return False
    try:
        control = read_json(Path(support) / 'control.json')
        reference = control['activeRelease']
        name = reference['name']
        if Path(name).name != name or name.startswith('.'):
            raise BridgeError('The selected bridge release is invalid.')
        root = Path(support) / 'releases' / name
        manifest = read_json(root / 'manifest.json')
        expected = ' '.join([manifest['nodeExecutable'], str(root / 'package/bin/cli.js'),
            '--config', control['configPath'], '--log-level', 'info', '--log-file', '/dev/null'])
        uid = command_output(['/bin/ps', '-p', str(pid), '-o', 'uid='])
        command = command_output(['/bin/ps', '-p', str(pid), '-o', 'command='])
        if uid != str(os.getuid()) or command != expected:
            return False
        # A real managed bridge still blocks even if its supervisor died and
        # launchd adopted it. An unrelated process with a reused PID does not.
        parent = command_output(['/bin/ps', '-p', str(pid), '-o', 'ppid='])
        if parent == '1':
            return True
        if not parent.isdigit():
            raise BridgeError('The live bridge process identity cannot be verified.')
        parent_uid = command_output(['/bin/ps', '-p', parent, '-o', 'uid='])
        parent_command = command_output(['/bin/ps', '-p', parent, '-o', 'command='])
        suffix = ' ' + str(Path(support) / 'operations/supervisor.py') + ' --support ' + str(support)
        if parent_uid == str(os.getuid()) and parent_command.endswith(suffix):
            return True
        raise BridgeError('A frozen bridge is running outside its supervisor. Inspect it before changing the service.')
    except subprocess.CalledProcessError as error:
        if error.returncode == 1:  # ps found no remaining process.
            return False
        raise BridgeError('The live bridge process identity cannot be verified.') from None
    except (OSError, subprocess.TimeoutExpired, KeyError, ValueError):
        raise BridgeError('The live bridge process identity cannot be verified.') from None


def process_identity(pid, port):
    if pid <= 1:
        raise BridgeError('The migration PID is invalid.')
    uid = command_output(['/bin/ps', '-p', str(pid), '-o', 'uid='])
    command = command_output(['/bin/ps', '-p', str(pid), '-o', 'command='])
    started = command_output(['/bin/ps', '-p', str(pid), '-o', 'lstart='])
    if uid != str(os.getuid()) or '/opt/homebrew/bin/even-terminal ' not in command:
        raise BridgeError('The old bridge identity changed. No process was stopped.')
    listener = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-p', str(pid),
        '-iTCP:' + str(port), '-sTCP:LISTEN'], capture_output=True, timeout=5)
    if listener.returncode:
        raise BridgeError('The expected old bridge is not the listener. No process was stopped.')
    return (uid, command, started)


def wait_port_free(port, timeout=12):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if port_available(port):
            return
        time.sleep(.2)
    raise BridgeError('The previous bridge did not release its port. No duplicate bridge was started.')


def wait_healthy(support, config, version, timeout=90):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            operational = read_json(Path(support) / 'status.json')
            if (operational.get('bridgePid') and
                api(config, '/api/info?provider=codex').get('version') == version):
                return True
        except Exception:
            pass
        time.sleep(.5)
    return False


def install_operations(support):
    destination = private_directory(Path(support) / 'operations')
    for name in OPERATIONS:
        source = Path(__file__).resolve().parent / name
        if source.resolve() == (destination / name).resolve():
            continue
        temp = destination / ('.' + name + '.tmp')
        shutil.copyfile(source, temp)
        temp.chmod(0o600)
        temp.replace(destination / name)
    # A private launcher lets upstream use its unchanged `tailscale ip -4`
    # command even when only the Mac app's bundled CLI exists. It never logs in,
    # enables a VPN, or changes a global executable/link.
    shim = destination / '.tailscale.tmp'
    shim.write_text('#!/bin/sh\n'
                    ': "${G2_TAILSCALE_EXECUTABLE:?Tailscale executable unavailable}"\n'
                    'export TAILSCALE_BE_CLI=1\n'
                    'exec "$G2_TAILSCALE_EXECUTABLE" "$@"\n')
    shim.chmod(0o700)
    shim.replace(destination / 'tailscale')


def write_plist(support):
    destination = plist_path()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and plistlib.loads(destination.read_bytes()).get('Label') != LABEL:
        raise BridgeError('The LaunchAgent path is occupied by another service.')
    temporary = destination.with_suffix('.plist.tmp')
    temporary.write_bytes(plistlib.dumps(make_plist(support, '/usr/bin/python3')))
    temporary.chmod(0o600)
    temporary.replace(destination)


def switch_release(support, new_control, previous_control, config, adopt_pid=None):
    """Record rollback before stopping anything; restore only frozen desktop releases."""
    support = Path(support)
    port = config.get('port', 3456)
    was_loaded = loaded()
    identity = process_identity(adopt_pid, port) if adopt_pid else None
    if not was_loaded and not adopt_pid and not port_available(port):
        raise BridgeError('An unmanaged bridge already owns the port. Supply its verified migration PID.')
    assert_idle(config, support)
    _, target_manifest = validate_release(support, new_control['activeRelease'])
    config_sha256 = digest(new_control['configPath'])
    atomic_json(support / 'transition.json', {'from': previous_control, 'to': new_control,
        'phase': 'prepared', 'adoptPid': adopt_pid, 'configSha256': config_sha256})
    stopped = False
    try:
        if was_loaded:
            assert_idle(config, support)
            launchctl('bootout', domain() + '/' + LABEL)
            stopped = True
        elif adopt_pid:
            if process_identity(adopt_pid, port) != identity:
                raise BridgeError('The old process changed during migration. No process was stopped.')
            assert_idle(config, support)
            os.kill(adopt_pid, signal.SIGTERM)
            stopped = True
        wait_port_free(port)
        install_operations(support)
        atomic_json(support / 'control.json', new_control)
        write_plist(support)
        wait_unloaded()
        bootstrap()
        if not wait_healthy(support, config, target_manifest['bridgeVersion']):
            raise BridgeError('The managed bridge did not become healthy.')
        transition = read_json(support / 'transition.json')
        transition['phase'] = 'complete'
        transition['configurationUnchanged'] = digest(new_control['configPath']) == transition['configSha256']
        atomic_json(support / 'transition.json', transition)
        if not transition['configurationUnchanged']:
            raise BridgeError('The configuration changed externally during migration; recorded for inspection.')
    except BaseException:
        if stopped or loaded():
            # Never downgrade while a delivery is uncertain or an active interaction might exist.
            can_restore = not pending_delivery(support)
            if can_restore and not port_available(port):
                try:
                    can_restore = idle(config)
                except Exception:
                    can_restore = False
            if not can_restore:
                atomic_json(support / 'transition.json', {'phase': 'recovery_deferred',
                    'from': previous_control, 'to': new_control,
                    'reason': 'An active or unconfirmed interaction must finish before rollback.'})
                raise BridgeError('The bridge health check failed, but an interaction may be active. The current supervised release was preserved; check the Mac and bridge health before rollback.')
            if loaded():
                launchctl('bootout', domain() + '/' + LABEL, check=False)
            wait_port_free(port)
            fallback = previous_control
            if fallback is None and new_control.get('previousRelease'):
                fallback = dict(new_control, activeRelease=new_control['previousRelease'], previousRelease=None)
            if fallback:
                _, fallback_manifest = validate_release(support, fallback['activeRelease'])
                install_operations(support)
                atomic_json(support / 'control.json', fallback)
                write_plist(support)
                wait_unloaded()
                bootstrap()
                recovered = wait_healthy(support, config, fallback_manifest['bridgeVersion'])
                atomic_json(support / 'transition.json', {'phase': 'recovered' if recovered else 'recovery_failed',
                    'from': new_control, 'to': fallback,
                    'configurationUnchanged': digest(new_control['configPath']) == config_sha256})
                if not recovered:
                    raise BridgeError('Migration failed and the verified fallback is unavailable. Run the bridge health check.')
        raise


def prune_releases(support, control):
    keep = {entry['name'] for entry in (control.get('activeRelease'), control.get('previousRelease')) if entry}
    for path in (Path(support) / 'releases').iterdir():
        if path.is_dir() and not path.is_symlink() and path.name not in keep and not path.name.startswith('.'):
            shutil.rmtree(path)


def health(support):
    support = Path(support)
    result = {'launchAgent': LABEL, 'installed': (support / 'control.json').exists()}
    if not result['installed']:
        result.update(status='not_installed', action='Install the reviewed desktop bridge package.')
        return result
    control = read_json(support / 'control.json')
    result['launchAgentLoaded'] = loaded()
    try:
        result['supervisorPython'] = command_output(['/usr/bin/python3', '--version'])
    except Exception:
        result['supervisorPython'] = 'unavailable'
        result['action'] = 'Restore the macOS developer tools Python interpreter used by the LaunchAgent.'
    try:
        root, manifest = validate_release(support, control['activeRelease'])
        result.update(runtimeVerified=True, bridgeVersion=manifest['bridgeVersion'], nodeVersion=manifest['nodeVersion'])
    except Exception as error:
        result.update(runtimeVerified=False, action=str(error) if isinstance(error, BridgeError)
                      else 'A required runtime file is unavailable. Reinstall a verified bridge release.')
    result['desktopCompatible'] = desktop_build() == EXPECTED_BUILD
    try:
        operational = read_json(support / 'status.json')
        result['operational'] = operational
    except OSError:
        result['operational'] = {'status': 'not_started'}
    try:
        config = load_config(control['configPath'])
        info = api(config, '/api/info?provider=codex')
        result['httpAvailable'] = info.get('version') in VERSIONS
        result['safeToChange'] = idle(config) and not pending_delivery(support)
    except Exception:
        result['httpAvailable'] = False
        result['safeToChange'] = False
    source_path = control.get('sourcePackage')
    if source_path and control.get('sourceFingerprint'):
        try:
            result['sourceChanged'] = source_fingerprint(Path(source_path)) != control['sourceFingerprint']
            result['sourceAvailable'] = True
        except (OSError, ValueError):
            result['sourceAvailable'] = False
            result['sourceChanged'] = None
    else:
        result.update(sourceAvailable=False, sourceChanged=None)
    if result['sourceChanged']:
        result['updateAction'] = 'The build source changed. The installed bridge remains isolated; build and review a release before adopting it.'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan', 'install', 'health', 'check-update', 'rollback', 'uninstall'))
    parser.add_argument('--support', type=Path, default=DEFAULT_SUPPORT)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--previous-source', type=Path)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--node', type=Path, default=Path('/opt/homebrew/bin/node'))
    parser.add_argument('--adopt-pid', type=int)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    if args.command in ('health', 'check-update'):
        print(json.dumps(health(args.support), indent=2))
        return 0
    if not args.apply or args.command == 'plan':
        print(json.dumps({'action': args.command, 'apply': False, 'support': str(args.support),
            'launchAgent': str(plist_path()), 'source': str(args.source) if args.source else None,
            'adoptPid': args.adopt_pid, 'configWillChange': False,
            'notice': 'No files, processes, or launchd registrations changed. Add --apply only after review.'}, indent=2))
        return 0
    support = private_directory(args.support.resolve())
    with exclusive_lock(support / 'run/management.lock'):
        old = read_json(support / 'control.json') if (support / 'control.json').exists() else None
        if args.command == 'install':
            if not args.source:
                raise BridgeError('Select the reviewed package with --source.')
            if desktop_build() != EXPECTED_BUILD:
                raise BridgeError('The desktop app build changed; validate compatibility before installation.')
            if source_version(args.source) != INSTALL_VERSION:
                raise BridgeError('Installation requires the reviewed ' + INSTALL_VERSION + ' package.')
            if args.adopt_pid and not old and not args.previous_source:
                raise BridgeError('The first live migration requires --previous-source for a frozen rollback copy.')
            config_path = Path(old['configPath']) if old else args.config.resolve()
            config = load_config(config_path)
            if args.adopt_pid or loaded():
                assert_idle(config, support)
            previous = old['activeRelease'] if old else (
                prepare_release(args.previous_source, support, args.node) if args.previous_source else None)
            new = prepare_release(args.source, support, args.node)
            control = {'format': 1, 'activeRelease': new, 'previousRelease': previous,
                'configPath': str(config_path), 'sourcePackage': str(args.source.resolve()),
                'sourceFingerprint': source_fingerprint(args.source), 'label': LABEL}
            switch_release(support, control, old, config, args.adopt_pid)
            prune_releases(support, control)
        elif args.command == 'rollback':
            if not old or not old.get('previousRelease'):
                raise BridgeError('No verified previous release is available.')
            control = dict(old, activeRelease=old['previousRelease'], previousRelease=old['activeRelease'])
            switch_release(support, control, old, load_config(old['configPath']))
        elif args.command == 'uninstall':
            if not old:
                raise BridgeError('No managed bridge installation exists.')
            config = load_config(old['configPath'])
            if loaded():
                assert_idle(config, support)
                launchctl('bootout', domain() + '/' + LABEL)
                wait_port_free(config.get('port', 3456))
            path = plist_path()
            if path.exists():
                if plistlib.loads(path.read_bytes()).get('Label') != LABEL:
                    raise BridgeError('LaunchAgent ownership changed; its file was preserved.')
                path.unlink()
            status(support, 'uninstalled', 'Automatic bridge startup was removed.',
                   'Backups, provider state, and the original Even Terminal configuration were preserved.')
    print(json.dumps({'action': args.command, 'complete': True, 'configurationPreserved': True}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except BridgeError as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        raise SystemExit(1)
