# Using G2 Bridge

Open **G2 Bridge** from `~/Applications/G2 Bridge.app` or its Dock icon. This
window manages the local background service; your conversations stay in the
Codex Mac app and Even Terminal.

## Overview

The overview shows the bridge service, Mac app availability, and configured
network. Status refreshes automatically about every eight seconds while the
control app is running. **Bridge is ready** means the local service, desktop
connection, and network checks pass. The app does not measure whether the glasses
are physically connected or displaying a response.

Use **Start**, **Stop**, or **Restart** when available. Stop, Restart and Restore
are disabled when an interaction is active, delivery is uncertain, or status
cannot be safely checked. A completely stopped bridge can start its same verified
release to reconcile an uncertain delivery; starting it never resends that message.
**Open Mac App** opens the installed Codex app when the bridge is waiting
for it. Stopping the bridge leaves the Mac task engine running.

Closing the window or choosing Quit G2 Bridge leaves the service running. Click
the Dock icon again to reopen the window. The window does not need to stay open
for the glasses to work.

## Settings

**Launch at login** controls automatic startup of the background service when you
sign into your Mac. Turning it off does not stop the current session; use Stop if
you want an immediate stop. Manual Start and Stop preserve this login preference.
The setting does not launch the control window, Codex, or Tailscale automatically.

**Open Tailscale** opens the network app. The first version intentionally keeps
pairing tokens, network addresses, and advanced runtime configuration out of this
window. Existing pairing settings remain unchanged.

## Maintenance

View the installed and previous bridge versions. **Check Installation** performs
read-only integrity and compatibility checks; it does not send a prompt. Diagnostic
details contain controlled operational information rather than raw task or token
data. **Open Support Folder** reveals the local service files in Finder.

When a verified previous release exists, **Restore** offers a return to it. The
app explains the action and asks for confirmation; the controller checks again
that no interaction or unconfirmed delivery is active before switching.

There is no automatic update feed in this version. A new runtime is built, checked,
and installed from this repository using the [maintenance procedure](maintenance.md).

## Common statuses

| Status | What to do |
| --- | --- |
| Bridge is stopped | Start it when you want to use Even Terminal |
| Waiting for the Mac app | Open the installed Codex Mac app |
| Waiting for the network | Open Tailscale and restore the configured connection |
| Bridge is in use | Let the current interaction finish before maintenance |
| Delivery needs confirmation | Inspect the selected Mac task; do not resend blindly |
| Compatibility needs attention | Check the Mac/Node versions and review a compatible release |
| Installation needs attention | Run Check Installation and inspect its suggested action |

The Mac must remain logged in and awake. This app does not change sleep settings
or provide a service before graphical login. Local checks and a responsive window
do not replace a phone/glasses check when validating a new release.
