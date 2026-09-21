# Candidate validation — 21 September 2026

Candidate: **G2 Bridge Guide 0.1.0**. This record concerns the guide companion,
not a new release of the Mac bridge.

## Passed

- Ten isolated navigation/controller tests using the actual SDK container
  validator and mocked native calls. Includes first-item selection, invalid
  events, back/exit behavior, failed updates, serialized transitions, and lifecycle.
- Strict TypeScript checking and production Vite build.
- Official CLI 0.1.14 packaging with SDK 0.0.14 explicitly selected. The generated
  `.ehpk` declares minimum Even phone app 2.2.9; its source manifest requests no
  permissions. No package-ID check, login, or submission was performed.
- The official simulator initialized the SDK and rendered the phone WebView.
  The captured phone screen was inspected. Its status describes SDK initialization,
  not verification of a physical device or the Mac bridge.
- The icon contains only binary pixels on a 2×2 grid at 24×24. The proposed
  grayscale background remains subject to the portal's crop/size requirements.

## Not completed

The simulator glasses-framebuffer capture returned a solid green image. The Mac
was found locked when attempting visual inspection. That image was excluded from
the submission materials. Native menu/detail legibility and the visible exit
dialog have therefore **not been visually verified**. Do not submit a blank image
or describe mocked tests as genuine rendered screenshots.

Physical G2 navigation, the real phone WebView, locked-phone operation,
background/resume, and private package installation have not been tested.
Package-ID availability, account fields, portal-specific text/image limits, and
a published privacy URL remain to be completed before public submission.

The existing Mac application, background service, Tailscale configuration,
pairing token, delivery journal, and installed runtime were not changed by this
companion preparation. No live task prompt was sent.
