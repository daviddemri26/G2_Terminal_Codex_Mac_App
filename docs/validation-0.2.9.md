# Validation: bridge 0.2.9 / control app 1.1.2

Prepared on 21 September 2026 for **Even Terminal for Codex Mac App**.
This record separates offline checks, installed-service verification, and
physical phone/glasses behavior.

## Scope

The release adds display-only activity rows for public headings, explicit
subagent lifecycle events, grouped actions, and compact file-change summaries
with line totals only when reliable. It also updates release gates while preserving
Text settings and rollback compatibility with bridge 0.2.8.

## Offline checks

`npm run check` passed after the final source changes: **306 tests** in total.

- 168 Node unit tests, including 19 file-summary cases.
- 7 runtime replay integration tests.
- 93 operations tests.
- 38 build and installer tests.

The runtime was rebuilt from the pinned upstream package and integration patch.
Coverage includes public activity helpers, provider ordering and deduplication,
replay retention, hidden-progress behavior, operations/version gates, and
reproducible runtime packaging.

Regression checks cover withdrawn activity, reconnects after final text begins,
and unknown timestamps on reopened tasks. File statistics use validated net
changes where available; repeated or incomplete operations omit uncertain line
totals. Failed or pending file changes do not count as successful modifications.

The native control app 1.1.2 build, focused Swift checks, and local signature
verification passed. The app was installed with the managed installer and reopened.

## Installed-service checks — passed

The complete bridge 0.2.9 candidate was installed using `operations/manage.py`
after reviewing its non-mutating plan. The guarded manager completed successfully
and reported configuration preservation. The control app is installed at 1.1.2.

The post-install diagnostic reported **ready**, compatible desktop, supported Text
settings, verified active and previous runtimes, and no difference between the
installed runtime and the built candidate. Private before/after comparisons
confirmed unchanged pairing and preferences. The managed update retained its
normal delivery-journal and rollback handling; no journal reset, prompt, question
reply, approval, or interruption was sent as part of validation.

The physical glasses connection was not measured by these local checks.

## Physical phone/glasses checks — pending

No physical validation of the additional activity rows is recorded yet. Existing
checks of dim commentary and final-answer rendering do not establish the new
rows' ordering, wrapping, or subagent presentation. Any future live
prompt must have explicit authorization for that test and its target task.

## Compatibility boundary

The reviewed dependency combination remains Even Terminal 0.10.4, Node 26.9.0,
and Codex Mac App 26.915.31945 (build 9922). This release does not expand supported
desktop builds, phone-app versions, G2 firmware versions, or network certification.


## Compact timestamp follow-up

The follow-up uses seconds below one minute (`[2s]`, `[54s]`) and total minutes
with padded seconds from one minute (`[1:04]`, `[26:45]`, `[62:03]`). It covers
public activity, final headers, and reopened history through the shared formatter.
The complete offline build and the same 306 tests passed after this change,
including the 59-to-60-second boundary. No operations or native app change is
needed. Physical rendering has not been rechecked.

The bounded idle installer completed the timestamp update. Its managed result
reported `complete`. Fresh diagnostics then confirmed **ready**, compatible
desktop, verified active and previous runtimes, and no difference between the
installed runtime and the tested timestamp candidate. The previous release remains
available for rollback. No live prompt or physical glasses test was performed.
