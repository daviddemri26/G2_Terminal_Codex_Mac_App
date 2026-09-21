# Architecture

G2 Bridge has three parts: the source repository, an installed background service,
and a native control app. Only the repository is edited. The installed service is
a frozen copy of a reviewed build, with its own dependencies and integrity record.

```text
Even Terminal on phone/glasses
              │ authenticated HTTP + SSE over the configured network
              ▼
     Managed HTTP bridge ─── private local IPC ─── Codex Mac app
              ▲                                    existing task engine
              │ supervised by
       User LaunchAgent
              ▲
              │ local status/control commands
       G2 Bridge.app
```

The control window is not in the message path. It calls the bundled
`operations/control.py` using Apple's Python interpreter. Closing the window or
quitting the app does not stop launchd or the bridge. The control app does not send
prompts and does not edit pairing credentials.

## Source and build

`bridge/` owns the custom implementation. `client-contract/` documents and tests
the adapter in `bridge/client-contract.mjs`; there is one editable adapter source.
The integration patch changes three files in Even Terminal 0.10.4 to connect the
custom provider, preserve event replay, and adapt session behavior.

`scripts/build-runtime.py` validates the npm package version, lockfile integrity,
and original file hashes; applies the patch without fuzzy matching; verifies the
patched hashes; and copies the custom bridge modules into `.build/runtime`.
Build metadata records its input hashes. The development runtime links to local
`node_modules`; installation copies the dependencies into its release directory
and rejects links escaping that frozen package.

## Local storage

| Location | Contents and ownership |
| --- | --- |
| Repository | Editable source, tests, docs, and dependency lock |
| Repository `.build/` | Disposable generated runtime, native app, and local reports |
| `~/Library/Application Support/EvenCodexBridge/releases/` | Installed current and previous frozen packages and manifests |
| `…/EvenCodexBridge/operations/` | Installed supervisor and maintenance helpers |
| `…/EvenCodexBridge/control.json` | References to current/previous releases and existing configuration |
| `…/EvenCodexBridge/state/` | Durable delivery state; must survive updates |
| `…/EvenCodexBridge/run/` and `logs/` | Process locks and bounded operational logs |
| `…/EvenCodexBridge/status.json` and `transition.json` | Latest supervised status and update/recovery record |
| `~/.even-terminal/config.json` | Existing pairing token and network settings; preserved during migration |
| `~/Library/LaunchAgents/com.evencodex.desktop-bridge.plist` | Per-user launchd registration |

Node and `/usr/bin/python3` remain external runtime dependencies. A frozen package
does not freeze these executables or the Codex Mac app. The manifest records the
Node path/version, and validation detects incompatible changes.

## Lifecycle and delivery

The LaunchAgent starts at graphical login when enabled. The supervisor waits for
the configured network, checks the selected release, and starts only its HTTP
child. It can restart that child after failure while leaving the Mac task engine
alone. Network address changes are deferred until the bridge is idle and no
delivery is pending. The service cannot keep the Mac awake or run before login.

Prompts and action replies use a durable journal to avoid duplicate submissions.
After an uncertain acknowledgement, the bridge reconciles state instead of
blindly resending. Lifecycle operations refuse changes when an interaction or
unconfirmed delivery may be active. A completed task may remain open on the
glasses; an idle event-stream connection alone does not block maintenance.

The desktop adapter uses private IPC, including the local socket at
`~/.codex/ipc/ipc.sock`. The supported app build is explicit in
`compatibility.json`. This protocol can change after an app update. Unsupported
actions fail closed and remain available through the Mac app where appropriate;
see the detailed [client contract](../client-contract/README.md).
