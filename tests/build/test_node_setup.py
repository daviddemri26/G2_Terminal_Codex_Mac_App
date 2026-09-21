"""Pinned prerequisite downloads must not run or install unverified archives."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ensure_node', ROOT / 'scripts/ensure-node.py')
node_setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(node_setup)


class NodeSetupTests(unittest.TestCase):
    def test_missing_node_dry_run_never_downloads_or_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            support = Path(directory) / 'missing-support'
            with patch.object(node_setup.platform, 'system', return_value='Darwin'), \
                 patch.object(node_setup.shutil, 'which', return_value=None), \
                 patch.object(node_setup.urllib.request, 'urlopen') as download:
                result = node_setup.ensure_node(support=support, machine='arm64')
            self.assertFalse(result['ready'])
            self.assertIn('https://nodejs.org/dist/v26.9.0/', result['source'])
            self.assertFalse(support.exists())
            download.assert_not_called()

    def test_existing_exact_node_does_not_download(self):
        with patch.object(node_setup.platform, 'system', return_value='Darwin'), \
             patch.object(node_setup.shutil, 'which', return_value='/reviewed/node'), \
             patch.object(node_setup, 'version_matches', return_value=True), \
             patch.object(node_setup.urllib.request, 'urlopen') as download:
            result = node_setup.ensure_node(apply=True, machine='arm64')
        self.assertEqual(result['node'], '/reviewed/node')
        self.assertFalse(result['downloaded'])
        download.assert_not_called()

    def test_unexpected_archive_paths_and_links_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for name, link in (('../escape', None), ('node/bin/link', '../../../escape'), ('node/device', False)):
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode='w') as archive:
                    member = tarfile.TarInfo(name)
                    if isinstance(link, str):
                        member.type, member.linkname = tarfile.SYMTYPE, link
                    elif link is False:
                        member.type = tarfile.CHRTYPE
                    archive.addfile(member)
                data.seek(0)
                with tarfile.open(fileobj=data) as archive:
                    with self.assertRaises(node_setup.BridgeError):
                        list(node_setup.archive_members(archive, Path(directory), 'node'))

    def test_bad_download_checksum_leaves_no_installed_runtime(self):
        class Response(io.BytesIO):
            url = 'https://nodejs.org/dist/v26.9.0/node-v26.9.0-darwin-arm64.tar.gz'
        with tempfile.TemporaryDirectory() as directory:
            support = Path(directory) / 'support'
            with patch.object(node_setup.platform, 'system', return_value='Darwin'), \
                 patch.object(node_setup.shutil, 'which', return_value=None), \
                 patch.object(node_setup.urllib.request, 'urlopen', return_value=Response(b'untrusted archive')):
                with self.assertRaisesRegex(node_setup.BridgeError, 'checksum'):
                    node_setup.ensure_node(apply=True, support=support, machine='arm64')
            self.assertFalse((support / 'tools/node-v26.9.0-darwin-arm64').exists())


if __name__ == '__main__':
    unittest.main()
