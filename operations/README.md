# Managed bridge operations

These standard-library Python helpers manage the existing per-user G2 bridge.
Run commands from the repository root. The native app bundles the same helpers;
the installed LaunchAgent loads its independent copy under Application Support.

The service uses label `com.evencodex.desktop-bridge`, configuration at
`~/.even-terminal/config.json`, and support files under
`~/Library/Application Support/EvenCodexBridge`. The manager generates the real
plist; the checked-in plist is a template, not a file to register unchanged.

## Helpers

| File | Responsibility |
| --- | --- |
| `common.py` | Configuration, authenticated local reads, ownership/locks, release validation, and atomic state writes |
| `supervisor.py` | Supervise the bridge's own HTTP child and publish controlled operational status |
| `manage.py` | Stage/install frozen releases, check health, roll back, and remove service registration |
| `control.py` | Small JSON interface used by the native app for status, settings, and lifecycle controls |

## Read-only checks

```sh
python3 operations/control.py status
python3 operations/control.py diagnose
python3 operations/manage.py health
python3 operations/manage.py check-update
```

`status` checks the small release manifest and current local service/desktop/network
state. It does not hash the entire dependency tree on every refresh. `diagnose`
verifies full current/previous runtime integrity and the recorded Node version.
`check-update` is a local health and build-source drift check, not an online update
feed. None of these commands sends a prompt or launches a separate task engine.

The controller writes JSON to stdout. Successful replies contain `ok: true` and
`installed`, `running`, `launchAtLogin`, `bridgeVersion`, `previousVersion`,
`state`, `message`, `action`, `desktopCompatible`, `desktopAvailable`,
`networkAvailable`, `safeToChange`, `canStart`, `canChangePreferences`, `canRollback`,
`supportPath`, and `checkedAt`.
Errors contain `ok: false`, a controlled `error` message, and exit status 1.
`diagnose` adds a `diagnostics` object. Raw configuration, task content, tokens,
and child-process output are not included.

`running` means the owned LaunchAgent is registered. `ready` additionally requires
local HTTP readiness, the compatible desktop/IPC connection, and the configured
network. Neither field confirms a physical phone/glasses connection.

## Service controls

```sh
python3 operations/control.py start --apply
python3 operations/control.py stop --apply
python3 operations/control.py restart --apply
python3 operations/control.py rollback --apply
printf '%s\n' '{"launchAtLogin":true}' | python3 operations/control.py set-preferences --apply
```

Controller mutations require `--apply`; otherwise they return an error without
changing the service. Preferences accept exactly a JSON object containing the
boolean `launchAtLogin`. The saved launchd preference affects future graphical
logins and does not start/stop the currently loaded service. Manual Start and Stop
preserve that preference. Closing or quitting the native app has no lifecycle effect.

Lifecycle mutations verify the installation/LaunchAgent owner and use the shared
management lock. Active or uncertain deliveries block disruptive changes. Full
release integrity is checked before start/restart/rollback. A completed task's
idle event stream alone does not prevent maintenance. Only the supervisor's owned
HTTP child is stopped; the Mac task engine is not.

`canStart` is distinct from `safeToChange`: starting the same verified release is
allowed when the service is completely stopped with no owned child or listener,
even when a durable delivery record needs reconciliation. The journal is preserved
and no message is resent. This exception does not apply to restart, stop, rollback,
or installation. Launch-at-login preferences do not stop a loaded service and can
be changed while a task is active when service ownership is valid.

Source diagnostics fingerprint the custom bridge modules, the session patch,
upstream entry points, and build metadata. Changing custom code is therefore visible
after rebuilding. The installer enforces the reviewed Node version and generated
compatibility metadata before creating a frozen release.

## Install and recovery

Use `npm ci --ignore-scripts` and `npm run check` to build the reviewed candidate
in `.build/runtime`, then follow [maintenance](../docs/maintenance.md). The normal
managed update is:

```sh
python3 operations/manage.py install --source "$PWD/.build/runtime"
python3 operations/manage.py install --source "$PWD/.build/runtime" --apply
```

The first command is a plan; the second stages and switches an installed release.
Dependencies are copied into the frozen package. The current and previous release
remain available after success. During switching, the manager records recovery
metadata, checks idle state, and checks authenticated HTTP readiness. It attempts
verified recovery on failure only when no interaction or delivery is uncertain.

For this source migration, an identical verified existing 0.2.7 runtime can instead
be adopted by `scripts/adopt-installation.py`. Adoption attaches source provenance
and updates controller helpers without changing current/previous releases or
restarting the active bridge. It is not the procedure for deploying changed code.
See [migration](../docs/migration.md).

The initial takeover of an unmanaged service is a different operation: it requires
its freshly verified listening PID (`--adopt-pid`) and a reviewed rollback source
(`--previous-source`). Do not reuse an old PID or the old global-package installer.

Uninstall removes the LaunchAgent registration after the service is idle, retaining
configuration, releases, logs, and delivery state:

```sh
python3 operations/manage.py uninstall --apply
```

## Isolated tests

```sh
npm run test:operations
```

The tests use temporary directories and mocks. `control.py --support PATH` and the
manager's `--support` option support isolated fixtures; they do not make arbitrary
live mutation safe. Live helpers are kept under `tests/manual/` and excluded from
the default suite. Never delete durable state or weaken an integrity/version guard
to make an unsupported installation start.
