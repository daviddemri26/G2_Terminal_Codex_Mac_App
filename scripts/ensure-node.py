#!/usr/bin/env python3
"""Select reviewed Node, or download its pinned official archive for this user."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'operations'))
from common import BridgeError, DEFAULT_SUPPORT, command_environment, exclusive_lock, private_directory


def version_matches(node, expected):
    try:
        return subprocess.check_output([str(node), '--version'], text=True,
            stderr=subprocess.DEVNULL, timeout=8, env=command_environment()).strip() == expected
    except (OSError, subprocess.SubprocessError):
        return False


def archive_members(archive, destination, top):
    """Reject escaping links and unexpected files, even before extraction."""
    for member in archive.getmembers():
        path = Path(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != top:
            raise BridgeError('The Node archive contains an unexpected path.')
        target = destination / path
        if member.issym() or member.islnk():
            link = Path(member.linkname)
            resolved = ((target.parent if member.issym() else destination) / link).resolve()
            if link.is_absolute() or not resolved.is_relative_to((destination / top).resolve()):
                raise BridgeError('The Node archive contains an escaping link.')
        elif not member.isfile() and not member.isdir():
            raise BridgeError('The Node archive contains an unsupported file type.')
        yield member


def ensure_node(apply=False, support=DEFAULT_SUPPORT, machine=None):
    spec = json.loads((ROOT / 'integration/node-runtime.json').read_text())
    version = spec['version']
    compatible = json.loads((ROOT / 'compatibility.json').read_text())['nodeVersion']
    if version != compatible:
        raise BridgeError('Node download metadata does not match the reviewed compatibility version.')
    machine = machine or platform.machine()
    if platform.system() != 'Darwin' or machine not in spec['archives']:
        raise BridgeError('This installer supports Apple silicon and Intel Macs only.')
    current = shutil.which('node')
    if current and version_matches(current, version):
        return {'ok': True, 'node': str(Path(current).absolute()), 'downloaded': False, 'ready': True}
    entry = spec['archives'][machine]
    tools = Path(support) / 'tools'
    top = entry['name'].removesuffix('.tar.gz')
    installed = tools / top
    node = installed / 'bin/node'
    if node.is_file() and not installed.is_symlink() and version_matches(node, version):
        return {'ok': True, 'node': str(node), 'downloaded': False, 'ready': True}
    if installed.exists() or installed.is_symlink():
        raise BridgeError('The private Node installation needs inspection. It was not overwritten.')
    if not apply:
        return {'ok': True, 'ready': False, 'node': str(node), 'downloaded': False,
                'source': 'https://nodejs.org/dist/' + version + '/' + entry['name']}
    private_directory(Path(support))
    private_directory(tools)
    with exclusive_lock(tools / 'download.lock'):
        if installed.exists() or installed.is_symlink():
            raise BridgeError('The private Node destination changed. Run the installer again.')
        with tempfile.TemporaryDirectory(prefix='.node-download-', dir=tools) as staging:
            staging = Path(staging)
            archive_path = staging / entry['name']
            url = 'https://nodejs.org/dist/' + version + '/' + entry['name']
            print('Downloading the reviewed Node.js runtime from nodejs.org…', file=sys.stderr)
            request = urllib.request.Request(url, headers={'User-Agent': 'G2-Bridge-Installer'})
            with urllib.request.urlopen(request, timeout=60) as response, archive_path.open('wb') as output:
                if response.url != url:
                    raise BridgeError('The official Node download unexpectedly redirected.')
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 200 * 1024 * 1024:
                        raise BridgeError('The Node download is larger than expected.')
                    output.write(chunk)
            if hashlib.sha256(archive_path.read_bytes()).hexdigest() != entry['sha256']:
                raise BridgeError('The Node download did not match its reviewed checksum. It was not installed.')
            with tarfile.open(archive_path, 'r:gz') as archive:
                members = list(archive_members(archive, staging, top))
                archive.extractall(staging, members=members)
            if not version_matches(staging / top / 'bin/node', version):
                raise BridgeError('The downloaded Node runtime could not run the reviewed version.')
            (staging / top).rename(installed)
    return {'ok': True, 'node': str(node), 'downloaded': True, 'ready': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--path-only', action='store_true')
    args = parser.parse_args()
    try:
        result = ensure_node(args.apply)
        if args.path_only and not result['ready']:
            raise BridgeError('The reviewed Node runtime is not installed. Add --apply to download it.')
        print(result['node'] if args.path_only else json.dumps(result, indent=2))
    except (BridgeError, OSError, ValueError, tarfile.TarError) as error:
        raise SystemExit('Node setup stopped: ' + str(error))
