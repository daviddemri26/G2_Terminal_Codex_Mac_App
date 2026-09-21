"""End-to-end loopback test of the phone HTTP/SSE contract against desktop IPC."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / ".build/manual-test"
BASE.mkdir(parents=True, exist_ok=True)
if os.environ.get('G2_BRIDGE_ALLOW_LIVE_TEST') != 'YES':
    raise SystemExit('This test sends a real message. Set G2_BRIDGE_ALLOW_LIVE_TEST=YES only after explicit authorization.')
TARGET = os.environ['G2_BRIDGE_TEST_TASK_ID']
EXPECTED = 'G2 V2 DESKTOP OK'
config = json.loads((Path.home() / '.even-terminal/config.json').read_text())
headers = {'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'}
origin = 'http://127.0.0.1:3457'

def api(path, body=None):
    req = urllib.request.Request(origin + path, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as response:
        return response.code, json.loads(response.read())

log = BASE / 'loopback-console.log'
log.touch(mode=0o600, exist_ok=True)
log.chmod(0o600)
server_log = BASE / 'loopback-server.log'
server_log.touch(mode=0o600, exist_ok=True)
server_log.chmod(0o600)
env = dict(os.environ, EVEN_CODEX_DESKTOP_BRIDGE='1', EVEN_CODEX_BRIDGE_STATE_DIR=str(BASE/'test-state'))
process = None
events = None
try:
    with log.open('ab') as output:
        process = subprocess.Popen(['/opt/homebrew/bin/node', str(ROOT/'.build/runtime/bin/cli.js'), '--port', '3457', '--interface', 'lo0', '--log-level', 'info', '--log-file', str(BASE/'loopback-server.log')], cwd=BASE, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
    for _ in range(30):
        if process.poll() is not None:
            raise RuntimeError('Prototype server failed; inspect private local log')
        try:
            status, info = api('/api/info?provider=codex')
            if status == 200:
                break
        except Exception:
            time.sleep(0.2)
    else:
        raise TimeoutError('Prototype server startup')
    print('INFO', info, flush=True)
    status, listed = api('/api/sessions?provider=codex&limit=20')
    assert status == 200 and any(t['id'] == TARGET for t in listed['sessions']), listed
    print('EXISTING_DESKTOP_TASK_LISTED', True, flush=True)
    status, history = api('/api/sessions/'+TARGET+'/history?provider=codex&limit=10')
    assert status == 200 and any('G2 DESKTOP CONTINUITE OK' == m.get('text') for m in history['history']), history
    print('DESKTOP_HISTORY_RECEIVED', True, flush=True)
    status, blocked = api('/api/codex/ensure-app-server', {})
    assert status == 409
    print('SEPARATE_ENGINE_DISABLED', True, flush=True)
    request = urllib.request.Request(origin+'/api/events?provider=codex&sessionId='+TARGET, headers=headers)
    events = urllib.request.urlopen(request, timeout=40)
    status, sent = api('/api/prompt', {'provider':'codex','sessionId':TARGET,'text':'Test de la passerelle G2 vers l’application Mac : réponds exactement G2 V2 DESKTOP OK, sans outil et sans modification.'})
    print('PROMPT_ACCEPTED', status, sent, flush=True)
    assert status == 202, sent
    kinds = []
    got_result = False
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        line = events.readline().decode().strip()
        if not line.startswith('data: '):
            continue
        item = json.loads(line[6:])
        kinds.append(item['type'])
        if item['type'] == 'error':
            print('ERROR', item.get('message'), flush=True)
        if item['type'] == 'result' and item.get('text') == EXPECTED:
            got_result = True
            print('SSE_FINAL', {k:item.get(k) for k in ['type','text','success','durationMs','sessionId']}, flush=True)
        if got_result and item['type'] == 'status' and item.get('state') == 'idle':
            break
    assert got_result, kinds
    status, state = api('/api/status?provider=codex&sessionId='+TARGET)
    assert status == 200 and state['state'] == 'idle', state
    print('SSE_EVENT_TYPES', kinds, flush=True)
    print('FINAL_STATUS', state, flush=True)
    (BASE/'http-test-result.json').write_text(json.dumps({'passed':True,'taskId':TARGET,'reply':EXPECTED,'eventTypes':kinds,'state':state},indent=2))
finally:
    if events: events.close()
    if process:
        process.terminate()
        process.wait(timeout=10)
