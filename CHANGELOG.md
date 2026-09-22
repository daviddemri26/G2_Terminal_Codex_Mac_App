# Change log

## Control app 1.1.2 / bridge 0.2.9 — 2026-09-21

- Compact elapsed timestamps: `[2s]` below a minute, then `[1:04]`, including
  public activity, final answers, and reopened history.

- Show additional public activity in the dim native rows: brief activity headings,
  explicit subagent lifecycle updates, and grouped file-reading, search, and
  command activity when the desktop provides the required metadata.
- Add compact file-change summaries, with line totals only when the available
  diff supports reliable counting; otherwise show the file count alone.
- Keep activity rows out of the final answer, suppress repeated observations,
  and apply the existing **Live progress updates** preference to the added rows.
- Keep Text settings available for both 0.2.9 and the previous 0.2.8 runtime.
  The control app includes the updated version gates.

Offline and installed-service checks passed. Physical-device validation of the
additional rows remains pending. See the [0.2.9 validation record](docs/validation-0.2.9.md)
for the separate results.

## Control app 1.1.1 / Even Hub guide 0.1.1 — 2026-09-21

- Rename the Mac application and source installer to **Even Terminal for Codex Mac App**.
- Use **Even Terminal for Codex Mac App Guide** for the optional Even Hub setup
  companion, shortened to **Codex Mac App Guide** in the Hub manifest, phone
  masthead, and native menu to meet the store's naming rules.
- Update application labels, documentation, and the setup website to explain
  the audience and purpose directly. Existing repository links remain unchanged.
- Preserve the bridge runtime 0.2.8, service identities, and private data paths.
  This is a product-name change, not a network or conversation migration.

## Control app 1.1.0 / bridge 0.2.8 — 2026-09-21

- Add Text settings for timestamps, public progress updates, and paragraph spacing.
  Preserve the 0.2.7 reading experience as the default and keep interactive requests
  and code intact. Settings apply at the next response or reopened history.
- Add a Connect page with an explicitly revealed local pairing QR code and a
  beginner-friendly English GitHub Pages guide.
- Add a guided source installer, private checksum-verified Node download when
  needed, fresh configuration creation, and reuse of supported existing network
  profiles. No separate Codex CLI task engine is installed.
- Default the window app to `/Applications`, while keeping service data per user.
- Show the configured network type, with no changes to its transport. Distinguish
  unverified local-network configuration from the reviewed Tailscale probe.
- Recognize supported desktop builds under either ChatGPT.app or Codex.app in
  standard Applications folders; reject conflicting installed versions.
- Discover Tailscale's existing app-bundled CLI without creating global launchers.
- Provide an optional bounded update command that waits for an idle bridge and
  cancels if the installation or complete candidate changes.

See the [validation record](docs/validation-0.2.8.md) for test results and limits.

## Control app 1.0.0 / repository organization — 2026-09-21

- Establish one source repository with architecture, usage, development,
  maintenance, migration, and provenance documentation.
- Rebuild bridge 0.2.7 from locked Even Terminal 0.10.4 and a reviewed three-file
  patch, without depending on a previously modified global installation.
- Separate source, build artifacts, installed current/previous releases, and
  private configuration/state.
- Add a native macOS control app with a Dock icon, local status, service controls,
  launch-at-login preference, diagnostics, and previous-release rollback.
- Keep the background service independent of the control window and preserve the
  existing pairing and delivery state through managed updates.

These entries describe source changes. Installation and physical-device validation
are separate from the source version and must be recorded when performed.

## Bridge 0.2.7 — imported baseline

- Preserve intermediate public messages in the dim native activity presentation,
  with inline timestamps and no added dash separators.
- Preserve final text timestamps and paragraph breaks, reply correlation,
  deduplication, durable delivery confirmation, and replay behavior.
- Preserve the existing Mac app task engine and managed-service recovery model.

See [import provenance](docs/provenance/import-0.2.7.json) and the
[client contract](client-contract/README.md) for historical validation and limits.
