"""Read-only task catalog and desktop build guard for the G2 prototype."""
import json
from pathlib import Path
import plistlib
import sqlite3
import sys

mode = sys.argv[1]
if mode == 'version':
    info = plistlib.loads(Path('/Applications/ChatGPT.app/Contents/Info.plist').read_bytes())
    print(json.dumps({k: info.get(k) for k in ['CFBundleShortVersionString', 'CFBundleVersion']}))
elif mode == 'list':
    codex_dir = Path(sys.argv[2])
    candidates = sorted(codex_dir.glob('state_*.sqlite'), key=lambda p: int(p.stem.split('_')[-1]))
    if not candidates:
        raise SystemExit('Codex task index unavailable')
    con = sqlite3.connect(candidates[-1].as_uri() + '?mode=ro', uri=True, timeout=2)
    con.execute('PRAGMA query_only=ON')
    con.row_factory = sqlite3.Row
    rows = con.execute('''SELECT id, COALESCE(NULLIF(name,''), title) AS title,
        cwd, updated_at FROM threads
        WHERE archived=0 AND agent_path IS NULL
        AND originator='Codex Desktop' AND thread_source='user'
        ORDER BY COALESCE(recency_at,updated_at) DESC LIMIT 100''').fetchall()
    print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
    con.close()
else:
    raise SystemExit('Unsupported catalog operation')
