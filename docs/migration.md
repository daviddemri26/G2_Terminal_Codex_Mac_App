# Source migration

The project began in dated working folders with an already patched global Even
Terminal package. This repository becomes the editable reference while the
separately installed bridge keeps its existing configuration and release history.
Older folders are retained as historical sources; this migration does not delete
or move them. Future work should start in this repository.

## Imported baseline

The imported baseline is the sanitized G2 Desktop Bridge **0.2.7** source archive.
[The provenance manifest](provenance/import-0.2.7.json) records hashes, the examined
desktop build, the upstream package version, privacy substitutions, and historical
test counts. Those hashes describe the archive before this repository's migration
edits; they are not a manifest of every current repository file.

The historical source passed 126 Node tests and 25 Python tests before packaging.
These are provenance facts, not the results of the new repository/app validation.
Physical checks of earlier display behavior are recorded in the client-contract
notes; they do not establish a new physical test of this migration.

## Structural changes

| Before | Repository reference |
| --- | --- |
| Bridge source in dated working folders | `bridge/` |
| Duplicated client adapter source | Single implementation in `bridge/client-contract.mjs` |
| Builder requiring a modified global package | `scripts/build-runtime.py` plus pinned npm input and `integration/` patch |
| Root-level event test | `tests/integration/events.test.mjs` |
| Live smoke-test scripts mixed with source | Opt-in `tests/manual/` helpers |
| Sanitized question snapshot | `tests/fixtures/native-question.json` |
| Archive manifest | `docs/provenance/import-0.2.7.json` |
| Terminal-only operational controls | Shared Python control interface and native `macos/` app |

No extracted Codex application source is added to Git. The vendor dependency is
retrieved by npm from the lockfile; its complete package is not committed. Only
the reviewed integration patch and package/hash metadata are tracked.

## What remains local

Pairing stays in `~/.even-terminal/config.json`. Installed releases, supervisor
state, locks, logs, and delivery records stay under
`~/Library/Application Support/EvenCodexBridge`. The existing LaunchAgent identity
is retained. The new control app operates this managed service instead of starting
another bridge alongside it.

For this migration, `scripts/adopt-installation.py` compares the existing frozen
0.2.7 release against the rebuilt runtime and verifies the installed integrity.
When they match, adoption can back up and update the operations/controller files
and attach the repository build-source metadata. It keeps the active release,
previous 0.2.6 release, pairing configuration, delivery journal, LaunchAgent, and
running process identities. It does not restart an active interaction simply to
replace identical code.

After building and checking the repository, inspect adoption before applying it:

```sh
python3 scripts/adopt-installation.py
python3 scripts/adopt-installation.py --apply
```

The first command only verifies and reports. The second also saves the previous
control/operations files under the local `maintenance-backups/` directory before
attaching the verified source metadata.

Adoption is not an upgrade mechanism for changed bridge code. Future runtime
changes use `operations/manage.py install --source "$PWD/.build/runtime" --apply`
after verification and an idle check, as described in [maintenance](maintenance.md).
That installer records the current release as the rollback version before switching.
No source reorganization should require pairing the glasses again.

## Another Mac or a missing installation

The adoption script requires an existing managed installation and matching code.
It is not a first-run pairing wizard. On another Mac, install the reviewed external
dependencies, establish the expected Even Terminal configuration and private
network connection, verify the compatible Mac app, then build and install the
runtime using the managed installer. Do not copy a private token or delivery
journal into Git as a setup template. The control app reports a missing
installation; opening it does not manufacture credentials or start another engine.

## Validation boundaries

Track these results independently when completing a migration or later release:

1. Offline tests and a build from the lockfile and committed patch.
2. Native app build and a visual check of the real window.
3. Installed runtime integrity, local HTTP readiness, and preserved configuration.
4. Launch preference and supervised-service behavior where tested.
5. Physical phone/glasses behavior, only when actually checked.

## Completed local migration — 2026-09-21

The existing installation was adopted after comparing 6,237 runtime/dependency
files with the rebuilt source. Bridge 0.2.7 remains active and 0.2.6 remains the
rollback release. Pairing configuration and the LaunchAgent plist have identical
before/after hashes, and both the supervisor and bridge kept their process IDs.
The repository build source and its fingerprint are now attached to the managed
installation. Older working folders remain historical references.

G2 Bridge 1.0.0 was built, locally signed, installed in `~/Applications`, and added
to the Dock. Overview, Settings, and Maintenance were checked in the real native
window. Launch at login was switched off and on through the app, verified against
launchd, and left enabled without restarting the service. Closing/quitting the
control window leaves the service running.

Validation passed: 120 Node unit tests, 6 Node integration tests, 68 Python
operations tests, and 6 build/adoption tests (200 total), plus focused Swift checks
for status handling, controller requests, and timeouts. Full installed-release
integrity checks and application signature verification passed.

No logout/reboot or new physical phone/glasses test was performed during this
migration. The service was already active; no test prompt was sent to a task.
The configured automatic startup and local checks do not replace those separate
end-to-end checks.
