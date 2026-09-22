# One conversation. Mac, phone, glasses.

**Even Terminal for Codex Mac App** brings the conversations you already use in
**Codex Mac App** and **Remote on iPhone** to **Even Terminal on Even G2**.
Start at your desk, add context while walking, and return to the same work.
The Mac App remains the task engine throughout.

## Steer now. Queue what's next.

You do not have to wait for a response to finish before adding another idea.

| On the glasses | What happens |
| --- | --- |
| **Add prompt** | Open dictation without stopping the work on the Mac |
| **Steer** | Send your new context into the response already in progress |
| **Queue** | Save another request to run after the current work and earlier queued prompts |
| **View queue** | Read full drafts, remove an item, pause/resume the queue, or clear waiting items |
| **Stop response** | Stop the active response and pause waiting prompts |

For example, **Steer** “Focus on the installation problem first” to adjust the
current work. **Queue** “When you finish, write a short checklist” for a separate
follow-up. Add several queued prompts in the order you want them handled.

While working, use **long press → Yes → Add prompt**, then a second normal long
press to dictate. Choose **Steer**, **Queue**, or **Cancel** after capture.
The native “Stop agent response?” dialog still appears first; its **Yes** opens
our controls, and **Stop response** is the action that actually stops Codex.
The bridge does not remotely turn on your microphone.

If work finishes during this explicit input flow, **Send prompt** replaces
**Steer**. Ordinary messages in an already idle conversation send directly.
**View queue** appears in the running-response menu only when there are queued
messages; reopening an idle conversation also exposes a queue needing attention.

## What this adds to Even Terminal

Compared with the pinned, unmodified **Even Terminal 0.10.4**, this integration
adds the explicit **Steer / Queue** decision and queue-management menus on the
glasses, together with reuse of the **Codex Mac App's existing task engine**.
Stock 0.10.4 already has an automatic in-memory prompt queue internally; the
claim here is about these added controls, durable storage, and Mac App integration,
not the absence of all queuing in stock Even Terminal.

Our queue stores up to **10 prompts per conversation** on your Mac and survives
bridge restarts. It sends one at a time, pauses after stopped or failed work,
and does not blindly retry a message with uncertain delivery. It is independent
of the Mac App's native queue: waiting drafts are managed on the glasses and
appear in the Mac/Remote conversation when dispatched.

## Follow the same work everywhere

- **Codex Mac App:** the task engine, full conversation, and native controls.
- **Codex phone app — Remote:** the Mac App's own remote access to those tasks.
- **Even G2 + Even Terminal:** history, public progress, final answers, supported
  questions and approvals, plus the added **Steer / Queue** controls.

Remote must already be set up for your Mac. The bridge does not route glasses
messages through Remote or add support for unrelated cloud conversations.
The Mac must stay logged in and awake, with the Mac App and network available.

Bridge 0.3.2 refreshes Mac state before restoring history, replaying reconnects,
or returning polled messages. Questions answered on the Mac are retired instead
of being offered again as old actionable choices. The latest synchronization
changes passed offline tests; their physical-device check remains pending.

## Readable progress and a simple setup

Public updates, activity headings, subagent status, and file-change summaries
appear when the Mac App provides them. Optional elapsed labels use **[2s]** below
a minute and **[1:04]** afterward. Supported questions retain their choices, and
the final answer stays distinct. Interface copy is English; assistant responses
retain the conversation's language. Native Even labels and display styling remain
controlled by Even Terminal.

The Mac control window handles status, pairing by QR code, launch at login,
text preferences, diagnostics, and guarded maintenance. The background service
continues when the window closes.

## Availability and limits

This is an independent **public alpha**, reviewed for the combination in
[compatibility.json](../compatibility.json). User-reported physical tests confirm
Add prompt, Steer, Queue, and queue management in the tested setup; that does not
certify every recovery case, phone version, or firmware. See the
[release validation record](validation-0.3.2.md).

**New session is not supported from the glasses through this connection.**
Create a conversation on the Mac or Remote, then select it in Even Terminal.
Complex forms, sign-in, previews, and controls without a verified response route
still need the native apps. This integration does not promise every Mac control
on the glasses.

[Set up the bridge](getting-started.md) · [Use the controls](usage.md) ·
[Read the architecture](architecture.md)
