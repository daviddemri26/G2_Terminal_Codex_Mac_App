# Working on Even Terminal for Codex Mac App

## Scope and source of truth

- Make source changes in this repository. Do not develop in old dated task
  folders, global npm packages, `.build/`, or installed release directories.
- Preserve the working installation, pairing configuration, delivery journal,
  and previous release while preparing changes. Do not delete earlier source
  folders as part of a cleanup or migration.
- Read `README.md`, `compatibility.json`, and the relevant guide in `docs/` before
  changing runtime behavior or installation. The private desktop protocol is
  version-sensitive; do not guess compatibility or bypass version/integrity gates.
- Authorized maintenance within the user's requested scope can proceed without
  another confirmation. Respect explicit boundaries such as source-only, no
  restart, no install, or no push. Do not invent additional approval stages.

## Build and validation

- Restore dependencies with `npm ci --ignore-scripts`; use `npm run check` for the
  offline build and test suite. Test in the repository before changing live state.
- Build from the pinned upstream package and `integration/` patch, never from an
  unknown globally modified package. Keep package-lock and compatibility metadata
  consistent when deliberately reviewing a dependency upgrade.
- Use the managed control/installation commands for lifecycle changes. They check
  idle state, pending delivery, ownership, and release integrity. Do not replace
  these with broad process kills or direct edits to `control.json`.
- A live prompt requires explicit authority for that test and the intended task.
  `tests/manual/http_bridge.py` is opt-in and sends a real prompt. Ordinary tests,
  status reads, and diagnostics must never send prompts or create tasks.
- Report offline results, installed-service checks, and physical phone/glasses
  checks separately. Do not equate a successful build or local ready status with
  end-to-end device validation.

## Product and privacy conventions

- Keep the native UI simple, in English, with clear statuses and a small number of
  useful controls. Closing the UI must not stop the independently managed service.
- Reuse the engine owned by the Mac app. Never silently start a separate Codex
  engine or fall back to the stock upstream Codex provider.
- Preserve reply correlation and durable delivery records. Never clear a journal
  to force a retry or automatically resend a mutation after uncertain delivery.
- Never commit tokens, pairing URLs, private task IDs, local configuration, raw
  logs, journals, extracted Mac application code, or installed dependencies.
  Use synthetic identifiers and sanitized fixtures in tests and documentation.
- Use home-relative examples in documentation. Keep generated artifacts under
  ignored build paths. Preserve upstream notices and do not invent a project or
  dependency license.
- Keep implementation changes focused and update the relevant documentation.
  Use a branch per change; tag a release only when its validation is recorded.
