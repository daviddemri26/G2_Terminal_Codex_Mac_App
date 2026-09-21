#!/usr/bin/env python3
"""Build a reviewed bridge from pinned npm input, without touching the installed service."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate_upstream(source, specification):
    package = json.loads((source / 'package.json').read_text())
    if package.get('name') != specification['name'] or package.get('version') != specification['version']:
        raise ValueError('Unexpected Even Terminal package. Run npm ci --ignore-scripts from the repository.')
    for relative, expected in specification['upstreamFiles'].items():
        if sha256(source / relative) != expected:
            raise ValueError('The npm input was modified: ' + relative + '. Restore it with npm ci --ignore-scripts.')
    expected_paths = set(specification['upstreamFiles'])
    for name in ('bin', 'dist', 'src'):
        actual = {str(path.relative_to(source)) for path in (source / name).rglob('*') if path.is_file()}
        if actual - expected_paths:
            raise ValueError('Unexpected files in upstream ' + name + '. Restore it with npm ci --ignore-scripts.')
    for relative, expected in specification['files'].items():
        if sha256(source / relative) != expected['upstreamSha256']:
            raise ValueError('The npm input was modified: ' + relative + '. Restore it with npm ci --ignore-scripts.')


def build(root=ROOT):
    root = Path(root).resolve()
    dependency = root / 'node_modules/@evenrealities/even-terminal'
    specification = json.loads((root / 'integration/upstream.json').read_text())
    compatibility = json.loads((root / 'compatibility.json').read_text())
    validate_upstream(dependency, specification)
    lock = json.loads((root / 'package-lock.json').read_text())
    locked = lock['packages']['node_modules/@evenrealities/even-terminal']
    if locked['integrity'] != specification['integrity'] or locked['version'] != specification['version']:
        raise ValueError('The dependency lock does not match the reviewed upstream archive.')
    provider = (root / 'bridge/provider.mjs').read_text()
    versions = re.findall(r"version:\s*['\"]G2 Desktop Bridge ([^'\"]+)['\"]", provider)
    if versions != [compatibility['bridgeVersion']]:
        raise ValueError('The bridge version and compatibility.json disagree.')
    build_dir = root / '.build'
    if build_dir.is_symlink():
        raise ValueError('.build must be a local directory, not a symbolic link.')
    build_dir.mkdir(exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='runtime-staging-', dir=build_dir))
    try:
        for name in ('dist', 'bin', 'src'):
            if (dependency / name).exists():
                shutil.copytree(dependency / name, temporary / name)
        for name in ('package.json', 'README.md', 'LICENSE', 'LICENSE.md'):
            if (dependency / name).is_file():
                shutil.copy2(dependency / name, temporary / name)
        subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i',
                        str(root / 'integration/even-terminal-0.10.4.patch')],
                       cwd=temporary, check=True, capture_output=True, text=True)
        for relative, expected in specification['files'].items():
            if sha256(temporary / relative) != expected['patchedSha256']:
                raise ValueError('The patched upstream output differs from the imported release: ' + relative)
        destination = temporary / 'dist/desktop-bridge'
        destination.mkdir(exist_ok=True)
        sources = sorted(p for p in (root / 'bridge').iterdir()
                         if p.suffix in ('.mjs', '.py') and '.test.' not in p.name)
        for source in sources:
            shutil.copy2(source, destination / source.name)
        # Upstream's postinstall only fixes these prebuilt executables. No package install scripts run.
        for helper in (root / 'node_modules/node-pty/prebuilds').glob('*/spawn-helper'):
            helper.chmod(helper.stat().st_mode | 0o111)
        (temporary / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
        inputs = sources + [root / path for path in (
            'package-lock.json', 'compatibility.json', 'integration/upstream.json',
            'integration/even-terminal-0.10.4.patch', 'scripts/build-runtime.py')]
        hashes = {str(path.relative_to(root)): sha256(path) for path in sorted(inputs)}
        fingerprint = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
        metadata = {'format': 1, 'bridgeVersion': compatibility['bridgeVersion'],
                    'nodeVersion': compatibility['nodeVersion'],
                    'compatibility': compatibility,
                    'sourceDigest': fingerprint, 'inputs': hashes,
                    'upstreamIntegrity': specification['integrity']}
        (temporary / 'bridge-build.json').write_text(json.dumps(metadata, indent=2) + '\n')
        output = build_dir / 'runtime'
        if output.is_symlink():
            raise ValueError('The runtime output must not be a symbolic link.')
        if output.exists():
            shutil.rmtree(output)
        temporary.rename(output)
        return output, metadata
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == '__main__':
    try:
        path, metadata = build()
        print(json.dumps({'built': str(path), 'bridgeVersion': metadata['bridgeVersion'],
                          'sourceDigest': metadata['sourceDigest'], 'installedServiceChanged': False}, indent=2))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        raise SystemExit('Build stopped: ' + str(error))
