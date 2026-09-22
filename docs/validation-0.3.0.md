# Validation: bridge 0.3.0 / control app 1.1.3 build 5

Candidate prepared on 21 September 2026 for **Even Terminal for Codex Mac App**.
This record separates offline tests, installed-service checks, and physical
phone/glasses behavior. No pending section is a success claim.

## Scope

Stage 1 adds an **Add prompt** prototype after Even Terminal's native interrupt
confirmation (**Yes** remains). The bridge offers **Add prompt**, **Stop response**,
or **Keep working**. Temporary client input leaves the actual Mac turn running;
captured text is a local draft until **Steer** is explicitly selected. **Cancel**
discards it. If the observed turn has finished, a fresh **Send prompt** / **Cancel**
preview is required before starting a follow-up. Timeout, a native-interaction
collision, or a replaced turn closes local input without sending the draft.
A durable per-conversation guard requires preview confirmation for later prompts
after the first Add prompt, including after reconnects and restarts; the stock
prompt route does not provide a draft identity token.

**Queue** / queue behavior is deferred until physical voice
capture is demonstrated. Existing question/approval correlation, durable delivery
checks, Text settings, public activity, and compact timestamps remain required.
This release does not reproduce every native client control.

## Offline checks — passed

The final `npm run check` passed: **352 tests** in total.

- 208 Node unit tests, including 14 synthetic local-interaction provider cases.
- 13 runtime replay integration tests, including SSE reconnect and local-state isolation.
- 93 operations tests.
- 38 build and installer tests.

Coverage includes correlated choices, exact draft capture, cancel without native
mutation, duplicate/concurrent input, same-turn and native-question races at the
final IPC refresh, persistent review guards, save failures, timeout/restart
recovery, and final delivery before the true idle event. The real task remains
busy for maintenance even while the glasses receive a temporary input-ready state.
Local menus are removed from replay when closed. Draft acknowledgements explicitly
say `draft: true, sent: false`; the prompt route logs character counts only.
Additional isolated handler checks exercised draft and normal HTTP responses
without a network listener or live task.

The runtime was rebuilt from the pinned upstream package and exact integration
patch; the pristine dependency was unchanged. The control app 1.1.3 build 5,
focused Swift checks, and local signature verification also passed.

## Installed-service checks — passed

The managed app installer installed 1.1.3 build 5 with the prior application saved.
The managed runtime installer installed bridge 0.3.0 after its reviewed dry plan
and ordinary idle, delivery, ownership, compatibility and integrity checks.
It reported `complete` and `configurationPreserved: true`.

Fresh diagnostics confirmed **ready**, compatible desktop, verified active and
previous runtimes, and no difference between the installed runtime and the tested
build. The previous bridge 0.2.9 remains available for managed rollback. Private
before/after comparisons confirmed unchanged pairing configuration and preferences.

No live prompt, question answer, approval or Mac task interruption was sent for
validation. The controller window was closed for replacement; the runtime update
used the normal guarded service lifecycle. These local checks do not prove voice
input works on the physical glasses.

## Physical phone/glasses checks — pending

The critical check is whether the unmodified stock client exposes voice input
while the Mac continues working, then presents the captured draft with **Steer**
and **Cancel**. The native **Yes** step must also be observed. Check the fresh
**Send prompt** preview after turn completion, the retained guard after reconnect
or restart, cancellation, timeout/conflict recovery, and the absence of duplicate
submission separately.
No physical success is claimed for this prototype; earlier display and question
checks do not validate this new input flow. A live prompt requires explicit
authorization for its intended task.

## Compatibility boundary

The reviewed base combination remains Even Terminal 0.10.4, Node 26.9.0, and
Codex Mac App 26.915.31945 (build 9922). Runtime gates retain all previously
reviewed rollback versions; Text settings accept 0.2.8, 0.2.9, and 0.3.0.
The control app target is 1.1.3 build 5. Phone-app/firmware certification and
network coverage are unchanged.

Rollback to bridge 0.2.9 preserves unknown journal fields but does not enforce the
new local input guard; its earlier prompt behavior returns. Do not infer that
0.3.0 delayed-dictation protections apply after such a downgrade.
