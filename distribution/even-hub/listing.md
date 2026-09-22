# Even Hub listing draft

**Submission draft. Not submitted, approved, or listed on Even Hub.**

The suggested fields below are editorial copy, not a claim about the current
Even Hub submission form, field limits, or accepted categories. Recheck the
portal's requirements before submission. The companion's implemented behavior
and device validation must match the final description and screenshots.

## Suggested metadata

| Field | Suggested value |
| --- | --- |
| Full product title | Even Terminal for Codex Mac App Guide |
| Even Hub name (19 characters) | Codex Mac App Guide |
| Subtitle | Steer, Queue, and continue your Codex Mac App conversations on G2 |
| Short description | Learn to continue the same Codex Mac App conversation across Mac, Remote on iPhone, and G2 — with Steer and Queue on your glasses. |
| Category, if available | Utilities or Reference; select the closest category offered by the portal |
| Website | https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/ |
| Support | https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App/issues |
| Source | https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App |

## Full description

### One conversation. Mac, phone, glasses.

Work in **Codex Mac App**, continue with **Remote on iPhone**, and use the same
supported Mac conversation in **Even Terminal on G2**. The separate Mac bridge
adds **Steer / Queue** controls on the glasses: give Codex new context while it
works, or save another prompt for the next turn. Keep the same task when you
return to your desk, without a separate Codex CLI workflow.

**Even Terminal for Codex Mac App Guide is the small setup and reference companion.** It explains what
you need, how to install the Mac bridge, how to pair your phone, and where to find
help. Its glasses menu contains **Set up**, **Daily use**, **Troubleshoot**, and
**About**. The phone view provides explanations and documentation references;
copy a link into your browser when needed. Actual conversations and replies use
**Even Terminal**.

Installing this guide from Even Hub does not install Even Terminal for Codex Mac App on your Mac. The
Mac software is a separate download with its own compatibility checks.

### Steer now. Queue what's next.

The separately installed **Even Terminal for Codex Mac App** bridge adds:

- **Add prompt:** dictate while Codex keeps working on your Mac.
- **Steer:** add context to the response in progress.
- **Queue:** save up to ten prompts per conversation for later turns, in order,
  with waiting prompts retained across bridge restarts.
- **View queue:** read drafts, remove items, pause/resume, or clear waiting work
  directly from your glasses.
- **Stop response:** stop the active work and pause waiting prompts.

Use the normal long press, confirm **Yes**, choose **Add prompt**, then dictate
with a second long press. Choose **Steer** or **Queue** after capture. Ordinary
idle follow-ups send directly. This is an explicit glasses control flow added
by the bridge to the pinned Even Terminal 0.10.4; stock 0.10.4 already has an
automatic internal queue, but not this bridge's menu and persistent queue workflow.

The bridge queue is independent of the Mac App's native queue. Prompts appear in
the shared Mac/Remote conversation when sent. Remote must already be set up to
access the Mac and is not a relay in the glasses connection. Create new
conversations on the Mac or Remote first; New session from the glasses is not
supported through this connection.

### Integrated with the Codex Mac App

Even Terminal for Codex Mac App connects Even Terminal to the task engine already used by the Codex
Mac App. It can reopen supported local conversations and their history, show
public progress and final answers, send follow-ups, and handle supported
questions and approval choices. Some controls still need the Mac App.

The Mac control window provides service status, pairing, launch-at-login
settings, and text preferences: message timestamps, live progress updates, and
paragraph spacing. The original text presentation remains the default.

These are features of the separately installed **Mac bridge**. This Hub guide
does not read the Mac's live status, run an AI agent, send prompts, or replace
Even Terminal.

### Get started

1. [Check the requirements](https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/#requirements).
   You need a compatible Mac, your Codex account, Even G2, and the Even Realities
   phone app. Follow Even's Terminal setup for the glasses and R1 ring.
2. [Connect the Mac and phone](https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/#network).
   Tailscale is the guided first-setup option. An existing valid Even Terminal
   Codex LAN or named-interface profile can be preserved.
3. [Install Even Terminal for Codex Mac App on your Mac](https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/#install).
   Download the source ZIP, expand it, and open **Install Even Terminal for Codex Mac App.command**.
   The current public alpha builds locally using Apple's developer tools.
4. [Pair your phone](https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/#pair).
   Open **Even Terminal for Codex Mac App → Connect** on the Mac and scan its private QR code in the
   Even Realities app's **Terminal Mode**. Keep that QR code private.
5. [Open a familiar conversation](https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/#first-use)
   in Even Terminal. Keep your Mac logged in and awake, with the Codex Mac App and your
   configured network available.

### Check compatibility before installing

**Guide companion:** the SDK used by this companion requires the Even Realities
phone app **2.2.9 or later**. This SDK requirement is separate from the Mac
bridge's device-validation record below.

The Mac bridge is a **public alpha**. The reviewed combination is:

- **macOS 14 or later**, with Apple Silicon as the reviewed setup.
- **Codex Mac App 26.915.31945, build 9922**. The supported application identity
  may be installed as `Codex.app` or `ChatGPT.app`.
- **Even Terminal for Codex Mac App** bridge **0.3.2**, Mac control app **1.1.5**, pinned Even Terminal **0.10.4**,
  and Node **26.9.0**.
- Apple's Command Line Tools with **Swift 6 or later and Python 3** for the
  current source installation. There is no Apple-notarized ready-made download.

The Codex Mac App connection uses a private protocol. A different Codex Mac App version needs
review before it is supported; the installer checks compatibility. Consult the
[current compatibility record](https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App/blob/main/compatibility.json).

The Mac bridge project targets **Even G2**. Its exact minimum G2 firmware and
Even phone-app versions have not been certified. Physical validation of the Mac
bridge's Tailscale setup does not certify this separate Hub companion or every
device combination.

### Your network can stay yours

Tailscale is the physically reviewed Mac bridge setup and supports devices on
different networks. An existing valid LAN or named-interface profile does not
require Tailscale, but those routes have not been physically validated with this
project's phone/glasses flow. The app does not independently verify their
reachability. Guided setup and QR generation do not support public-tunnel
profiles.

If a LAN/interface address changes, finish the current interaction, restart the
bridge when safe, and then show and scan a new pairing QR. Read the
[network guide](https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App/blob/main/docs/network-options.md)
before changing an existing setup.

### Privacy and support

The guide provides instructions and links. It does not need your pairing token
or access to your Codex conversations. Pair directly between your phone and the
Mac bridge. The Mac bridge runs locally; Codex retains its normal account and
cloud behavior. Opening documentation or support links uses the linked service.

For help, start with the [troubleshooting guide](https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/#help)
or [report an issue on GitHub](https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App/issues).
Include relevant software versions and the safe diagnostic summary. Do not post
pairing codes, tokens, raw logs, or private conversation text.

This is an independent community project, not an official OpenAI or Even
Realities product.

## Suggested screenshot captions

Use real captures of the finished companion. Do not show the Mac bridge UI as
though it were part of the Hub app, and never capture a real pairing QR.

1. **One conversation across Mac, Remote, and G2** — The guide explains how the separate Mac bridge connects your devices.
2. **Follow the setup checklist** — Requirements, Mac installation, and pairing.
3. **Learn Steer and Queue** — A daily-use reference for adding context now or
   saving prompts for later; these controls run in Even Terminal with the Mac bridge.

## Submission review notes

- Use **Codex Mac App Guide** in the 20-character portal name field and the full
  **Even Terminal for Codex Mac App Guide** title in the description. Keep **Guide** in the name and the separate-Mac-installation explanation near
  the beginning. Do not present this as a Terminal replacement or a standalone
  Codex client.
- Verify all companion claims above against the packaged app and physical
  phone/glasses behavior before submitting. Record that validation separately
  from Mac bridge checks.
- Recheck the current portal fields, category choices, text limits, asset
  requirements, privacy questions, and review rules. This file does not establish
  that a guide companion is eligible for publication.
- If a privacy-policy URL is required, provide the companion's actual published
  policy after reviewing its implementation and hosting. The privacy paragraph
  above is listing copy, not a substitute for that review.
- Keep compatibility versions synchronized with the repository's reviewed release.
  Do not claim compatibility with the newest Codex app automatically.
