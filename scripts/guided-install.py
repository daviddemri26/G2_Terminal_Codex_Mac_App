#!/usr/bin/env python3
"""Source-based guided alpha installer; no global npm or separate Codex engine."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'operations'))
import common
import setup

GUIDE = 'https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/'


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(arguments, environment):
    subprocess.run(arguments, cwd=ROOT, env=environment, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=Path('/Applications/Even Terminal for Codex Mac App.app'))
    parser.add_argument('--check', action='store_true', help='Show prerequisites only; do not install or download.')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or int(platform.mac_ver()[0].split('.')[0] or '0') < 14:
        raise common.BridgeError('Even Terminal for Codex Mac App requires macOS 14 or newer.')
    if not sys.stdin.isatty() and not args.check:
        raise common.BridgeError('Open Install Even Terminal for Codex Mac App.command to use the guided installer interactively.')
    # Preserve an already managed installation before any download, dependency
    # restoration, config generation, or installer mutation.
    if (common.DEFAULT_SUPPORT / 'control.json').exists():
        raise common.BridgeError('Even Terminal for Codex Mac App is already installed. This first-run installer did not change it. Open Even Terminal for Codex Mac App or follow the update guide: ' + GUIDE)
    node_tool = load_script('ensure-node')
    candidate = node_tool.ensure_node()
    check = setup.inspect(node=candidate['node'] if candidate['ready'] else None)
    print('For Even Terminal users who work in the Codex Mac app. No Codex CLI is needed.\n')
    for item in check['requirements']:
        print(('✓ ' if item['ready'] else '• ') + item['title'] + ': ' + item['message'])
    # LAN/interface discovery needs Node; allow a missing network check to be
    # completed after the pinned Node prerequisite download, never change mode.
    blockers = [item for item in check['requirements'] if not item['ready']
                and not (item['id'] == 'network' and check['network'] in ('lan', 'interface') and not candidate['ready'])]
    try:
        output = subprocess.check_output(['/usr/bin/xcrun', 'swiftc', '--version'],
                       text=True, stderr=subprocess.DEVNULL, timeout=10)
        version = re.search(r'Swift version (\d+)', output)
        if not version or int(version[1]) < 6:
            raise common.BridgeError('This source release needs Swift 6 or newer. Update Apple Command Line Tools before installation.')
    except (OSError, subprocess.SubprocessError):
        blockers.append({'title': 'Apple Swift compiler'})
    if blockers:
        raise common.BridgeError('Complete these prerequisites and open the installer again: ' + ', '.join(item['title'] for item in blockers) + '. Guide: ' + GUIDE)
    if args.check:
        print('\nPrerequisite check finished. No files, downloads, or service settings changed.')
        return 0
    destination = args.destination.expanduser().absolute()
    if not destination.parent.is_dir() or not os.access(destination.parent, os.W_OK):
        if destination != Path('/Applications/Even Terminal for Codex Mac App.app'):
            raise common.BridgeError('The selected application folder is unavailable or not writable.')
        print('\nThis account cannot write to the shared Applications folder.')
        answer = input('Install only for your Mac account in ~/Applications instead? [y/N] ').strip().lower()
        if answer not in ('y', 'yes'):
            raise common.BridgeError('Installation cancelled. No service was installed.')
        destination = Path.home() / 'Applications/Even Terminal for Codex Mac App.app'
    print('\nThis will:')
    if not candidate['ready']:
        print('  • Download Node ' + common.EXPECTED_NODE_VERSION + ' from nodejs.org and verify its pinned checksum.')
    print('  • Download locked npm dependencies and build/test this source locally.')
    print('  • Install Even Terminal for Codex Mac App at ' + str(destination) + '.')
    print('  • Register a service for your login; preserve any existing pairing/network settings.')
    print('  • Keep your Codex Mac app as the only task engine. No test prompts are sent.')
    print('\nThis alpha builds locally and is not an Apple-notarized public download.')
    answer = input('Continue? [y/N] ').strip().lower()
    if answer not in ('y', 'yes'):
        print('Cancelled. No files or service settings changed.')
        return 0
    project = None
    if not check['configExists']:
        value = input('Project folder for new tasks [Return: ' + str(setup.DEFAULT_PROJECT) + ']: ').strip()
        project = str(Path(value).expanduser().absolute()) if value else str(setup.DEFAULT_PROJECT)
    selection = node_tool.ensure_node(apply=True)
    node = Path(selection['node'])
    npm = node.parent / 'npm'
    if not npm.exists():
        raise common.BridgeError('The selected Node installation has no npm command. Install the reviewed Node distribution before continuing.')
    environment = common.command_environment()
    environment['PATH'] = str(node.parent) + ':' + common.RUNTIME_PATH
    print('\nDownloading dependencies and running offline checks. This can take a few minutes.\n', flush=True)
    run([str(npm), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], environment)
    run([str(npm), 'run', 'check'], environment)
    run(['/bin/bash', str(ROOT / 'scripts/build-app.sh')], environment)
    run(['/bin/bash', str(ROOT / 'macos/tests/run.sh')], environment)
    # Validate and install the window app before starting a service. If setup
    # later fails, the window remains available to explain its current status.
    app_installer = load_script('install-app')
    app_installer.install(ROOT / '.build/Even Terminal for Codex Mac App.app', destination, apply=True)
    print('\nInstalling the verified background service…', flush=True)
    result = setup.create(ROOT / '.build/runtime', node, {'projectDirectory': project} if project else {})
    print(result['message'])
    subprocess.run(['/usr/bin/open', str(destination)], check=True)
    print('\nIn Even Terminal for Codex Mac App, open Connect → Show pairing code. Scan it from Even Terminal in the Even app.')
    print('Keep pairing codes private. Closing Even Terminal for Codex Mac App leaves the background connection running.')
    print('Guide: ' + GUIDE)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (common.BridgeError, OSError, subprocess.SubprocessError, ValueError) as error:
        message = str(error) if isinstance(error, common.BridgeError) else 'A prerequisite, download, or build step failed. Existing pairing and service data were preserved.'
        raise SystemExit('\nSetup stopped: ' + message)
