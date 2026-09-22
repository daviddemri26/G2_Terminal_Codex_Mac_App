# Validation: bridge 0.3.2 / control app 1.1.5 build 7

Prepared on 22 September 2026 for **Even Terminal for Codex Mac App**.
Offline checks, managed installation, and physical phone/glasses behavior are
recorded separately. Physical synchronization checks remain pending.

## Scope

Refresh authoritative Mac task state before SSE reconnect replay, message polling,
and history restoration. Retire answered or obsolete native questions so older
cached events do not restore actionable controls.

Ordinary idle follow-ups go directly to the Mac even after prior **Add prompt**
use. A composition explicitly opened while busy still needs draft confirmation
if the response finishes during capture. Existing queue ordering, reply
correlation, durable delivery checks, Text settings, and elapsed labels remain.

**New session** remains unsupported through the reviewed native follower
connection. The intended UI reports the limitation and directs users to an
existing Mac task; there is no separate CLI engine fallback.

## Offline checks — passed

The final `npm run check` passed **451 tests**: 290 Node unit tests,
24 replay/route integration tests, 99 operations tests, and 38 build/installer
tests. The control app 1.1.5 build 7, focused Swift checks, and signature
verification also passed.

Coverage includes old Mac answers followed by newer turns, accepted steering
masked by stale overlays, final-refresh rejection of old replies, replay before
fresh state, sync failures, stable question choices during polling, ordinary
idle follow-ups, and queue regressions. Confirmed ordinary steering messages
from the Mac are shown once by native identity. No live prompt, approval, answer,
or task creation was used for these checks.

## Installed-service checks — passed

The managed installers completed bridge **0.3.2** and control app **1.1.5 build 7**.
Fresh diagnostics confirmed the desktop connection, verified active and previous
runtimes, and an installed runtime matching the tested build. Bridge **0.3.1**
remains available for guarded rollback. Private before/after comparisons confirmed
unchanged pairing configuration and preferences. The control window was reopened.

## Physical phone/glasses checks — pending for 0.3.2

The user reported successful **Add prompt** use on 0.3.0 and successful **Queue**
use on 0.3.1. These reports do not validate the new synchronization behavior.
Reopening after an answer on the Mac, current history, ordinary idle follow-ups,
and completion during an explicitly opened composition still need a physical
check. Native dictation behavior on **New session** is not claimed to be repaired.

## Bounded New session evidence

The pinned Even Terminal 0.10.4 HTTP prompt route accepts an omitted session ID
and can return a resolved ID. Its stock Codex implementation creates a thread
in its own engine; this project deliberately does not use that fallback.

Read-only inspection found native projectless creation inside the reviewed Mac
App, but no verified exposed follower creation route. Existing follower turn
operations require an already owned Mac task. That is a current integration
boundary, not proof that no future supported interface can exist. Create a task
in the Codex Mac App or Remote, then select it in Even Terminal.

## Compatibility boundary

The reviewed base remains Even Terminal 0.10.4, Node 26.9.0, and Codex Mac App
26.915.31945 (build 9922). Release gates retain all earlier reviewed rollback
versions and Text support from 0.2.8 onward. Nonempty or uncertain queues and
pending deliveries continue to protect disruptive maintenance. No new desktop,
phone-app, firmware, or network compatibility is claimed.
