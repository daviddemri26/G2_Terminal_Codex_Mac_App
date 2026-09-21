"""Find the reviewed desktop identity in standard Mac application folders."""
from pathlib import Path
import plistlib

BUNDLE_ID = 'com.openai.codex'
BUILD_KEYS = ('CFBundleShortVersionString', 'CFBundleVersion')


def desktop_build(directories=None):
    directories = directories if directories is not None else (
        Path('/Applications'), Path.home() / 'Applications')
    builds = []
    for directory in directories:
        for name in ('ChatGPT.app', 'Codex.app'):
            path = Path(directory) / name / 'Contents/Info.plist'
            try:
                info = plistlib.loads(path.read_bytes())
            except (OSError, plistlib.InvalidFileException):
                continue
            if info.get('CFBundleIdentifier') == BUNDLE_ID:
                builds.append({key: info.get(key) for key in BUILD_KEYS})
    # Conflicting installed builds make the running IPC owner's version ambiguous.
    if not builds or any(build != builds[0] for build in builds):
        return None
    return builds[0]
