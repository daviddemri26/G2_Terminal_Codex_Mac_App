# Maintenance

Use G2 Bridge for ordinary status, start/stop, launch-at-login settings, diagnostics,
and rollback. Runtime updates are reviewed local installations; there is no remote
update feed or automatic download of GitHub code.

## Read status first

These commands do not submit prompts or change the service:

```sh
python3 operations/control.py status
python3 operations/control.py diagnose
python3 operations/manage.py health
```

`status` is a lightweight live summary. `diagnose` performs full runtime and
previous-release integrity checks and returns a restricted diagnostic summary.
The older `manage.py check-update` command is a local health/source-change check,
not a query for an available online release.

## Install a reviewed runtime

For the first repository migration of an already managed, identical 0.2.7 release,
use the [adoption procedure](migration.md) to preserve its running processes and
previous release. The following procedure is for an actual runtime replacement or
an initial installation after its local configuration and prerequisites exist.

First restore, build, and pass offline checks as described in
[development](development.md). From the repository root:

```sh
python3 operations/manage.py install --source "$PWD/.build/runtime"
```

Without `--apply`, this prints the intended action and does not stage or replace
anything. After reviewing the built candidate within the authorized maintenance
scope, apply it:

```sh
python3 operations/manage.py install --source "$PWD/.build/runtime" --apply
```

The manager verifies compatibility and stages a full release while the old service
remains available. It checks idle/pending-delivery state again before switching,
records a recovery transition, installs the operations helpers, and checks the new
authenticated HTTP version. Pairing configuration stays at its existing path.

The current release becomes the previous release. A successful installation keeps
those two releases and prunes older managed release directories. Source archives
and independent backups are not removed. Do not edit an installed release: its
manifest verifies file content and links.

On startup failure, the manager attempts to restore the verified previous release
only when no interaction may be active. An uncertain delivery defers recovery;
inspect the Mac task and diagnostics instead of forcing a switch or deleting state.

A first migration from an **unmanaged** bridge needs a freshly verified listener
PID and a reviewed `--previous-source` for recovery. Do not reuse an old PID or
invoke the older global-package installer. An already managed installation uses
its saved current release automatically and needs neither of those arguments.

## Control commands

```sh
python3 operations/control.py start --apply
python3 operations/control.py stop --apply
python3 operations/control.py restart --apply
python3 operations/control.py rollback --apply
```

These commands check installation ownership and refuse unsafe lifecycle changes.
Start can resume the same verified release when the service is completely stopped,
even if its delivery journal needs reconciliation. It keeps the journal intact and
does not resend messages. Uncertain delivery still blocks stop, restart, rollback,
and runtime replacement.
Stopping the bridge does not stop the Mac task engine. A manual start/stop does not
rewrite the saved launch-at-login preference. Rollback exchanges current and
previous release references after verifying the previous runtime; it never falls
back to an unpatched global npm provider.

The sole configurable preference is passed as JSON on standard input:

```sh
printf '%s\n' '{"launchAtLogin":true}' | python3 operations/control.py set-preferences --apply
```

This changes launchd's saved login preference. Use Start or Stop for an immediate
service change. All control mutations require `--apply`; omitting it returns an
error without changing the service. The native app supplies it for explicit button
actions. The separate `manage.py` installer supports a non-mutating plan.

## Recovery after an update

If the Mac app or Node changes, run diagnostics. Review that exact combination and
rebuild a compatible release before installation. Keep the version/integrity guard;
the installer checks the reviewed Node version before freezing a candidate, so
reinstalling cannot silently approve a Node upgrade.
An unsupported release must not silently start a second task engine. Restoring a
previous bridge cannot by itself restore an older Mac app or Node executable.

If Tailscale is unavailable, open it and reconnect. If the Mac app is unavailable,
open the installed application. If the bridge port belongs to another process,
inspect the owner rather than killing unrelated processes.

To remove automatic service registration while retaining configuration, state,
logs, and releases:

```sh
python3 operations/manage.py uninstall --apply
```

Do not delete the support directory or delivery journal as an uninstall shortcut.
Removing the native control app alone does not uninstall the background service.
