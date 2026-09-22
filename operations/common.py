"""Shared, standard-library-only operations for the per-user desktop bridge."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import socket
import stat
import subprocess
import tempfile
import time
import urllib.request
from desktop_location import desktop_build as installed_desktop_build

LABEL = 'com.evencodex.desktop-bridge'
DEFAULT_SUPPORT = Path.home() / 'Library/Application Support/EvenCodexBridge'
DEFAULT_SOURCE = Path('/opt/homebrew/lib/node_modules/@evenrealities/even-terminal')
DEFAULT_CONFIG = Path.home() / '.even-terminal/config.json'
APP_INFO = Path('/Applications/ChatGPT.app/Contents/Info.plist')
EXPECTED_BUILD = {'CFBundleShortVersionString': '26.915.31945', 'CFBundleVersion': '9922'}
EXPECTED_NODE_VERSION = 'v26.9.0'
RUNTIME_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'


class BridgeError(RuntimeError):
    pass


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def private_directory(path):
    path = Path(path)
    if path.is_symlink():
        raise BridgeError('A managed directory is a symbolic link; installation stopped.')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.stat().st_uid != os.getuid():
        raise BridgeError('A managed directory has a different owner; installation stopped.')
    path.chmod(0o700)
    return path


def atomic_json(path, data):
    path = Path(path)
    private_directory(path.parent)
    handle, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(handle, 'w') as stream:
            json.dump(data, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    return json.loads(Path(path).read_text())


@contextmanager
def exclusive_lock(path):
    """Kernel-owned lock; a stale PID can never steal or remove this lock."""
    path = Path(path)
    private_directory(path.parent)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    os.fchmod(descriptor, 0o600)
    stream = os.fdopen(descriptor, 'w')
    try:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            message = ('Another bridge management operation is in progress.'
                       if path.name == 'management.lock' else 'Another bridge supervisor is already running.')
            raise BridgeError(message) from error
        stream.write(str(os.getpid()) + '\n')
        stream.flush()
        yield stream
    finally:
        stream.close()


def load_config(path):
    config = read_json(path)
    port = config.get('port', 3456)
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise BridgeError('The existing Even Terminal port is invalid.')
    if not isinstance(config.get('token'), str) or not config['token']:
        raise BridgeError('The existing Even Terminal configuration has no token.')
    return config


class LocalOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # An unexpected local listener must never forward our token elsewhere.
        return None


def api(config, path, timeout=4):
    request = urllib.request.Request('http://127.0.0.1:' + str(config.get('port', 3456)) + path,
        headers={'Authorization': 'Bearer ' + config['token']})
    # This is always a local authenticated probe. Never route its token through
    # an inherited HTTP_PROXY or HTTPS_PROXY environment setting.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), LocalOnlyRedirectHandler())
    with opener.open(request, timeout=timeout) as response:
        return json.loads(response.read(2 * 1024 * 1024))


def idle(config):
    rows = api(config, '/api/metrics')['codex']['subscribedSessions']
    return isinstance(rows, list) and all(row.get('status') == 'idle' and not row.get('submissionPending')
                                        for row in rows)


def pending_prompt_queue(support):
    """Queue content is private; return only whether maintenance must be blocked."""
    path = Path(support) / 'state/prompt-queue.json'
    limit = 2 * 1024 * 1024
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return False  # Legacy installations have no queue file.
    except OSError:
        return True
    try:
        with os.fdopen(descriptor, 'rb') as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
                return True
            source = stream.read(limit + 1)
            if len(source) > limit:
                return True
            record = json.loads(source)
            if (not isinstance(record, dict) or set(record) != {'version', 'entries'} or
                    type(record.get('version')) is not int or record['version'] != 1 or
                    not isinstance(record.get('entries'), list)):
                return True
            return bool(record['entries'])
    except (OSError, ValueError):
        return True


def pending_delivery(support):
    # Check this even when the older delivery journal does not exist. Paused,
    # queued, sending and unknown entries all protect the durable queue.
    if pending_prompt_queue(support):
        return True
    path = Path(support) / 'state/delivery.json'
    if not path.exists():
        return False
    try:
        record = read_json(path)
        if not isinstance(record, dict) or record.get('version') != 1 or any(not isinstance(record.get(key), dict)
                                             for key in ('prompts', 'actions', 'receipts')):
            return True
        return bool(record['prompts'] or record['actions'])
    except (OSError, ValueError):
        return True


def port_available(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def command_output(arguments, timeout=5):
    environment = command_environment()
    if str(arguments[0]) == str(tailscale_executable()):
        environment['TAILSCALE_BE_CLI'] = '1'
    return subprocess.check_output(arguments, stderr=subprocess.DEVNULL, text=True,
                                   timeout=timeout, env=environment).strip()


def tailscale_executable(launchers=None, applications=None):
    """Find an installed CLI without adding a global launcher or changing its VPN."""
    if launchers is None:
        launchers = (Path('/usr/local/bin/tailscale'), Path('/opt/homebrew/bin/tailscale'))
    if applications is None:
        applications = (Path('/Applications'), Path.home() / 'Applications')
    for path in launchers:
        if path.is_file() and os.access(path, os.X_OK):
            return path
    for directory in applications:
        app = directory / 'Tailscale.app'
        try:
            info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
            if info.get('CFBundleIdentifier') not in ('io.tailscale.ipn.macos', 'io.tailscale.ipn.macsys'):
                continue
            executable = app / 'Contents/MacOS/Tailscale'
            if executable.is_file() and os.access(executable, os.X_OK):
                return executable
        except (OSError, plistlib.InvalidFileException, ValueError):
            pass
    return None


def command_environment():
    """No inherited Node, Python, loader, proxy, or shell startup overrides."""
    keep = ('HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE')
    env = {key: os.environ[key] for key in keep if key in os.environ}
    env.update(PATH=RUNTIME_PATH, PYTHONDONTWRITEBYTECODE='1')
    return env


def desktop_build():
    return installed_desktop_build()


def validate_release(support, reference, node_check=True):
    """No fallback to the global npm CLI is permitted after any failed check."""
    name = reference.get('name', '')
    if not name or Path(name).name != name or name.startswith('.'):
        raise BridgeError('The selected bridge release is invalid.')
    root = Path(support) / 'releases' / name
    if root.is_symlink() or not root.is_dir():
        raise BridgeError('The verified bridge release is missing. Reinstall the bridge.')
    manifest_path = root / 'manifest.json'
    if digest(manifest_path) != reference.get('manifestSha256'):
        raise BridgeError('The bridge verification record changed. Reinstall a verified release.')
    manifest = read_json(manifest_path)
    if manifest.get('nodeVersion') != EXPECTED_NODE_VERSION:
        raise BridgeError('This release uses an unreviewed Node.js version. Validate compatibility before installation or restart.')
    files = manifest.get('files', {})
    package = root / 'package'
    actual = {str(path.relative_to(package)) for path in package.rglob('*') if path.is_file() and not path.is_symlink()}
    if not files or actual != set(files):
        raise BridgeError('The frozen bridge files changed. Reinstall a verified release.')
    links = {str(path.relative_to(package)): os.readlink(path) for path in package.rglob('*') if path.is_symlink()}
    if links != manifest.get('links', {}):
        raise BridgeError('The frozen dependency links changed. Reinstall a verified release.')
    for relative in links:
        if not (package / relative).resolve().is_relative_to(package.resolve()):
            raise BridgeError('A frozen dependency points outside its verified release.')
    for relative, expected in files.items():
        path = root / 'package' / relative
        if path.is_symlink() or digest(path) != expected:
            raise BridgeError('The frozen bridge failed its integrity check. Reinstall a verified release.')
    if node_check and command_output([manifest['nodeExecutable'], '--version']) != manifest['nodeVersion']:
        raise BridgeError('Node.js was updated. Validate the new runtime before restarting the bridge.')
    return root, manifest


def child_environment(support):
    # Do not inherit overrides that can change tokens, engines, permissions, or Node startup.
    env = command_environment()
    env.update(PATH=RUNTIME_PATH, EVEN_CODEX_DESKTOP_BRIDGE='1',
               EVEN_CODEX_BRIDGE_STATE_DIR=str(Path(support) / 'state'),
               EVEN_CODEX_BRIDGE_PREFERENCES_PATH=str(Path(support) / 'preferences.json'))
    executable = tailscale_executable()
    if executable:
        # The upstream resolver invokes `tailscale` by name. The managed shim
        # forwards only to this discovered executable, including an app-bundled
        # CLI when no global launcher was installed.
        env['PATH'] = str(Path(support) / 'operations') + ':' + RUNTIME_PATH
        env['G2_TAILSCALE_EXECUTABLE'] = str(executable)
    return env


def status(support, code, detail, action='', **extra):
    data = {'status': code, 'detail': detail, 'action': action,
            'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **extra}
    atomic_json(Path(support) / 'status.json', data)
    return data


def make_plist(support, python):
    support = Path(support).resolve()
    return {'Label': LABEL,
        'ProgramArguments': [str(python), str(support / 'operations/supervisor.py'), '--support', str(support)],
        'WorkingDirectory': str(support), 'RunAtLoad': True, 'KeepAlive': True,
        'ThrottleInterval': 30, 'ExitTimeOut': 15, 'ProcessType': 'Background',
        'LimitLoadToSessionType': 'Aqua', 'Umask': 0o077,
        'EnvironmentVariables': {'PATH': RUNTIME_PATH, 'PYTHONDONTWRITEBYTECODE': '1'},
        'StandardOutPath': '/dev/null', 'StandardErrorPath': '/dev/null'}
