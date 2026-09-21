# Development

Use this repository for all new source work. The service uses a separate installed
release, so normal editing and builds do not change daily use.

## Prerequisites

- macOS 14 or later with Xcode Command Line Tools for Swift, `xcrun`, and `/usr/bin/python3`.
- Node.js 26.9.0 and npm. The installer defaults to `/opt/homebrew/bin/node`;
  another reviewed executable can be selected with `--node`.
- Network access to restore the exact locked npm dependencies.

The Mac app and Tailscale are needed for live use, not the isolated unit tests.
The native application is built locally for the current Mac architecture; it is
ad-hoc signed, not a notarized or universal distribution.

## Restore, build, test

```sh
npm ci --ignore-scripts
npm run check
```

Dependency install scripts are disabled. The builder explicitly restores execute
permissions for the upstream prebuilt `node-pty` helper. It does not invoke an
upstream engine or install a service. The `yargs` 18.1.0 pin/override preserves the
dependency version used by the imported installation rather than accepting a
newer version through the upstream version range.

The individual commands are:

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the patched runtime into `.build/runtime` |
| `npm test` | Offline provider, IPC, journal, and client-contract tests |
| `npm run test:integration` | Replay/event tests against the built runtime |
| `npm run test:operations` | Isolated Python lifecycle/control tests |
| `npm run test:build` | Build-input and reproducibility guards |

Run the build before integration tests. Inspect failures; do not repair them by
patching generated files or weakening integrity/correlation checks. The exact
upstream package and patched file hashes live in `integration/upstream.json`.

## Native app

```sh
bash scripts/build-app.sh
bash macos/tests/run.sh
open -n '.build/G2 Bridge.app' --args --preview
```

The build produces `.build/G2 Bridge.app`. The focused Swift checks exercise
subprocesses, decoding, timeouts, and readiness labels with synthetic input.
Preview uses synthetic status and disabled service controls; it does not poll or
change the installed service. Navigation buttons can still open other apps.
Open the bundle without `--preview` to inspect the actual local installation.

Swift sources live in `macos/Sources/`; the committed icon is
`macos/Resources/AppIcon.icns`. The build packages the Python operations helpers as
app resources. The UI starts those helpers directly with structured arguments,
not a shell, and reads their JSON output. See [native app details](../macos/README.md).

Building the app and installing it are separate steps. Opening its window does
not install or update the background runtime. After building, inspect and apply
the local app installation:

```sh
python3 scripts/install-app.py
python3 scripts/install-app.py --apply
```

The default destination is `/Applications/G2 Bridge.app`. Use
`--destination "$HOME/Applications/G2 Bridge.app"` for an explicit per-user installation. The installer checks
bundle identity and signature, refuses to replace the app while its window
process is running, and saves the previous app separately when replacing it.
It does not change the background bridge. Rebuild/reinstall the control app after
changing its bundled `operations/` helpers.

## Live checks are separate

### Optional Even Hub guide

The independent `even-hub/` npm project builds a small reference companion. Its
dependencies are locked separately and are not used by the Mac bridge, installer,
or background service. See its [README](../even-hub/README.md) for build, simulator,
and package commands, and [submission preparation](../distribution/even-hub/README.md)
for the draft store listing. Do not treat its SDK phone-version floor as a new
physical compatibility certification for the Mac bridge.

### Mac bridge live checks

`tests/manual/http_bridge.py` starts a private loopback test listener on port 3457
and sends a real marker prompt into an existing task. It requires both
`G2_BRIDGE_ALLOW_LIVE_TEST=YES` and `G2_BRIDGE_TEST_TASK_ID`. Run it only when a live
test and its target task are explicitly authorized. Its historical task-history
expectations may need a deliberately prepared test task; do not reuse an arbitrary
working conversation.

`tests/manual/verify_install.py` uses `G2_BRIDGE_TEST_TASK_ID` to inspect an existing
smoke-test task and writes a local report. It does not send a prompt. Its optional
`--restart-idle-child` flag does change the lifecycle of the verified HTTP child.
Neither helper belongs in automatic CI or the default test command.

## Git workflow

Keep `main` reviewable and use a branch per change. Build and test before installing
a candidate; record local-service and physical-device results separately. Keep
secrets and generated artifacts out of commits. Version the bridge and control
app independently in `compatibility.json`; record changes in `CHANGELOG.md`.
For a dependency or desktop upgrade, review the actual protocol/patch changes and
validation before updating compatibility declarations.
