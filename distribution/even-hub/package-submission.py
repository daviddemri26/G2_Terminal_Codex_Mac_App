#!/usr/bin/env python3
"""Collect a reviewable local submission draft; never upload or log in."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

DOCS = Path(__file__).resolve().parent
ROOT = DOCS.parents[1]
APP = ROOT / 'even-hub'


def main():
    manifest = json.loads((APP / 'app.json').read_text())
    version = manifest['version']
    package = APP / '.build' / f'even-terminal-for-codex-mac-app-guide-{version}.ehpk'
    if not package.is_file():
        raise SystemExit('Build and pack the companion first; see even-hub/README.md.')
    out = ROOT / '.build' / f'Even-Terminal-for-Codex-Mac-App-Guide-{version}-submission-draft'
    out.mkdir(parents=True, exist_ok=True)
    names = ['listing.md', 'privacy.md', 'review-notes.md', 'validation.md']
    files = []
    for name in names:
        target = out / name
        shutil.copyfile(DOCS / name, target)
        files.append(target)
    target = out / package.name
    shutil.copyfile(package, target)
    files.append(target)
    assets = out / 'assets'
    assets.mkdir(exist_ok=True)
    for name, source_name in (
        ('icon-24.png', 'icon-24.png'),
        ('background-draft.png', 'background-draft.png'),
        ('phone-review.png', f'phone-review-{version}.png'),
    ):
        # A capture from a previous version is not evidence for this candidate.
        source = ROOT / '.build/even-hub-assets' / source_name
        if source.is_file():
            target = assets / name
            shutil.copyfile(source, target)
            files.append(target)
    readme = out / 'START-HERE.md'
    readme.write_text('''# Even Terminal for Codex Mac App Guide — submission draft

This is a local review package. It has not been uploaded, submitted, or approved.

- `listing.md`: English copy for the listing.
- `even-terminal-for-codex-mac-app-guide-''' + version + '''.ehpk`: packaged guide companion.
- `privacy.md`: draft notice to review and publish at a public URL.
- `review-notes.md`: purpose, test steps, and pending publisher details.
- `validation.md`: completed checks and exact limits; read before submission.
- `assets/`: original icon, proposed background, and current-version phone-view image when available.
- `checksums.json`: file hashes for this local package.

Native glasses screenshots and physical device validation remain outstanding.
Any phone review image is not a substitute for glasses screenshots. Confirm
package ID availability and portal field/image requirements during private testing.

The guide does not install or replace the Mac bridge or Even Terminal.
Mac setup: https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/
Publisher documentation: https://hub.evenrealities.com/docs/ship/app-submission
''')
    files.append(readme)
    checksums = out / 'checksums.json'
    checksums.write_text(json.dumps({str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()
                                   for p in files}, indent=2) + '\n')
    files.append(checksums)
    archive = out.parent / (out.name + '.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as target:
        for source in files:
            target.write(source, str(Path(out.name) / source.relative_to(out)))
    print(archive)


if __name__ == '__main__':
    main()
