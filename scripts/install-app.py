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
APP_NAME = 'Even Terminal for Codex Mac App'
APP_BUNDLE = APP_NAME + '.app'
LEGACY_BUNDLE = 'G2 Bridge.app'


def check_bundle(path):
    if path.is_symlink():
        raise ValueError('The app bundle must not be a symbolic link.')
    info = plistlib.loads((path / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != IDENTIFIER or info.get('CFBundleExecutable') != 'G2Bridge':
        raise ValueError('The selected bundle is not ' + APP_NAME + '. No application was replaced.')
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(path)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return info


def existing_application(destination):
    """Only migrate the known old name beside the requested destination."""
    candidates = [destination]
    if destination.name == APP_BUNDLE:
        candidates.append(destination.with_name(LEGACY_BUNDLE))
    present = [path for path in candidates if path.exists() or path.is_symlink()]
    if len(present) > 1:
        raise ValueError('Both the current and former application names exist. '
                         'Resolve the duplicate apps before installing; neither was changed.')
    existing = present[0] if present else None
    if existing is not None:
        check_bundle(existing)
    commands = subprocess.check_output(['/bin/ps', '-axo', 'command='], text=True)
    for path in candidates:
        executable = str(path / 'Contents/MacOS/G2Bridge')
        if any(line.strip() == executable or line.strip().startswith(executable + ' ')
               for line in commands.splitlines()):
            raise ValueError('Quit the ' + APP_NAME + ' window app (formerly G2 Bridge) '
                             'before replacing it. The background bridge can keep running.')
    return existing


def install(source, destination, apply=False):
    source, destination = source.expanduser().absolute(), destination.expanduser().absolute()
    info = check_bundle(source)
    existing = existing_application(destination)
    if source == destination or source == existing:
        raise ValueError('Build output and installed application must be separate.')
    if not apply:
        return {'action': 'install-app', 'apply': False, 'version': info['CFBundleShortVersionString'],
                'destination': str(destination),
                'replaces': str(existing) if existing is not None else None,
                'bridgeServiceChanged': False}
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.g2-bridge-install-', dir=destination.parent))
    staged = staging / APP_BUNDLE
    previous = None
    try:
        shutil.copytree(source, staged, symlinks=True)
        check_bundle(staged)
        # Copying and signature checks take time. Refuse a newly started app or
        # changed layout before moving any installed bundle.
        if existing_application(destination) != existing:
            raise ValueError('The installed application changed during preparation. Retry the installer.')
        if existing is not None:
            backups = Path.home() / 'Library/Application Support/EvenCodexBridge/app-backups'
            backups.mkdir(parents=True, exist_ok=True, mode=0o700)
            previous = backups / (existing.stem + '-' + time.strftime('%Y%m%d-%H%M%S') + '.app')
            if previous.exists() or previous.is_symlink():
                raise ValueError('An app backup with this timestamp already exists; retry shortly.')
            existing.rename(previous)
        installed = False
        try:
            staged.rename(destination)
            installed = True
            check_bundle(destination)
        except BaseException:
            if installed:
                shutil.rmtree(destination)
            if previous is not None:
                # A failed rename migration must restore the original name,
                # preserving existing shortcuts as well as the previous app.
                previous.rename(existing)
            raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return {'action': 'install-app', 'complete': True, 'version': info['CFBundleShortVersionString'],
            'destination': str(destination), 'previousAppSaved': previous is not None,
            'renamedFrom': str(existing) if existing is not None and existing != destination else None,
            'bridgeServiceChanged': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / '.build' / APP_BUNDLE)
    parser.add_argument('--destination', type=Path, default=Path('/Applications') / APP_BUNDLE,
                        help='Default: /Applications/' + APP_BUNDLE + '. Use ~/Applications/' + APP_BUNDLE + ' explicitly for a per-user installation.')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.source, args.destination, args.apply), indent=2))
    except PermissionError:
        raise SystemExit('Installation stopped: Applications is not writable for this account. '
                         'Install using Finder with administrator approval, or explicitly choose '
                         '--destination "$HOME/Applications/' + APP_BUNDLE + '" for this user only. '
                         'The background bridge was not changed.')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit('Installation stopped: ' + str(error))
