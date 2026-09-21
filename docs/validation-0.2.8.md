# Validation: bridge 0.2.8 / control app 1.1.0

Historical record: this release used the name **G2 Bridge**. The current product
name is **Even Terminal for Codex Mac App**; former names and installation paths below
are preserved as evidence of that release.

Recorded on 21 September 2026. This distinguishes source checks from installation
and physical-device validation.

## Offline checks

- 129 Node unit tests, 6 integration/replay tests, 92 Python operations tests, and
  26 Python build/installer/update tests passed: **253 tests**.
- The native app compiled with Swift 6 strict concurrency, passed its control
  tests, and passed local code-signature verification. This is an ad-hoc local
  signature, not Apple notarization.
- The official Apple Silicon Node 26.9.0 archive was downloaded, checked against
  the pinned checksum, and executed from an isolated build directory.
- The tutorial was checked at desktop and mobile widths. Its formatting preview,
  reset controls, relative links, and anchors worked; JavaScript syntax passed.

## Installed-service checks

The guarded manager installed 0.2.8 on the existing Apple Silicon development Mac.
It reported `ready`, verified the current runtime and previous 0.2.7 runtime, and
confirmed Codex Mac app 26.915.31945 (build 9922) and the Tailscale connection.
The pairing configuration's checksum and enabled launch-at-login preference were
unchanged. No private configuration or checksum is published here.

The control window was installed at `/Applications/G2 Bridge.app` and opened.
Overview, Text, and Connect were inspected. Changing all three text settings and
saving persisted the selected values; resetting and saving restored timestamps
on, progress updates on, and original paragraph spacing. These remain the active
defaults. Pairing-code behavior was tested with synthetic data; the real private
QR code was not captured or published.

## Limits

- No new task prompt was sent through the live bridge during this release check.
- No new phone/glasses session or login/reboot test was performed. Local readiness
  and a configured LaunchAgent are not proof of physical end-to-end connectivity.
- LAN and named-interface profiles were covered by isolated setup/pairing tests,
  not physical device tests. Automatic address-change recovery for these modes
  remains outside this release.
- A complete first install on a clean second Mac remains unverified. Installer
  logic and prerequisite/download behavior were tested in isolation.
- Exact phone-app and G2 firmware versions remain unrecorded. Intel binaries are
  available from the pinned official Node source, but this Mac app's Intel
  execution has not been validated.

GitHub Actions provides the separate clean-run build/test result for each pushed
commit. GitHub Pages deployment status is separate from these source checks.
