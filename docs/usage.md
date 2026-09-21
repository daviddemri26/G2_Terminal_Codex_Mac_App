# Using G2 Bridge

Open **G2 Bridge** from `/Applications/G2 Bridge.app` or its Dock icon. This
window manages the local background service; your conversations stay in the
Codex Mac app and Even Terminal.

## Overview

The overview shows the bridge service, Mac app availability, and configured
network. Status refreshes automatically about every eight seconds while the
control app is running. **Bridge is ready** means the local service, desktop
connection, and configured local checks pass. For LAN/interface profiles,
the network card says **Configured · not checked**: the controller does not
independently verify the phone's route to the Mac. The app does not measure whether the glasses
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

## Text

Use **Text** to choose message timestamps, live progress updates, and paragraph
spacing. **Original** spacing with both switches on preserves the previous reading
experience. Adjust the example, then choose **Save changes**. **Reset to original**
restores the original selections; save to apply them.

Changes take effect on the next response or when reopening a completed conversation.
Questions, approval choices, reply identifiers, and code are preserved. The example
illustrates text choices; font size, colors, wrapping, and display layout remain
controlled by Even Terminal. Bridge 0.2.8 is required to save these settings.

## Connect

Follow the short checklist and use **Show pairing code** to reveal the existing
private pairing information as a QR code. Scan it from Terminal Mode in the Even
phone app. No token is regenerated. Keep the QR code private and dismiss it after
pairing. A saved working host does not need pairing again.

The page links to the [installation guide](getting-started.md) and lists reviewed
compatibility. It reflects Tailscale, LAN, or a configured interface without changing
the existing network profile. Public tunnel setup is outside this guided release.

## Settings

**Launch at login** controls automatic startup of the background service when you
sign into your Mac. Turning it off does not stop the current session; use Stop if
you want an immediate stop. Manual Start and Stop preserve this login preference.
The setting does not launch the control window, Codex, or Tailscale automatically.

For Tailscale profiles, **Open Tailscale** opens the network app. Other profiles link
to the connection guide. Advanced network configuration stays in Even Terminal;
this window does not convert an existing profile to another mode.

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
| Waiting for the network | Restore the configured connection; open Tailscale if that is your selected mode |
| Bridge is in use | Let the current interaction finish before maintenance |
| Delivery needs confirmation | Inspect the selected Mac task; do not resend blindly |
| Compatibility needs attention | Check the Mac/Node versions and review a compatible release |
| Installation needs attention | Run Check Installation and inspect its suggested action |

The Mac must remain logged in and awake. This app does not change sleep settings
or provide a service before graphical login. Local checks and a responsive window
do not replace a phone/glasses check when validating a new release.
