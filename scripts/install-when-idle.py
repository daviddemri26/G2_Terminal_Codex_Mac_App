#!/usr/bin/env python3
"""Apply one reviewed update after the current interaction finishes; never force it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'operations'))
import common
import control
import manage


def candidate_tree_fingerprint(source):
    """Hash every candidate file and link, including the development dependency tree.

    The generated runtime has one deliberate external directory link at its root:
    node_modules. Follow that entry once; record other internal link identities
    without traversing them, since their targets are already covered by the walk.
    Broken, cyclic, escaping, and special-file inputs cannot become a baseline.
    """
    try:
        source = Path(source).resolve(strict=True)
        if not source.is_dir():
            raise ValueError('Not a directory')
        dependencies = source / 'node_modules'
        dependency_root = dependencies.resolve(strict=True)
        if not dependency_root.is_dir():
            raise ValueError('Missing dependencies')
        roots = (source, dependency_root)
        value = hashlib.sha256()
        count, size = 0, 0

        def add(record):
            value.update(json.dumps(record, separators=(',', ':'), ensure_ascii=True).encode())
            value.update(b'\n')

        def walk(path, relative, ancestors=()):
            nonlocal count, size
            count += 1
            if count > 100000:
                raise ValueError('Too many candidate entries')
            metadata = path.lstat()
            mode = stat.S_IMODE(metadata.st_mode)
            identity = (metadata.st_dev, metadata.st_ino)
            if stat.S_ISLNK(metadata.st_mode):
                link = os.readlink(path)
                target = path.resolve(strict=True)
                if relative == 'node_modules':
                    if target != dependency_root:
                        raise ValueError('Dependencies changed during verification')
                    add([relative, 'dependency-link', mode, link, str(target)])
                    walk(target, relative, ancestors)
                    return
                if not any(target.is_relative_to(root) for root in roots):
                    raise ValueError('External candidate link')
                if not target.is_file() and not target.is_dir():
                    raise ValueError('Unsupported link target')
                if target.is_dir() and any(target == parent for parent in path.parents):
                    raise ValueError('Cyclic candidate directory link')
                add([relative, 'link', mode, link, str(target)])
            elif stat.S_ISDIR(metadata.st_mode):
                if identity in ancestors:
                    raise ValueError('Cyclic candidate directory')
                add([relative, 'directory', mode])
                for child in sorted(path.iterdir(), key=lambda item: item.name):
                    walk(child, f'{relative}/{child.name}' if relative else child.name, (*ancestors, identity))
            elif stat.S_ISREG(metadata.st_mode):
                size += metadata.st_size
                if size > 2 * 1024 * 1024 * 1024:
                    raise ValueError('Candidate is too large')
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(descriptor, 'rb') as stream:
                    before = os.fstat(stream.fileno())
                    if (not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino) != identity
                            or (before.st_size, before.st_mtime_ns, before.st_mode)
                            != (metadata.st_size, metadata.st_mtime_ns, metadata.st_mode)):
                        raise ValueError('Candidate file changed during verification')
                    content = hashlib.sha256()
                    read_size = 0
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        read_size += len(chunk)
                        if read_size > before.st_size:
                            raise ValueError('Candidate file grew during verification')
                        content.update(chunk)
                    after = os.fstat(stream.fileno())
                if (before.st_size, before.st_mtime_ns, before.st_mode) != (after.st_size, after.st_mtime_ns, after.st_mode):
                    raise ValueError('Candidate file changed during verification')
                add([relative, 'file', mode, content.hexdigest()])
            else:
                raise ValueError('Unsupported candidate entry')

        walk(source, '')
        return value.hexdigest()
    except (OSError, RuntimeError, ValueError):
        raise common.BridgeError('The complete update candidate could not be verified. Rebuild it before queuing an update.') from None


def wait_and_install(source, support, node, timeout=1200, interval=5,
                     clock=time.monotonic, sleep=time.sleep, run=subprocess.run):
    source, support, node = Path(source).resolve(), Path(support).resolve(), Path(node).resolve()
    original = control.installation(support)
    control.assert_owned_plist(support)
    fingerprint = manage.source_fingerprint(source)
    if manage.source_version(source) != manage.INSTALL_VERSION:
        raise common.BridgeError('Select the reviewed update before waiting.')
    manage.reviewed_node_version(source, node)
    complete_fingerprint = candidate_tree_fingerprint(source)
    record = support / 'pending-update.json'
    deadline = clock() + timeout
    common.atomic_json(record, {'state': 'waiting', 'targetVersion': manage.INSTALL_VERSION,
        'expiresAt': time.time() + timeout + 300,
        'message': 'The reviewed update is waiting for the current interaction to finish.'})
    quiet_checks = 0
    while clock() < deadline:
        if control.installation(support) != original or manage.source_fingerprint(source) != fingerprint:
            raise common.BridgeError('The installation or candidate changed. This queued update was cancelled.')
        snapshot = control.status(support)
        if snapshot['safeToChange'] and snapshot['desktopCompatible']:
            quiet_checks += 1
        else:
            quiet_checks = 0
        if quiet_checks >= 3:
            if (control.installation(support) != original
                    or candidate_tree_fingerprint(source) != complete_fingerprint):
                raise common.BridgeError('The installation or complete candidate changed. This queued update was cancelled.')
            # The manager acquires its lock and repeats all idle, ownership,
            # compatibility, journal and integrity guards immediately before switching.
            result = run([sys.executable, str(ROOT / 'operations/manage.py'), 'install',
                '--source', str(source), '--support', str(support), '--node', str(node), '--apply'],
                capture_output=True, text=True, timeout=300, env=common.command_environment())
            if result.returncode:
                raise common.BridgeError('The guarded update did not complete. Run the installation check; it was not retried.')
            verified = control.diagnostics(support)
            if verified.get('bridgeVersion') != manage.INSTALL_VERSION or not verified.get('diagnostics', {}).get('runtimeVerified'):
                raise common.BridgeError('The update needs verification. Run the installation check.')
            common.atomic_json(record, {'state': 'complete', 'targetVersion': manage.INSTALL_VERSION,
                'message': 'The reviewed update completed and passed its installation check.'})
            return {'complete': True, 'bridgeVersion': manage.INSTALL_VERSION}
        sleep(interval)
    raise common.BridgeError('The service stayed busy. The queued update expired without forcing a restart.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / '.build/runtime')
    parser.add_argument('--support', type=Path, default=common.DEFAULT_SUPPORT)
    parser.add_argument('--node', type=Path, default=Path('/opt/homebrew/bin/node'))
    parser.add_argument('--timeout', type=int, default=1200)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    if not args.apply:
        print(json.dumps({'apply': False, 'notice': 'Wait for an idle bridge, then apply one reviewed update. No changes made.'}))
        return 0
    try:
        if not 30 <= args.timeout <= 3600:
            raise common.BridgeError('The wait must be between 30 and 3600 seconds.')
        # Do not create a lock directory or status record for an unowned install.
        control.installation(args.support)
        # One worker per installation; separate from the short lifecycle lock.
        with common.exclusive_lock(args.support / 'run/queued-update.lock'):
            try:
                result = wait_and_install(args.source, args.support, args.node, args.timeout)
            except Exception as error:
                message = str(error) if isinstance(error, common.BridgeError) else 'The queued update stopped. Run the installation check.'
                # Only this lock's owner may replace the record, before releasing
                # the lock. A duplicate worker cannot overwrite an active update.
                common.atomic_json(args.support / 'pending-update.json', {'state': 'stopped',
                    'targetVersion': manage.INSTALL_VERSION, 'message': message})
                raise
            print(json.dumps(result))
        return 0
    except Exception as error:
        message = str(error) if isinstance(error, common.BridgeError) else 'The queued update stopped. Run the installation check.'
        print(json.dumps({'complete': False, 'error': message}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
