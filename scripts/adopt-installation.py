#!/usr/bin/env python3
"""Attach an equivalent installed release to this repository without restarting it."""
import argparse
import json
from pathlib import Path
import shutil
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'operations'))
from common import (BridgeError, DEFAULT_SUPPORT, atomic_json, digest, exclusive_lock,
                    private_directory, read_json, validate_release)
import control as controller
import manage


def verify_equivalent(source, manifest):
    source = Path(source)
    verified = 0
    skipped = []
    for relative, expected in manifest['files'].items():
        # The old runtime bundled the project's tests. The new runtime deliberately omits them.
        if relative.startswith('dist/desktop-bridge/') and '.test.' in Path(relative).name:
            skipped.append(relative)
            continue
        path = source / relative
        if not path.is_file() or digest(path) != expected:
            raise BridgeError('The rebuilt runtime differs from the installed release: ' + relative +
                              '. Use a reviewed installation instead of adopting it.')
        verified += 1
    for relative, target in manifest.get('links', {}).items():
        path = source / relative
        if not path.is_symlink() or str(path.readlink()) != target:
            raise BridgeError('The rebuilt dependency links differ: ' + relative)
    upstream = read_json(ROOT / 'integration/upstream.json')['upstreamFiles']
    extras = {'bridge-build.json', 'node_modules/.package-lock.json'}
    npm_entrypoint = source / 'node_modules/.bin/even-terminal'
    if npm_entrypoint.is_symlink() and str(npm_entrypoint.readlink()) == '../@evenrealities/even-terminal/bin/cli.js':
        extras.add('node_modules/.bin/even-terminal')
    extras.update(name for name in upstream if name.startswith('src/') or name in ('README.md', 'LICENSE', 'LICENSE.md'))
    extras.update('node_modules/@evenrealities/even-terminal/' + name for name in upstream)
    expected_paths = set(manifest['files']) | set(manifest.get('links', {})) | extras
    actual_paths = {str(path.relative_to(source)) for path in source.iterdir() if path.is_file()}
    for name in ('bin', 'dist', 'src', 'node_modules'):
        actual_paths.update(str(path.relative_to(source)) for path in (source / name).rglob('*')
                            if path.is_file() or path.is_symlink())
    unexpected = actual_paths - expected_paths
    if unexpected:
        raise BridgeError('Unexpected files in the rebuilt runtime: ' + ', '.join(sorted(unexpected)[:3]))
    return verified, skipped


def adopt(support, source, apply=False):
    support, source = Path(support).resolve(), Path(source).resolve()
    old = controller.installation(support)
    controller.assert_owned_plist(support)
    _, manifest = validate_release(support, old['activeRelease'])
    count, skipped = verify_equivalent(source, manifest)
    build = read_json(source / 'bridge-build.json')
    if 'G2 Desktop Bridge ' + build['bridgeVersion'] != manifest['bridgeVersion']:
        raise BridgeError('Build metadata does not match the installed bridge version.')
    result = {'action': 'adopt-installation', 'apply': apply, 'version': manifest['bridgeVersion'],
              'verifiedRuntimeFiles': count, 'omittedProjectTests': skipped,
              'sourceDigest': build['sourceDigest'], 'runtimeRestarted': False}
    if not apply:
        return result
    with exclusive_lock(support / 'run/management.lock'):
        current = controller.installation(support)
        if current != old:
            raise BridgeError('The installation changed during verification. Retry with the current release.')
        config_hash = digest(old['configPath'])
        plist_hash = digest(manage.plist_path())
        backups = private_directory(support / 'maintenance-backups')
        backup = private_directory(backups / (time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8]))
        shutil.copy2(support / 'control.json', backup / 'control.json')
        original_names = []
        for name in manage.OPERATIONS:
            path = support / 'operations' / name
            if path.exists():
                shutil.copy2(path, backup / name)
                original_names.append(name)
        new_control = dict(old, sourcePackage=str(source), sourceFingerprint=manage.source_fingerprint(source),
                           sourceProvenance={'kind': 'verified-existing-runtime',
                                             'sourceDigest': build['sourceDigest'],
                                             'verifiedFiles': count, 'adoptedAt': controller.checked_at()})
        try:
            manage.install_operations(support)
            if read_json(support / 'control.json') != old:
                raise BridgeError('The installation changed before adoption. No runtime switch was attempted.')
            atomic_json(support / 'control.json', new_control)
            if digest(old['configPath']) != config_hash or digest(manage.plist_path()) != plist_hash:
                raise BridgeError('The pairing or launch registration changed externally during adoption.')
            result.update(complete=True, configurationPreserved=True, launchAgentPreserved=True,
                          activeReleasePreserved=True, previousReleasePreserved=True)
            atomic_json(backup / 'adoption.json', result)
        except BaseException:
            for name in manage.OPERATIONS:
                target = support / 'operations' / name
                if name in original_names:
                    temporary = target.with_name('.' + name + '.restore')
                    shutil.copy2(backup / name, temporary)
                    temporary.replace(target)
                elif target.exists():
                    target.unlink()
            if read_json(support / 'control.json') == new_control:
                atomic_json(support / 'control.json', old)
            raise
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--support', type=Path, default=DEFAULT_SUPPORT)
    parser.add_argument('--source', type=Path, default=ROOT / '.build/runtime')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(adopt(args.support, args.source, args.apply), indent=2))
    except (OSError, KeyError, ValueError, BridgeError) as error:
        raise SystemExit('Adoption stopped: ' + str(error))
