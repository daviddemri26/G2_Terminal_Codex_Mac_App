# G2 Bridge

A local bridge between Even Terminal on your phone/glasses and the task engine
already running in the Codex Mac app, with a small native macOS control window.
This is an independent integration, not an official OpenAI or Even Realities app.

**One place to edit, one stable installed version.** This repository is the source
of truth. Daily use runs from a separate, verified release in Application Support.
Changing a branch or rebuilding the project does not replace the running bridge.

## Daily use

Open **G2 Bridge** from Applications or the Dock to view status, start or stop the
bridge, set launch at login, run diagnostics, or return to the previous installed
release. Closing the window or quitting this control app leaves the service
running. The Mac must be logged in and awake, the Codex Mac app must be available,
and the configured Tailscale connection must work.

The service starts at the user's graphical login when that preference is enabled;
it does not run before login. A ready status describes the local bridge and its
dependencies, not a confirmed physical connection to the glasses.

See [the usage guide](docs/usage.md) for the window and status messages.

## Current compatibility

| Component | Reviewed version |
| --- | --- |
| Bridge | 0.2.7 |
| Control app | 1.0.0 |
| Even Terminal npm package | 0.10.4 |
| Codex Mac app | 26.915.31945, build 9922 |
| Node.js | 26.9.0 |

The bridge uses a **private local desktop protocol**. Mac app and Node upgrades
need compatibility review; the control window cannot remove this dependency.
Version declarations are kept in [compatibility.json](compatibility.json).
Python 3 at `/usr/bin/python3` is also required for the service and control app;
on this setup it comes from Apple's developer tools and is not bundled.
The native control app requires macOS 14 or later.

## Build and check

From the repository root, with the reviewed Node version and Python 3 available:

```sh
npm ci --ignore-scripts
npm run check
bash scripts/build-app.sh
```

This restores locked dependencies, builds `.build/runtime`, runs the offline
tests, and builds `.build/G2 Bridge.app`. It does not install, restart, or send a
prompt through the live service. The runtime is rebuilt from the pinned npm
package plus the committed integration patch; it no longer depends on an older
source archive or a modified global npm installation. See [development](docs/development.md).

## Repository map

| Location | Purpose |
| --- | --- |
| `bridge/` | Desktop connection, provider, task catalog, delivery journal, client adapter, and unit tests |
| `client-contract/` | Even Terminal protocol notes and adapter tests |
| `integration/` | Exact upstream package metadata and reviewed three-file patch |
| `operations/` | Installation, launchd supervision, status/control, and lifecycle tests |
| `macos/` | Native SwiftUI control app and Dock icon |
| `scripts/` | Reproducible build and packaging commands |
| `tests/` | Integration/build checks, synthetic fixtures, and separate manual helpers |
| `docs/` | Usage, architecture, maintenance, and migration records |
| `.build/`, `node_modules/` | Generated local files; excluded from Git |

Configuration, tokens, task histories, delivery journals, logs, installed releases,
and extracted desktop application source do not belong in this repository.

## Documentation

- [Architecture and local folders](docs/architecture.md)
- [Development and tests](docs/development.md)
- [Daily use and settings](docs/usage.md)
- [Install, update, recover, and uninstall](docs/maintenance.md)
- [Source migration and verification boundaries](docs/migration.md)
- [Change log](CHANGELOG.md) and [third-party notices](THIRD_PARTY_NOTICES.md)

The initial source import preserves bridge 0.2.7 behavior. Its historical validation
record is in [the import manifest](docs/provenance/import-0.2.7.json); a source
import or passing offline checks alone does not establish that a new release has
been installed or physically tested on the glasses.
