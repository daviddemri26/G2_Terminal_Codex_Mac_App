"""Read-only task catalog and desktop build guard for the G2 prototype."""
import json
from pathlib import Path
import plistlib
import sqlite3
import sys

mode = sys.argv[1]
if mode == 'version':
    # Source runs share the operations helper; builds include its generated copy.
    if not (Path(__file__).parent / 'desktop_location.py').exists():
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'operations'))
    from desktop_location import desktop_build
    print(json.dumps(desktop_build()))
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
