# Even Terminal for Codex Mac App Guide — Even Hub preparation

**Draft candidate, not submitted or listed.** This folder prepares a small,
useful companion for discovering and setting up Even Terminal for Codex Mac App. It does not install
the Mac application or replace Even Terminal.

The official publishing flow requires an application package. No listing-only
route was found in the public documentation. The proposed companion therefore
provides short setup, daily-use, and troubleshooting references on the glasses,
plus explanations and reference links in its phone view. Store acceptance is
still Even Realities' decision.

## Prepared materials

| File | Use |
| --- | --- |
| [Listing text](listing.md) | English title, descriptions, audience, requirements, and links |
| [Privacy notice](privacy.md) | Companion-specific draft to publish at a stable URL |
| [Review instructions](review-notes.md) | Explain and test this guide independently of the Mac bridge |
| [Validation record](validation.md) | Passed checks, unavailable visual checks, and remaining device tests |
| `create-assets.py` | Generates an original icon and proposed background under `.build/even-hub-assets/` |
| [Companion source](../../even-hub/) | Separate npm project; no changes to the installed Mac service |

The Mac product is **Even Terminal for Codex Mac App**. The Hub title is
**Codex Mac App Guide** (19 characters), within the documented 20-character limit.
The [Even Hub submission rules](https://hub.evenrealities.com/docs/ship/app-submission)
also prohibit “Even” in the manifest app name. That short name is therefore used
consistently in the manifest, phone masthead, and native menu.
The full guide title is **Even Terminal for Codex Mac App Guide**.
Its subtitle is **Setup guide for the Codex Mac app and Even Terminal**. A user
installing it should expect a reference guide. Conversation discovery and
interaction belong to Even Terminal connected to the separate Even Terminal for Codex Mac App application.

## Publication checks still needed

1. Build and inspect the candidate using the companion's README. Use the pinned
   SDK version when packing so the phone-app floor is derived correctly.
2. Test on physical G2 glasses, including navigation, exit confirmation,
   background/resume, and use while the phone is locked.
3. Sign in to the publisher portal using the account created in the Even phone
   app. Confirm the proposed package ID is available and record publisher/contact
   details. No account action has been taken by this preparation.
4. Confirm actual portal field lengths, category, foreground/background formats,
   and image cropping. Public docs do not specify every portal field.
5. Publish the reviewed privacy notice at a stable public URL, then provide it in
   the portal. The existing setup-guide and support URLs are already public.
6. Upload for private testing first. Review the actual form and package before
   choosing the public submission action.

No token, Mac address, login, or conversation access is needed to review this
guide. Do not include personal pairing QR codes or conversation screenshots.

## Official references checked on 21 September 2026

- [Publishing and QA](https://hub.evenrealities.com/docs/ship/app-submission):
  packaged app, review lifecycle, naming, genuine captures, privacy and device QA.
- [Manifest and packaging](https://hub.evenrealities.com/docs/ship/packaging):
  `.ehpk` format and SDK-derived phone version.
- [Store icon](https://hub.evenrealities.com/docs/build/design-guidelines#the-store-icon):
  24×24 binary icon drawn on a 2×2 grid.
- [Simulator](https://hub.evenrealities.com/docs/test/simulator):
  HUD framebuffer capture and limits of simulated testing.
- [SDK FAQ](https://hub.evenrealities.com/docs/reference/faq#networking):
  no supported system-browser/deeplink equivalent; URLs remain readable references.
- [Publisher sign-in](https://hub.evenrealities.com/docs/get-started/quickstart/sign-in):
  use the account created in the Even phone app.

The proposed icon is original project artwork. The background is a draft, not a
glasses screenshot. Only files explicitly identified as simulator captures
should be used as application screenshots.

Generated images and packages remain under ignored build paths. Run
`python3 distribution/even-hub/create-assets.py` from the repository root to
recreate the icon and background. A phone WebView capture is a review aid, not a
substitute for a legible glasses framebuffer capture.

After building the `.ehpk`, run `python3 distribution/even-hub/package-submission.py`
to collect the current draft copy, assets, validation record, and app into one
local ZIP under `.build/`. This script never uploads or contacts the store.
