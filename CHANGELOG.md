# Change log

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
