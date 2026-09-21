#!/usr/bin/env python3
"""Install the local Mac controller without changing the running bridge service."""
import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
IDENTIFIER = 'com.daviddemri.g2bridge'


def check_bundle(path):
    if path.is_symlink():
        raise ValueError('The app bundle must not be a symbolic link.')
    info = plistlib.loads((path / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != IDENTIFIER or info.get('CFBundleExecutable') != 'G2Bridge':
        raise ValueError('The selected bundle is not G2 Bridge. No application was replaced.')
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(path)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return info


def install(source, destination, apply=False):
    source, destination = source.absolute(), destination.absolute()
    info = check_bundle(source)
    if source == destination:
        raise ValueError('Build output and installed application must be separate.')
    if destination.exists() or destination.is_symlink():
        check_bundle(destination)
        commands = subprocess.check_output(['/bin/ps', '-axo', 'command='], text=True)
        executable = str(destination / 'Contents/MacOS/G2Bridge')
        if any(line.strip().startswith(executable) for line in commands.splitlines()):
            raise ValueError('Quit the G2 Bridge window app before replacing it. The background bridge can keep running.')
    if not apply:
        return {'action': 'install-app', 'apply': False, 'version': info['CFBundleShortVersionString'],
                'destination': str(destination), 'bridgeServiceChanged': False}
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.g2-bridge-install-', dir=destination.parent))
    staged = staging / 'G2 Bridge.app'
    previous = None
    try:
        shutil.copytree(source, staged, symlinks=True)
        check_bundle(staged)
        if destination.exists():
            backups = Path.home() / 'Library/Application Support/EvenCodexBridge/app-backups'
            backups.mkdir(parents=True, exist_ok=True, mode=0o700)
            previous = backups / ('G2 Bridge-' + time.strftime('%Y%m%d-%H%M%S') + '.app')
            if previous.exists():
                raise ValueError('An app backup with this timestamp already exists; retry shortly.')
            destination.rename(previous)
        try:
            staged.rename(destination)
            check_bundle(destination)
        except BaseException:
            if destination.exists():
                shutil.rmtree(destination)
            if previous is not None:
                previous.rename(destination)
            raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return {'action': 'install-app', 'complete': True, 'version': info['CFBundleShortVersionString'],
            'destination': str(destination), 'previousAppSaved': previous is not None,
            'bridgeServiceChanged': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / '.build/G2 Bridge.app')
    parser.add_argument('--destination', type=Path, default=Path.home() / 'Applications/G2 Bridge.app')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.source, args.destination, args.apply), indent=2))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit('Installation stopped: ' + str(error))
