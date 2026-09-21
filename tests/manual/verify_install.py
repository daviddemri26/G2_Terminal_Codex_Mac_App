"""Verify the installed service; optional idle-only restart of its owned HTTP child."""
import argparse
import json
import os
import re
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BASE / 'operations'))
from common import DEFAULT_SUPPORT, api, digest, idle, load_config, pending_delivery, read_json
from manage import health

EXPECTED_BRIDGE_VERSION = 'G2 Desktop Bridge 0.2.7'

parser = argparse.ArgumentParser()
parser.add_argument('--restart-idle-child', action='store_true')
args = parser.parse_args()
support = DEFAULT_SUPPORT
control = read_json(support / 'control.json')
config = load_config(control['configPath'])
config_hash = digest(control['configPath'])
target = os.environ['G2_BRIDGE_TEST_TASK_ID']
result = {'healthBefore': health(support)}
assert all(result['healthBefore'].get(key) is True for key in
           ['installed', 'launchAgentLoaded', 'runtimeVerified', 'desktopCompatible', 'httpAvailable'])
assert api(config, '/api/info?provider=codex')['version'] == EXPECTED_BRIDGE_VERSION
history = api(config, '/api/sessions/' + target + '/history?provider=codex&limit=20', timeout=20)
assert any(re.sub(r'^(?:\[\d+m\d{2}\](?:-{10})?|-{10,12}|-{6} [0-9:]+ -{6})\n\n', '', message.get('text', '')) == 'G2 V2 QUESTION OK' for message in history['history'])
result['existingDesktopFinalReceived'] = True
assert not api(config, '/api/desktop-bridge/actions?sessionId=' + target, timeout=20)['actions']
result['testTaskHasNoPendingActions'] = True
if args.restart_idle_child:
    assert idle(config) and not pending_delivery(support), 'An active or uncertain interaction prevents this restart test.'
    status = read_json(support / 'status.json')
    pid, parent = status['bridgePid'], status['supervisorPid']
    actual_parent = subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'ppid='], text=True).strip()
    command = subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'command='], text=True)
    expected = str(support / 'releases' / control['activeRelease']['name'] / 'package/bin/cli.js')
    assert actual_parent == str(parent) and expected in command, 'Owned bridge process identity changed.'
    assert idle(config) and not pending_delivery(support)
    os.kill(pid, signal.SIGTERM)
    started = time.monotonic()
    while time.monotonic() - started < 40:
        current = read_json(support / 'status.json')
        if current.get('bridgePid') not in (None, pid):
            try:
                if api(config, '/api/info?provider=codex')['version'] == EXPECTED_BRIDGE_VERSION:
                    result['supervisorRestart'] = {'passed': True, 'seconds': round(time.monotonic() - started, 2)}
                    break
            except Exception:
                pass
        time.sleep(.5)
    else:
        raise AssertionError('Supervisor did not restore the owned HTTP child within 40 seconds.')
result['healthAfter'] = health(support)
result['configurationUnchanged'] = digest(control['configPath']) == config_hash
transition = read_json(support / 'transition.json')
result['migrationPreservedConfiguration'] = transition.get('configurationUnchanged') is True
with socket.socket() as probe:
    probe.settimeout(.5)
    result['separateEnginePortClosed'] = probe.connect_ex(('127.0.0.1', 8765)) != 0
assert result['configurationUnchanged'] and result['migrationPreservedConfiguration'] and result['separateEnginePortClosed']
(BASE / '.build/installed-verification.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
