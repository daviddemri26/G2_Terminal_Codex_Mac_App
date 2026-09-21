# Do I need Tailscale?

**For a new guided setup, Tailscale is the default. An existing LAN or named-interface
configuration can be preserved without requiring it.** Even Terminal can connect a phone to a Mac
on the same local network. G2 Bridge preserves a valid existing Codex profile
instead of changing its network or pairing credential. Tailscale remains the
physically reviewed path here and also works across different networks.

This is a research and compatibility note, reviewed on **21 September 2026**.
It does not switch an existing installation or add a network selector to the app.

## Choose the connection that fits

| Connection | What you need | Advantages | Limits in G2 Bridge today |
| --- | --- | --- | --- |
| **Tailscale — current guided setup** | Tailscale on both Mac and phone, connected to the same private network | Stable private address; encrypted device connection; can work away from home | An extra app and account on both devices; access rules must allow the connection |
| **Same Wi-Fi / LAN — existing profiles** | Phone and Mac on a network that permits device-to-device traffic | No additional network account; useful at home | Existing valid profiles and QR pairing supported in software; not physically validated here; address can change; guest Wi-Fi may isolate devices; HTTP has no TLS |
| **Another private VPN / named interface** | A route from the phone to the Mac and a reachable interface | Could fit an existing private network | Existing named-interface profiles can be preserved; VPN routing and device behavior not reviewed |
| **Public tunnel** | A tunnel provider and its configuration | Can expose a host outside its local network | Existing expose profiles are refused by guided setup/QR; current public URL cannot be safely inferred; advanced review needed |

Tailscale establishes the private connection; the bridge still has to be running
on the Mac. It does not replace Codex or keep a sleeping Mac awake. Both devices
must be authorized in the same tailnet, and its access policy must permit the
phone to reach the Mac's bridge port (normally TCP 3456).
See [Tailscale: connecting devices](https://tailscale.com/kb/1452/connect-to-devices)
and [Tailscale encryption](https://tailscale.com/docs/concepts/tailscale-encryption).

## What was verified in the source

The published **Even Terminal 0.10.4** package already supports `lan`, `tailscale`,
`interface`, and `expose` configuration modes. Its `resolveHost()` selects a private
IPv4 address for LAN, a Tailscale address, or the chosen interface. The server
binds to that address and also opens a loopback listener for local management.
Protected API requests require the pairing token. The transport is HTTP; the
token authenticates requests but does not itself encrypt network traffic.

The local desktop connection is independent of that network choice. It connects
the bridge to the Mac app on the same computer. **It is therefore technically
plausible to use this desktop bridge over LAN without changing the Codex adapter.**
That conclusion comes from the code; a physical LAN phone/glasses test has not
been performed for this project.

The managed supervisor currently checks the Tailscale IPv4 address explicitly.
For another configured mode, its network check returns a generic placeholder:
it does not verify the LAN interface or detect its address changes. The status
window therefore labels those connections as configured rather than independently
checked. Existing source support is not the same as a physically validated LAN
connection with automatic recovery after every address change.

Relevant source: [supervisor](../operations/supervisor.py),
[controller](../operations/control.py), and the pinned upstream files
`bin/config.js`, `dist/startup/common.js`, and `dist/index.js` described in
[the integrity record](../integration/upstream.json).
The [official npm package](https://www.npmjs.com/package/@evenrealities/even-terminal)
documents its network modes; [version 0.10.4 metadata](https://registry.npmjs.org/@evenrealities/even-terminal/0.10.4)
identifies the exact package reviewed here.

## Existing profiles and pairing

The guided installer accepts an existing valid Codex configuration with `lan`,
`tailscale`, or a named `interface`. It preserves the selected network, token, and
working folder. A first configuration defaults to Tailscale. The Connect screen
can create a pairing QR for the currently resolved LAN/interface address only
after an authenticated check of the running bridge. It does not start a second
host. The running bridge does not automatically bind to a changed LAN/interface
address. If that address changes, finish the current interaction, use **Restart**
in G2 Bridge when it is safe and available, then show and scan the new pairing QR
code. Refreshing the QR alone does not move the running service to the new address.

The helper refuses an existing `expose` profile rather than guessing a public
URL or replacing the user's tunnel. Such a setup requires separate review. No
network selector or automatic migration is introduced.

## What a fully managed LAN option would need

Before presenting a simple “Same Wi-Fi” option, we would add accurate interface
and reachability checks, explain the local address in pairing, detect address
changes, and test reconnection after sleep and Wi-Fi changes. We would also check
the phone's local-network permission, Mac firewall behavior, guest-network
isolation, and the handling of pairing credentials on an unencrypted local link.

The best initial scope would be a trusted home LAN, with an explicit explanation
that the connection stops working when the phone leaves that network. Other VPNs
and public tunnels should be evaluated separately. No network configuration has
been changed as part of this research.

## Official setup references

- [Even Realities Terminal Mode](https://www.evenrealities.com/terminal): phone/glasses pairing and controls.
- [Tailscale quickstart](https://tailscale.com/docs/how-to/quickstart): connect your own devices.
- [Tailscale on macOS](https://tailscale.com/docs/concepts/macos-variants): choose and install a Mac variant.
- [Tailscale on iOS](https://tailscale.com/docs/install/ios) or [Android](https://tailscale.com/docs/install/android): phone installation.

The vendor pages may describe newer releases. G2 Bridge's supported combination
is always the one recorded in [compatibility.json](../compatibility.json).
