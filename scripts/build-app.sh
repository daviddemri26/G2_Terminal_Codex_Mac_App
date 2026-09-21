#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/.build/G2 Bridge.app"
ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" && "$ARCH" != "x86_64" ]]; then
  echo "Unsupported architecture: $ARCH" >&2
  exit 1
fi
if [[ ! -f "$ROOT/operations/control.py" ]]; then
  echo "Missing operations/control.py; finish the control backend first." >&2
  exit 1
fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/operations" "$ROOT/.build/swift-module-cache"
xcrun swiftc -swift-version 6 -parse-as-library -O -target "$ARCH-apple-macos14.0" \
  -module-cache-path "$ROOT/.build/swift-module-cache" \
  -framework AppKit -framework SwiftUI \
  "$ROOT"/macos/Sources/*.swift -o "$APP/Contents/MacOS/G2Bridge"
cp "$ROOT/macos/Info.plist" "$APP/Contents/Info.plist"
if [[ -f "$ROOT/macos/Resources/AppIcon.icns" ]]; then
  cp "$ROOT/macos/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
fi
/usr/bin/python3 - "$ROOT" "$APP" <<'PY'
from pathlib import Path
import shutil
import sys
root, app = map(Path, sys.argv[1:])
destination = app / 'Contents/Resources/operations'
for stale in destination.iterdir():
    if stale.is_dir():
        shutil.rmtree(stale)
    else:
        stale.unlink()
for source in sorted((root / 'operations').glob('*.py')):
    if not source.name.startswith('test_'):
        shutil.copy2(source, destination / source.name)
PY
/usr/bin/plutil -lint "$APP/Contents/Info.plist"
/usr/bin/codesign --force --sign - "$APP"
/usr/bin/codesign --verify --strict "$APP"
echo "Built: $APP"
echo "Preview without controlling the installed service: open -n \"$APP\" --args --preview"
