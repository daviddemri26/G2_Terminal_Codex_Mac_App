# Candidate validation — 21 September 2026

Candidate: **Even Terminal for Codex Mac App Guide 0.1.1**. This record concerns the guide companion,
not a new release of the Mac bridge.

## Documentation revision — 22 September 2026

The unpublished 0.1.1 guide candidate now explains Steer / Queue and continuity
between Codex Mac App, Remote on iPhone, and G2. Phone and native reference copy
changed; runtime controls and permissions did not. Earlier package/capture results
below apply to their recorded snapshot, not this revised text. Rebuild and obtain
current physical captures before submission.

For this text revision, all ten guide tests, strict TypeScript checking, and the
production Vite build passed again. The setup website was also inspected at
desktop and phone widths; local anchors resolved and the phone layout had no
horizontal overflow. These browser checks are not physical G2 validation.

## Passed

- Ten isolated navigation/controller tests using the actual SDK container
  validator and mocked native calls. Includes first-item selection, invalid
  events, back/exit behavior, failed updates, serialized transitions, and lifecycle.
- Strict TypeScript checking and production Vite build.
- Official CLI 0.1.14 packaging with SDK 0.0.14 explicitly selected. The generated
  `.ehpk` declares minimum Even phone app 2.2.9; its source manifest requests no
  permissions. No package-ID check, login, or submission was performed.
- The icon contains only binary pixels on a 2×2 grid at 24×24. The proposed
  grayscale background remains subject to the portal's crop/size requirements.

## Not completed

The previous 0.1.0 candidate initialized the SDK in the official simulator and
rendered its phone WebView; that phone capture was inspected. Its glasses-framebuffer
capture returned a solid green image while the Mac was locked. The renamed 0.1.1
candidate has passed automated checks, but its rendering has not been visually
verified. The old captures are excluded from this candidate's submission package.
Native menu/detail legibility and the visible exit dialog have therefore **not
been visually verified**. Do not submit a blank image or describe mocked tests as
genuine rendered screenshots.

Physical G2 navigation, the real phone WebView, locked-phone operation,
background/resume, and private package installation have not been tested.
Package-ID availability, account fields, portal-specific text/image limits, and
a published privacy URL remain to be completed before public submission.

Guide preparation does not change the Mac application or service. The separate
Mac control app 1.1.1 rename preserves the background service, Tailscale profile,
pairing token, delivery journal, and installed runtime. No live task prompt was sent.
