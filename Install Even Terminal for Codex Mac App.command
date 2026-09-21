#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME DYLD_INSERT_LIBRARIES
echo "Even Terminal for Codex Mac App — guided setup"
echo
if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
  echo "One-time prerequisite: install Apple's Command Line Tools."
  echo "Open Terminal, enter: xcode-select --install"
  echo "Finish Apple's installer, then open this file again."
  echo "Your existing apps and bridge have not been changed."
  read -r -p "Press Return to close. " _
  exit 1
fi
if ! /usr/bin/python3 --version >/dev/null 2>&1; then
  echo "Python 3 from the Apple Command Line Tools is unavailable."
  echo "Complete or repair the developer tools installation, then try again."
  read -r -p "Press Return to close. " _
  exit 1
fi
set +e
/usr/bin/python3 "$ROOT/scripts/guided-install.py" "$@"
RESULT=$?
echo
read -r -p "Press Return to close this installer window. " _
exit "$RESULT"
