"""First-run setup and explicit local pairing disclosure; never send a task prompt."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
from urllib.parse import urlencode

import common
import control
import manage

DEFAULT_PROJECT = Path.home() / 'Documents/G2 Projects'
SUPPORTED_NETWORKS = ('tailscale', 'lan', 'interface')


def existing_config(path):
    """Read only an owner-only regular config; never silently convert another provider."""
    path = control.owned_file(path)
    if path.stat().st_mode & 0o077:
        raise common.BridgeError('The pairing configuration must be private (file permission 0600). Its contents were not changed.')
    value = control.read_record(path)
    common.load_config(path)
    network = value.get('network')
    if (value.get('version') != 1 or value.get('provider') != 'codex'
            or not isinstance(network, dict) or network.get('mode') not in SUPPORTED_NETWORKS):
        raise common.BridgeError('The existing Even Terminal profile is not a supported Codex desktop profile. It was preserved; see the setup guide before migrating it.')
    if set(value) - {'version', 'provider', 'cwd', 'network', 'port', 'token', 'name', 'claude'}:
        raise common.BridgeError('The existing Even Terminal profile has unsupported fields. It was preserved.')
    cwd = value.get('cwd')
    if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
        raise common.BridgeError('The existing project folder is unavailable. Restore it before setup; the profile was preserved.')
    keys = {'mode', 'name'} if network['mode'] == 'interface' else {'mode'}
    if set(network) != keys or ('name' in network and
            (not isinstance(network['name'], str) or not network['name'].strip())):
        raise common.BridgeError('The existing network configuration is invalid. It was preserved.')
    if 'name' in value and (not isinstance(value['name'], str) or not value['name'].strip()):
        raise common.BridgeError('The existing connection name is invalid. The profile was preserved.')
    claude = value.get('claude', {})
    if (not isinstance(claude, dict) or set(claude) - {'useSystemCli', 'allowedTools'}
            or not isinstance(claude.get('useSystemCli', False), bool)
            or ('allowedTools' in claude and
                (not isinstance(claude['allowedTools'], list)
                 or any(not isinstance(tool, str) or not tool.strip() for tool in claude['allowedTools'])))):
        raise common.BridgeError('The existing profile has invalid provider options. It was preserved.')
    return value


def network_address(config, node=None):
    mode = config.get('network', {}).get('mode', 'tailscale')
    if mode == 'tailscale':
        try:
            executable = common.tailscale_executable()
            if executable is None:
                return None
            output = common.command_output([str(executable), 'ip', '-4'], timeout=5)
            address = ipaddress.IPv4Address(output.splitlines()[0])
            return str(address) if address in ipaddress.IPv4Network('100.64.0.0/10') else None
        except (OSError, ValueError, IndexError, subprocess.SubprocessError):
            return None
    if mode not in ('lan', 'interface') or node is None:
        return None
    # Use Node's interface order, matching the pinned upstream resolver. Built-in
    # os introspection does not import or start any provider or application engine.
    try:
        output = common.command_output([str(node), '-e',
            'process.stdout.write(JSON.stringify(require("node:os").networkInterfaces()))'], timeout=5)
        interfaces = json.loads(output)
        rows = ([interfaces.get(config['network']['name'], [])] if mode == 'interface'
                else interfaces.values())
        private = [ipaddress.IPv4Network(prefix) for prefix in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
        for group in rows:
            for entry in group or []:
                if entry.get('family') != 'IPv4' or (mode == 'lan' and entry.get('internal')):
                    continue
                address = ipaddress.IPv4Address(entry['address'])
                if mode == 'interface' or any(address in network for network in private):
                    return str(address)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        pass
    return None


def inspect(support=common.DEFAULT_SUPPORT, config_path=common.DEFAULT_CONFIG, source=None, node=None):
    support, config_path = Path(support), Path(config_path)
    installed = (support / 'control.json').exists()
    requirements = []
    def requirement(identifier, title, ready, message):
        requirements.append({'id': identifier, 'title': title, 'ready': bool(ready), 'message': message})
    requirement('desktop', 'Codex Mac app', common.desktop_build() == common.EXPECTED_BUILD,
        'Reviewed: Codex ' + common.EXPECTED_BUILD['CFBundleShortVersionString'] + ' (build ' + common.EXPECTED_BUILD['CFBundleVersion'] + ').')
    try:
        available = common.command_output(['/usr/bin/python3', '--version']).startswith('Python 3.')
    except (OSError, subprocess.SubprocessError):
        available = False
    requirement('python', 'Apple developer tools', available,
                'The background service needs Python 3 from the Apple Command Line Tools.')
    project = str(DEFAULT_PROJECT)
    config = {'network': {'mode': 'tailscale'}, 'port': 3456}
    config_ok = True
    config_message = 'Setup will create a private pairing token and keep it on this Mac.'
    try:
        if installed:
            record = control.installation(support)
            config_path = Path(record['configPath'])
            if node is None:
                node = control.release_summary(support, record['activeRelease'])['nodeExecutable']
        if config_path.exists() or config_path.is_symlink():
            config = existing_config(config_path)
            project = config['cwd']
            config_message = 'Your existing pairing token, project folder, and network choice will be preserved.'
    except (common.BridgeError, OSError, ValueError, KeyError):
        config_ok = False
        config_message = 'An existing profile or installation needs review; setup will preserve it.'
    requirement('profile', 'Pairing profile', config_ok, config_message)
    mode = config.get('network', {}).get('mode', 'tailscale')
    address = network_address(config, node)
    requirement('network', 'Tailscale' if mode == 'tailscale' else 'Existing ' + mode + ' network', bool(address),
        ('Connect Tailscale on this Mac and phone. The installed app or its existing command-line launcher is detected automatically.'
         if mode == 'tailscale' else 'Keep the existing network choice. Local-network pairing requires a reachable IPv4 address; physical device validation is separate.'))
    if source is not None:
        try:
            package_ready = manage.source_version(source) == manage.INSTALL_VERSION
        except (OSError, ValueError, common.BridgeError):
            package_ready = False
        requirement('runtime', 'Reviewed bridge build', package_ready,
                    'The guided installer builds the locked source before installing it.')
    if node is not None:
        try:
            node_ready = common.command_output([str(node), '--version']) == common.EXPECTED_NODE_VERSION
        except (OSError, subprocess.SubprocessError):
            node_ready = False
        requirement('node', 'Node.js ' + common.EXPECTED_NODE_VERSION, node_ready,
                    'The guided installer reuses this version or downloads the pinned official runtime.')
    return {'ok': True, 'installed': installed, 'ready': all(row['ready'] for row in requirements),
            'configExists': config_path.exists(), 'projectDirectory': project, 'network': mode,
            'requirements': requirements}


def create_config(path, project):
    path, project = Path(path), Path(project)
    common.private_directory(path.parent)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    value = {'version': 1, 'provider': 'codex', 'cwd': str(project),
             'network': {'mode': 'tailscale'}, 'port': 3456,
             'token': secrets.token_hex(32), 'name': 'G2 Bridge',
             'claude': {'useSystemCli': False}}
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    return value


def create(source, node, payload, support=common.DEFAULT_SUPPORT, config_path=common.DEFAULT_CONFIG):
    if not isinstance(payload, dict) or set(payload) - {'projectDirectory'}:
        raise common.BridgeError('Setup accepts only an optional projectDirectory setting.')
    if source is None or node is None:
        raise common.BridgeError('Use the guided installer to build and select the reviewed runtime.')
    # Lock the same installation identity used by all lifecycle operations.
    support = common.private_directory(Path(support).absolute())
    with common.exclusive_lock(support / 'run/management.lock'):
        if (support / 'control.json').exists():
            raise common.BridgeError('A managed bridge is already installed. Setup did not change it. Use the documented update procedure.')
        if manage.loaded() or manage.plist_path().exists():
            raise common.BridgeError('An existing service registration needs review. Setup did not replace it.')
        check = inspect(support, config_path, source, node)
        if not check['ready']:
            missing = ', '.join(row['title'] for row in check['requirements'] if not row['ready'])
            raise common.BridgeError('Finish these setup requirements first: ' + missing + '.')
        manage.reviewed_node_version(source, node)
        config_path = Path(config_path).absolute()
        preserved = config_path.exists() or config_path.is_symlink()
        if preserved:
            config = existing_config(config_path)
            requested = payload.get('projectDirectory')
            if requested is not None and requested != config['cwd']:
                raise common.BridgeError('An existing profile already selects a project. Setup preserved it rather than changing its settings.')
        else:
            requested = payload.get('projectDirectory', str(DEFAULT_PROJECT))
            if not isinstance(requested, str) or not Path(requested).is_absolute():
                raise common.BridgeError('Choose an absolute path for your project folder.')
            project = Path(requested)
            if project == DEFAULT_PROJECT and not project.exists():
                project.mkdir(parents=True, mode=0o700)
            if not project.is_dir():
                raise common.BridgeError('The selected project folder does not exist.')
            config = None
        port = config.get('port', 3456) if config else 3456
        if not common.port_available(port):
            raise common.BridgeError('The bridge port is in use. Setup preserved the other process and did not create another service.')
        # Freeze and validate before creating credentials. A failed setup retains
        # any created profile so retrying never silently rotates its token.
        new = manage.prepare_release(source, support, node)
        if config is None:
            config = create_config(config_path, project)
        record = {'format': 1, 'activeRelease': new, 'previousRelease': None,
                  'configPath': str(config_path), 'sourcePackage': str(Path(source).resolve()),
                  'sourceFingerprint': manage.source_fingerprint(source), 'label': common.LABEL}
        manage.switch_release(support, record, None, config)
        manage.prune_releases(support, record)
    return {'ok': True, 'complete': True, 'installed': True, 'configurationPreserved': preserved,
            'message': 'The bridge is installed. Open G2 Bridge, then Connect to show the pairing code.'}


def pair(support=common.DEFAULT_SUPPORT, reveal=False):
    if not reveal:
        raise common.BridgeError('Pairing reveals a private access token. Use the app’s Show pairing code button, or explicitly add --reveal.')
    record = control.installation(support)
    config = existing_config(record['configPath'])
    manifest = control.release_summary(support, record['activeRelease'])
    if common.command_output([manifest['nodeExecutable'], '--version']) != common.EXPECTED_NODE_VERSION:
        raise common.BridgeError('The installed Node runtime changed. Check compatibility before pairing.')
    mode = config['network']['mode']
    address = network_address(config, manifest['nodeExecutable'])
    if not address or ipaddress.ip_address(address).is_loopback:
        raise common.BridgeError('The configured network has no reachable phone address. Connect it and refresh before pairing.')
    info = common.api(config, '/api/info?provider=codex', timeout=3)
    if info.get('version') != manifest['bridgeVersion']:
        raise common.BridgeError('The bridge is not ready. Start the verified service before pairing.')
    server = 'http://' + address + ':' + str(config.get('port', 3456))
    query = {'token': config['token'], 'defaultProvider': 'codex'}
    if config.get('name'):
        query['name'] = config['name']
    return {'ok': True, 'url': server + '?' + urlencode(query), 'serverURL': server,
            'token': config['token'], 'network': mode}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('inspect', 'create', 'pair'))
    parser.add_argument('--source', type=Path)
    parser.add_argument('--node', type=Path)
    parser.add_argument('--support', type=Path, default=common.DEFAULT_SUPPORT)
    parser.add_argument('--config', type=Path, default=common.DEFAULT_CONFIG)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--reveal', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.command == 'inspect':
            result = inspect(args.support, args.config, args.source, args.node)
        elif args.command == 'pair':
            result = pair(args.support, args.reveal)
        else:
            if not args.apply:
                raise common.BridgeError('Setup requires --apply; no installation was changed.')
            data = sys.stdin.read(16385)
            if len(data) > 16384:
                raise common.BridgeError('The setup request is too large.')
            result = create(args.source, args.node, json.loads(data or '{}'), args.support, args.config)
        print(json.dumps(result, indent=2))
        return 0
    except common.BridgeError as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Do not leak a config, token URL, raw subprocess output, or private task
        # data in a diagnostic. Explicit pairing is the sole credential response.
        print(json.dumps({'ok': False, 'error': 'Setup could not complete. Check the installation and setup guide; existing configuration was preserved.'}))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
