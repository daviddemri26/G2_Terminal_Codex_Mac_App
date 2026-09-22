# Using Even Terminal for Codex Mac App

Open **Even Terminal for Codex Mac App** from `/Applications/Even Terminal for Codex Mac App.app` or its Dock icon. This
window manages the local background service; your conversations stay in the
Codex Mac App and Even Terminal.

## One conversation across Mac, Remote, and glasses

Open the same supported Mac task in **Codex Mac App**, **Remote in the Codex phone
app on iPhone**, or **Even Terminal on G2**. Remote uses the Mac App's own connection;
the glasses use the Even Realities phone app and this bridge. Set up Remote
separately if you want to use it. The Mac stays logged in and awake in either case.

The main addition on the glasses is **Steer / Queue**: add context to the current
response or save a prompt for later, with queue controls available on the glasses.
[See the feature overview](features.md) or jump to [Add prompt and Queue](#add-prompt-and-queue--bridge-032).

## Overview

The overview shows the bridge service, Mac App availability, and configured
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

Closing the window or choosing Quit Even Terminal for Codex Mac App leaves the service running. Click
the Dock icon again to reopen the window. The window does not need to stay open
for the glasses to work.

## Text

Message timestamps use `[2s]` or `[54s]` below one minute, then `[1:04]` or
`[26:45]` from one minute onward. Long tasks keep total minutes, such as `[62:03]`.

Use **Text** to choose message timestamps, live progress updates, and paragraph
spacing. **Original** spacing with both switches on preserves the previous reading
experience. Adjust the example, then choose **Save changes**. **Reset to original**
restores the original selections; save to apply them.

Changes take effect on the next response or when reopening a completed conversation.
Questions, approval choices, reply identifiers, and code are preserved. The example
illustrates text choices; font size, colors, wrapping, and display layout remain
controlled by Even Terminal. Text settings are supported by bridges 0.2.8, 0.2.9, 0.3.0, 0.3.1, and 0.3.2.

Bridge 0.2.9 adds public activity headings, subagent lifecycle updates, grouped
reading/search/command activity, and a compact file-change summary to the live
progress display. Line totals appear only when the data supports reliable
counting; uncertain totals are omitted. Subagent states are shown only when
reported explicitly by the Mac App. These updates use the same dim activity rows
as public commentary; Even Terminal supplies their built-in labels. Turning **Live progress updates**
off hides the added rows both live and in reopened history. The final answer
remains a separate message. Reopened history includes the activity text,
but its brightness is controlled by Even Terminal and may differ from live rows.

## Add prompt and Queue — bridge 0.3.2

The user reported successful **Add prompt** use on physical glasses with 0.3.0
and successful **Queue** use with 0.3.1. The synchronization changes in 0.3.2
still need their own physical check; see the
[0.3.2 validation record](validation-0.3.2.md).

While a response is running:

1. Use the normal long press and confirm Even Terminal's native **Yes** step.
   Choose **Add prompt**, **Stop response**, or **Keep working**. **View queue**
   also appears when this conversation has queued messages.
2. Choose **Add prompt**, then use a second normal tap-and-hold to dictate.
   The Codex Mac App keeps working. The bridge does not activate the microphone
   remotely; it temporarily presents the client's input view.
3. Review the captured draft. **Steer** sends it into the current response;
   **Queue** saves it after earlier queued messages; **Cancel** discards it.
   If the response finished before capture, **Send prompt** replaces **Steer**
   and requires confirmation before starting a follow-up. **Queue** remains available.

Incoming activity is held while local controls are open and caught up when they
close. A timeout, a conflicting native question/approval, or a replaced turn
closes temporary input without sending an unconfirmed draft. A composition
explicitly opened while the Mac was busy keeps its confirmation step even if
the response finishes before you submit it. Ordinary follow-ups sent while the
task is idle go directly to the Mac, including after earlier **Add prompt** use.
Approval correlation and the compact elapsed-time format are unchanged.

### Managing queued messages

The bridge saves up to **10 messages per conversation**, in the order you add
them. It sends one at a time when the task is ready after the preceding work.
This is the bridge's durable local queue; the Mac App's own queue is untouched.

To inspect it while the Mac is working, use **long press → Yes → View queue**.
This optional choice appears only when the queue is nonempty. If a queue needs
attention while the task is idle, reopening the conversation shows its controls.
The list contains ordered previews and each message's current state.

- Select a message to read its full text. **Remove** is available while it is waiting
  or paused; **Back** returns to the list.
- **Pause queue** holds waiting messages. **Resume queue** allows a paused queue
  to continue when the task is ready.
- **Clear queue** removes waiting messages. **Back** closes the list without
  changing them. Sending or uncertain messages cannot be removed or cleared;
  **Resume queue** is also withheld while such a delivery needs confirmation.

A failed or interrupted response pauses waiting messages. **Stop response** also
pauses them before interrupting the current Mac response. A native question or
approval must be answered before queued work can proceed. If delivery is uncertain,
inspect the task on the Mac or in Remote: the bridge will not automatically retry
that message. Queue entries remain saved across restarts. Finish or clear the
queue before disruptive maintenance; even a paused queue protects its saved work.

## Reopening a conversation and New session

Bridge 0.3.2 refreshes the latest Mac state before reconnect replay, message polling,
and history restoration. A question already answered on the Mac is retired
instead of being restored as an actionable choice from an older event.

**New session** is not supported through the reviewed native desktop connection.
Use an existing conversation, or create one in the Codex Mac App or Remote first
and then select it on the glasses. The bridge reports this limitation rather
than starting a separate Codex engine. This does not establish or repair the
phone client's microphone behavior on its New session screen.

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
| Waiting for the Mac App | Open the installed Codex Mac App |
| Waiting for the network | Restore the configured connection; open Tailscale if that is your selected mode |
| Bridge is in use | Let the current interaction finish before maintenance |
| Delivery needs confirmation | Inspect the selected Mac task; do not resend blindly |
| Compatibility needs attention | Check the Mac/Node versions and review a compatible release |
| Installation needs attention | Run Check Installation and inspect its suggested action |

The Mac must remain logged in and awake. This app does not change sleep settings
or provide a service before graphical login. Local checks and a responsive window
do not replace a phone/glasses check when validating a new release.
