# Even Terminal for Codex Mac App

**One conversation across Codex Mac App, Remote on iPhone, and Even G2 glasses.**

Start in the **Codex Mac App**, continue from **Remote in the Codex phone app**,
and pick up the same supported Mac conversation in **Even Terminal on your G2**.
The Mac keeps doing the work. Your glasses give you the context and controls to
keep it moving, without a separate Codex CLI session.

**Steer now. Queue what's next.** Add context while Codex works, choose whether
it should affect the current response or wait for the next turn, and manage
multiple queued prompts directly from the glasses.

[**Start with the setup guide →**](https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/)
 · [Read the guide on GitHub](docs/getting-started.md)
 · [Download the source installer](https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App/archive/refs/heads/main.zip)

## Why this exists

Even Terminal connects smart glasses to coding agents. This project makes that
experience work with the task engine **already owned by the Mac App**. You do not
have to start a separate Codex CLI session or move your conversations to another
workflow.

A small Mac window shows whether the bridge is working, helps you pair your phone,
and lets you choose text presentation. A background service handles the connection
and starts when you sign in. Closing the window leaves it running.

## Steer / Queue, directly from your glasses

| Control | What it does |
| --- | --- |
| **Add prompt** | Dictate a new instruction while the Mac continues working |
| **Steer** | Add that instruction to the current response |
| **Queue** | Save it for a later turn, after the work already in progress |
| **View queue** | Read, remove, pause, resume, or clear waiting prompts |
| **Stop response** | Stop the current response and pause queued work |

While Codex is working: **long press → Yes → Add prompt → dictate with a second
long press → Steer or Queue**. The first **Yes** opens the bridge's controls;
Codex continues unless you choose **Stop response**. When the conversation is
idle, ordinary prompts send directly, without this extra menu.

The queue keeps up to **10 prompts per conversation**, survives bridge restarts,
and sends them in order. It is separate from the Mac App's native queue; prompts
appear in the shared conversation when sent.

This explicit glasses workflow is an addition to unmodified Even Terminal
**0.10.4**. That version has an internal automatic queue; this project adds the
**Steer / Queue choice, persistent queue management, and connection to the
existing Codex Mac App task engine**. See the [feature overview](docs/features.md)
and [full controls](docs/usage.md#add-prompt-and-queue--bridge-032).

## Follow the work across your devices

Remote on iPhone and the glasses access the same supported Mac tasks through
their respective connections. You can switch devices without copying the
conversation. Remote uses the Mac App's own remote connection; the glasses use
the Even Realities phone app and this bridge. Remote is not an extra relay in
the glasses connection and must already be configured to access your Mac.

## What else you can do

- Find and reopen supported local Codex conversations, with their history.
- Follow public updates, activity summaries, elapsed timestamps, and final answers.
- Answer supported questions and approval choices; complex controls remain in the Mac App.
- Choose message timestamps, live progress updates, and paragraph spacing. **The original display remains the default.**
- Pair your phone with a QR code, check status, set launch at login, and run diagnostics.

The glasses still control their own font, brightness, wrapping, and built-in
labels. Create new conversations in the Codex Mac App or Remote first.
Even Terminal for Codex Mac App does not reproduce every Mac control. See the
[interaction details](client-contract/README.md) for precise support.

## Start here

1. **Check the requirements below.** Open your supported Codex Mac App and connect
   your glasses to the Even Realities phone app.
2. **Connect Tailscale on your Mac and phone** for the guided first setup. If you
   already use a different Even Terminal connection, read the [network guide](docs/network-options.md).
3. **Download and expand this repository.** Double-click
   **Install Even Terminal for Codex Mac App.command** and follow its checks. It builds the app locally
   and installs it in Applications; it obtains the reviewed Node runtime if needed.
4. **Open Even Terminal for Codex Mac App → Connect.** Show the pairing QR code and scan it in the
   Even Realities app's Terminal Mode. Choose a conversation you recognize.

The [step-by-step tutorial](docs/getting-started.md) explains the one-time Apple
developer-tools requirement and the phone setup in plain English. The installer
does not require you to install or use the Codex CLI.

**Current release stage: public alpha.** Installation builds from source and needs
Apple's Command Line Tools. There is no Apple-notarized, ready-made download yet.
The desktop connection uses a private protocol, so it supports a specific Mac App
version rather than every current or future release.

## What you need

| Component | Supported / reviewed combination |
| --- | --- |
| Mac | macOS 14 or later; Apple Silicon is the reviewed setup |
| Codex in the Mac App | **26.915.31945, build 9922**; supported `Codex.app` or `ChatGPT.app` identity |
| Glasses | **Even G2**, with the Even Realities phone app and Terminal Mode; vendor setup includes the R1 ring |
| G2 firmware / phone app | Exact versions have not been recorded for certification; no universal/minimum firmware claim |
| Connection | Tailscale for new setup; existing LAN/interface profiles can be preserved |
| Apple tools | Command Line Tools with Swift 6 or later and Python 3 |
| Included dependency | Pinned Even Terminal **0.10.4**; Node **26.9.0** |

The definitive release versions are in [compatibility.json](compatibility.json).
If your Mac App version differs, the installer stops with an explanation. A new
Mac App build must be reviewed before it is accepted. The bridge does not bypass
that check or silently start another task engine.

**Does it work without Tailscale?** Even Terminal already supports the same Wi-Fi
and other network modes. The Codex desktop connection does not inherently require
Tailscale. It is the physically reviewed setup here; other modes have different
status/reconnection limits and have not been validated on the phone/glasses.
If a LAN/interface address changes, finish the interaction, restart the bridge
when safe, then show and scan the new QR. Refreshing the QR alone is insufficient.
Read the [network comparison](docs/network-options.md).

## How it works, simply

```text
Even G2 ↔ Even Realities phone app ↔ configured network ↔ Even Terminal for Codex Mac App ↔ Codex Mac App
```

The phone sends authenticated messages to the bridge on your Mac. The bridge
translates them into the Mac App's local protocol, and sends its public responses
back in the format Even Terminal understands. The Mac App remains responsible
for running the task. Saved delivery records help reconcile interrupted
connections without blindly sending the same instruction twice.

Keep your Mac logged in and awake, with the Codex Mac App and the configured network available.
Automatic startup begins at login, not before it, and Even Terminal for Codex Mac App does not change
sleep settings. “Ready” confirms local checks; seeing your conversation on the
glasses is the separate end-to-end check.

This is an independent community integration, not an official OpenAI or Even
Realities product. Your existing Codex account and its normal data handling still
apply; a local bridge does not make the AI service offline.

## For contributors and advanced users

**One editable source: this repository.** The installed background service is a
verified build. It is never maintained as a second source tree. Dependencies,
pairing secrets, histories, journals, and logs stay outside Git.

```sh
npm ci --ignore-scripts
npm run check
bash scripts/build-app.sh
```

These commands restore locked dependencies, build `.build/runtime`, run the
offline tests, and build `.build/Even Terminal for Codex Mac App.app`. They do not install, restart, or
send a prompt through the live service. Use the reviewed Node version.

| Area | Guide |
| --- | --- |
| First installation and pairing | [Getting started](docs/getting-started.md) |
| Steer / Queue and cross-device continuity | [Feature overview](docs/features.md) |
| Controls and text settings | [Daily use](docs/usage.md) |
| Network choices and limits | [Tailscale / same Wi-Fi](docs/network-options.md) |
| Components and local folders | [Architecture](docs/architecture.md) |
| Builds and tests | [Development](docs/development.md) |
| Updates, rollback, and removal | [Maintenance](docs/maintenance.md) |
| Proposed Even Hub guide companion | [Listing and submission preparation](distribution/even-hub/README.md) |
| Import history and validation boundaries | [Migration](docs/migration.md) |
| Protocol, questions, and approvals | [Client contract](client-contract/README.md) |
| Release history and dependencies | [Change log](CHANGELOG.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) |

Sources live in `bridge/`, `operations/`, and `macos/`; `integration/` records the
pinned upstream patch, `scripts/` builds and packages, `tests/` validates behavior,
and `site/` publishes this project's GitHub Pages tutorial. The optional
`even-hub/` project contains a separate guide companion being prepared for Even
Hub review; it is not required to use the Mac bridge and is not yet listed.
