#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$ROOT/.build/swift-module-cache"
xcrun swiftc -swift-version 6 -parse-as-library -module-cache-path "$ROOT/.build/swift-module-cache" \
  "$ROOT/macos/Sources/BridgeControl.swift" "$ROOT/macos/tests/ControlTests.swift" \
  -o "$ROOT/.build/mac-control-tests"
"$ROOT/.build/mac-control-tests"
