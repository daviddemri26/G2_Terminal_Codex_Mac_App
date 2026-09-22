# Validation: bridge 0.3.1 / control app 1.1.4 build 6

Prepared on 21 September 2026 for **Even Terminal for Codex Mac App**.
Offline checks, managed installation, and physical phone/glasses behavior are
recorded separately.

## Scope

This release adds a bridge-owned durable first-in, first-out queue, limited to
10 messages per task. **Queue** joins the draft's **Steer** / **Send prompt** and
**Cancel** choices. A nonempty queue adds optional **View queue** to the existing
long press → native **Yes** → response-controls menu. An idle queue needing
attention can also be opened by reselecting the task.

The list supports ordered previews, reading an exact message, removal while
waiting, pause/resume, and clearing. Sending or uncertain messages cannot be
removed/cleared through these controls. The Mac App's native queue is untouched.
Waiting entries pause after failed/interrupted work or explicit **Stop response**.
Uncertain delivery is reconciled by message identity and is not automatically
retried. Native pending questions/approvals take precedence. Existing correlation,
delayed-input guards, public activity, and compact timestamps remain required.

## Offline checks — passed

The final `npm run check` passed: **416 tests**.

- 266 Node unit tests.
- 13 runtime replay integration tests.
- 99 operations tests.
- 38 build and installer tests.

The control app 1.1.4 build 6, focused Swift checks, and local signature
verification also passed. Queue coverage includes durable ordering, capacity,
correlated menus, exact text, paused/unknown states, duplicate/reconnect protection,
and the maintenance guard for nonempty or invalid files. These isolated tests
use synthetic tasks and do not prove native voice input or glasses rendering.

## Installed-service checks — passed

The managed installers completed installation of control app **1.1.4 build 6**
and bridge **0.3.1**. Fresh diagnostics reported **ready**, a compatible desktop,
verified active and previous runtimes, and **sourceChanged: false**. Bridge
**0.3.0** remains the previous release for guarded rollback.

Private before/after hash comparisons confirmed unchanged pairing configuration
and preferences. The control window was reopened, and its installed version was
checked again. No live prompt tests, question answers, approvals, or Mac task
interruptions were sent during this validation. These local installation checks
do not establish physical Queue behavior.

## Physical phone/glasses checks — user-reported success

The user reported that **Add prompt** worked physically with bridge **0.3.0**
and subsequently reported successful **Queue** use with **0.3.1**. Historical
0.3.0 details remain in [its validation record](validation-0.3.0.md).

The Queue report was received after the initial installation record. It confirms
successful use, not an exhaustive device test matrix. Independent certification
of every queue management control, failure/interruption recovery, uncertain
send, firmware version, or network profile is not claimed. New synchronization
behavior in 0.3.2 requires its own physical check. Any new live test still requires
explicit authorization for its intended task.

## Compatibility boundary

The reviewed base remains Even Terminal 0.10.4, Node 26.9.0, and Codex Mac App
26.915.31945 (build 9922). This release does not expand desktop, phone-app, firmware,
or network certification. The new controller preserves prior reviewed rollback
versions and Text support for 0.2.8, 0.2.9, 0.3.0, and 0.3.1.

A nonempty durable queue blocks disruptive maintenance, including rollback.
Earlier runtimes do not implement this new queue; do not infer 0.3.1 queue behavior
from a downgrade. Saved messages are not placed in the native Mac queue.
