import plistlib
from pathlib import Path
import tempfile
import unittest
from desktop_location import desktop_build


class DesktopLocationTests(unittest.TestCase):
    def test_identity_names_and_ambiguous_builds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def app(name, bundle='com.openai.codex', build='9922'):
                info = root / name / 'Contents/Info.plist'
                info.parent.mkdir(parents=True, exist_ok=True)
                info.write_bytes(plistlib.dumps({'CFBundleIdentifier': bundle,
                    'CFBundleShortVersionString': '26.915.31945', 'CFBundleVersion': build}))
            self.assertIsNone(desktop_build([root]))
            app('ChatGPT.app', bundle='unrelated.app')
            self.assertIsNone(desktop_build([root]))
            app('Codex.app')
            self.assertEqual(desktop_build([root])['CFBundleVersion'], '9922')
            app('ChatGPT.app')
            self.assertEqual(desktop_build([root])['CFBundleVersion'], '9922')
            app('ChatGPT.app', build='different')
            self.assertIsNone(desktop_build([root]))
