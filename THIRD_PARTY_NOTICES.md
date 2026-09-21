# Third-party notices

Even Terminal for Codex Mac App is an independent integration. It is not an official OpenAI, Codex,
Even Realities, Even Terminal, or Tailscale product. Product names identify the
systems with which this project interoperates.

## Even Terminal

The build retrieves `@evenrealities/even-terminal` version **0.10.4** from npm,
with exact archive integrity pinned in `package-lock.json` and
`integration/upstream.json`. It applies the committed patch in `integration/`.
The complete vendor package and its dependencies are not committed to Git.

The inspected 0.10.4 npm README states MIT, but the package has no declared
`license` field and contains no top-level `LICENSE` file. This document does not assign a license to that package
or assert permission to redistribute it. Review the applicable upstream terms
before distributing a bundled runtime outside this local installation.

## Other software and assets

Transitive npm dependencies retain their own copyright and license notices in the
installed dependency tree. Node.js, Python, Apple frameworks/developer tools, the
Codex Mac app, and Tailscale are separate dependencies subject to their respective
terms. The project does not redistribute extracted Codex Mac application source.

The original Even Terminal for Codex Mac App icon was generated with ImageGen. Its prompt and conversion
steps are recorded in [assets/README.md](assets/README.md); it contains no official
Even or OpenAI logo.

No repository-wide open-source license has been assigned by this migration. The
presence of source code or a public repository is not a substitute for a license.
