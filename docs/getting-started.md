# Set up Even Terminal for Codex Mac App

Even Terminal for Codex Mac App is for **Even G2 owners who use Even Terminal and the Codex Mac App**.
You can keep working in that Mac App, then find and continue the same supported
conversation from your glasses or **Remote on iPhone**. Add context with **Steer**
or save another request with **Queue**, directly from G2. You do not need a
separate Codex CLI workflow. [Explore the features](features.md).

This guide takes you through the current public alpha. Installation uses a guided
source installer; it is not yet a signed, notarized app that works on every Mac
with one drag into Applications.

## 1. Check your starting point

You need an Apple Silicon Mac running macOS 14 or later, an existing Codex account,
Even G2 glasses paired with the Even Realities phone app, and the R1 ring used by
the vendor's Terminal setup.

Open the Mac App and check its About window: the reviewed combination is
**26.915.31945, build 9922**. The installer recognizes the supported application
identity in `Codex.app` or `ChatGPT.app`, in Applications or your user
Applications folder. It checks the actual version and build. Consult [compatibility.json](../compatibility.json) before
installing if your app is newer or older.

If the version is different, stop here and check for a reviewed Even Terminal for Codex Mac App update.
Do not bypass the compatibility check or obtain old Mac App builds from unknown
download sites. The [official Mac App guide](https://learn.chatgpt.com/docs/app)
explains OpenAI's app; its newest download is not automatically supported by this
bridge.

**Glasses versions:** the project was developed for Even G2 and tested through the
author's phone/glasses setup. An exact minimum firmware or Even phone-app version
has not been certified. Other glasses models are not claimed as compatible.

## 2. Connect the Mac and phone

For the guided first setup, install Tailscale on both devices and sign in to the
same private network. Turn the connection on on both devices. Tailscale is the
private link that lets the phone reach the bridge, including when the devices are
on different networks.

Use the vendor's instructions:

- [Mac installation choices](https://tailscale.com/docs/concepts/macos-variants)
- [iPhone installation](https://tailscale.com/docs/install/ios)
- [Android installation](https://tailscale.com/docs/install/android)
- [First connection walkthrough](https://tailscale.com/docs/how-to/quickstart)

Follow Tailscale's normal macOS network-extension and VPN permission prompts.
The installer discovers the installed Tailscale app or its command-line helper;
no separate global helper installation is needed. It explains missing
prerequisites rather than changing your network behind the scenes.

You do not need an exit node, public tunnel, or router port forwarding for this
setup. If your tailnet uses custom access rules, they must permit the phone to
reach this Mac's bridge port, normally TCP 3456.

**Already using Even Terminal with Codex over LAN or a named interface?** The
installer can preserve that valid configuration, including its network choice,
project folder, and pairing credential. Tailscale is not required for those
existing profiles. Their connectivity is not independently verified by the app,
and only the Tailscale route has physical phone/glasses validation here. Existing
public-tunnel profiles need advanced review and are refused by the guided setup
and QR flow because their current public address cannot be safely inferred. See
the [network guide](network-options.md). No network-mode switch is added.

If a LAN/interface address changes, finish the current interaction and use
**Restart** in Even Terminal for Codex Mac App when it is safe and available. Then show and scan a new
pairing QR code. Showing a new QR alone does not reconnect the running bridge to
the changed address.

## 3. Prepare the Mac once

The current installer builds Even Terminal for Codex Mac App on your own Mac. Apple's Command Line Tools
provide the compiler and Python it needs. Swift 6 or later is required; the
installer checks this and explains when Apple tools need an update. If these tools are missing, open the
Mac's **Terminal** application, paste this line, and press Return:

```sh
xcode-select --install
```

Finish Apple's installation dialog before continuing. This is a one-time setup
step in macOS Terminal; it does not install or run Codex CLI. If the tools are
already installed, you can continue.

The installer uses Node 26.9.0 to run the bridge. If that exact version is not
available, it obtains the official pinned download and checks its recorded
checksum. You do not have to set up Homebrew or install a global npm package.

## 4. Install Even Terminal for Codex Mac App

1. [Download this repository as a ZIP](https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App/archive/refs/heads/main.zip).
2. Double-click the ZIP to expand it. Keep the complete extracted folder together.
3. Open that folder and double-click **Install Even Terminal for Codex Mac App.command**.
4. Read the checks and follow the instructions in its window. It restores locked
   dependencies, runs offline tests, builds the app, and installs the background
   service and control window.
5. Open **Even Terminal for Codex Mac App** from Applications.

The first run needs internet access for the verified runtime and locked
dependencies. The app is built locally with a local signature; it is not Apple
notarized. If macOS blocks it because the developer is unverified, first check
that the installer came from this repository. After the blocked attempt, open
**System Settings → Privacy & Security → Open Anyway** for that specific file,
then confirm **Open** if you trust it. See [Apple's instructions](https://support.apple.com/en-us/102445).
Do not override a malware or damaged-file warning, or turn off system-wide security.

The standard destination is `/Applications/Even Terminal for Codex Mac App.app`, beside your other
apps. If that folder is not writable, the installer explains the per-user
alternative in `~/Applications`. Both are valid macOS app locations. The service,
credentials, and preferences remain private to your Mac user in either case.

For a first installation, sensible defaults create a private pairing credential,
use Tailscale and port 3456, and provide `~/Documents/G2 Projects` as a default
working folder. An existing pairing configuration is preserved. An existing
managed installation is not silently replaced by the first-install flow; use
the [maintenance guide](maintenance.md) for an update.

## 5. Pair in the Even Realities app

In **Even Terminal for Codex Mac App → Connect**, show the pairing QR code. On your phone, open the
Even Realities app, enable **Terminal Mode** in Settings, then scan that QR code.
Use the official [Even Terminal guide](https://www.evenrealities.com/terminal) for
the current phone screens, glasses pairing, and ring/voice controls.

Use **this bridge's QR code**. The vendor's generic host installation commands
describe its normal coding-agent workflow; you do not need to install and start
another host alongside Even Terminal for Codex Mac App.

The QR code contains a private connection credential. Show it only to your phone;
do not include it in a public screenshot or GitHub issue. You do not need to copy
the token or type an address manually.

## 6. Check that it works

1. Keep the Mac logged in and awake, with the Codex Mac App and the configured network available.
2. In Even Terminal for Codex Mac App, check the overview. A ready state means its local checks pass.
3. On the phone/glasses, select a Codex conversation whose title you recognize.
4. Confirm that the expected history appears. Send a harmless message only in a
   conversation you intentionally choose for this test.
5. Confirm that the reply appears in that same Codex Mac App conversation and on the glasses.

This last step validates your actual devices. Passing the installer tests or
seeing “ready” alone cannot prove the phone/glasses connection works.

## Make the text comfortable

Open **Even Terminal for Codex Mac App → Text**. The original presentation is selected by default.

| Option | Default | What it changes |
| --- | --- | --- |
| Message timestamps | On | Adds a fixed time label to assistant messages |
| Live progress updates | On | Shows public intermediate updates before the final answer |
| Paragraph spacing | Original | Choose Original, Compact, or Comfortable spacing between paragraphs |

Changes apply to the next response or when you reopen completed history. An
already active response keeps the settings it started with. Question and approval
content, user messages, and the underlying Codex Mac App conversation are unchanged.

These controls do not change native font size, display brightness, the client's
`tool end:` label, or the glasses' own wrapping. Adjust hardware display options
in the Even Realities app where available. Code-block whitespace is preserved.

## Everyday use

When the Mac is working, use **long press → Yes → Add prompt**, then a second
normal long press to dictate. Choose **Steer** to influence the current response
or **Queue** to save the prompt for later. **View queue** appears when messages
are waiting, with reading, removal, pause/resume, and clear controls.
When the conversation is idle, ordinary follow-ups send directly.
[Read the full control flow](usage.md#add-prompt-and-queue--bridge-032).

Use **Remote in the Codex phone app** to access the same Mac tasks when convenient.
Remote has its own setup and connection; it is not needed as a relay for the
glasses. Create new conversations on the Mac or Remote first, then select them
in Even Terminal. **New session** on the glasses is not supported by this bridge.

Leave **Launch at login** enabled if you want the bridge to start whenever you
sign into this Mac. It does not launch Codex or Tailscale for you, prevent sleep,
or run before login. Closing or quitting Even Terminal for Codex Mac App leaves the background service
running.

To keep the control window handy, right-click its Dock icon and select
**Options → Keep in Dock**. Use the same conversations on Mac, Remote, and glasses; there
is no second copy of your task engine to manage.

## If something needs attention

| What you see | First thing to do |
| --- | --- |
| Waiting for the Mac App | Open the reviewed Mac App and wait for it to finish starting |
| Waiting for the network | Check the configured network on both Mac and phone |
| A different Mac App version | Check this project's compatibility record and reviewed releases |
| Ready, but the phone cannot connect | Check both network connections, their access rules, and pairing |
| An action unavailable on the glasses | Complete that action in the Mac App; not every native control is supported |
| Delivery needs confirmation | Inspect the Codex Mac App conversation before retrying; do not resend blindly |
| Installation needs attention | Open Maintenance → Check Installation and follow the reported action |

For an issue report, include your Even Terminal for Codex Mac App version, macOS, Mac App version/build,
Even phone-app version, and G2 firmware version. Include only the safe diagnostic
summary, never the pairing QR, token, raw logs, or private conversation text.

For technical details, see [architecture](architecture.md),
[development](development.md), [maintenance](maintenance.md), and
[the supported interaction contract](../client-contract/README.md).
