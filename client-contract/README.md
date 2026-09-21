# Even Terminal client contract for Desktop Bridge 0.2.7

The canonical module is `bridge/client-contract.mjs`. It adapts normalized desktop pending actions to the existing Even Terminal wire protocol. This directory holds its documentation and tests. It does not modify or redistribute the phone/glasses application. All bridge-written labels and errors are English. User text and Codex output retain their original language.

The user physically validated 0.2.4 on 21 September: dim public commentary, complete long paragraphs, brighter final text, working question selection, and a visible footer timer. Native tool rows also prepend `tool end:` and join the heading and body inline. The backend cannot suppress that client-owned prefix through any verified field. The user's next 0.2.5 screenshots confirmed that a leading newline in summary is ignored, while final-answer newlines work. Version 0.2.7 follows the user's subsequent simplification: timestamps and intermediate prose are inline, with no added dashes or newlines. Final answers retain a line break after their timestamp. The user also confirmed that reloaded history uses ordinary brightness.

## Integration

```js
const presentationNumber = store.allocatePresentationNumber();
const presentation = buildActionPresentation(action, { presentationNumber });
emit(sessionId, presentation.event);
// Retain the complete presentation, including its token and snapshot metadata.
const response = decodeActionReply(freshAction, presentation, {
  answer: body.answer, decision: body.decision,
  requestId: body.requestId, actionToken: body.actionToken,
});
await desktop.respondAction(threadId, freshAction.id, response);
// Consume the presentation only after acknowledgement. Never auto-retry a
// mutation whose acknowledgement was lost. Refresh desktop state instead.
```

The caller must serialize requests, revalidate the native action's ID and fingerprint immediately before mutation, and reject submissions after the action is consumed. The pure decoder does not maintain a receipt ledger. `requestId` is compared with exact type and value, but is never sufficient correlation by itself because native IDs can be reused after restart. The module throws `ClientContractError` with an English message and one of `CLIENT_UNSUPPORTED_ACTION`, `CLIENT_STALE_ACTION`, `CLIENT_UNCORRELATED_REPLY`, `CLIENT_INVALID_REPLY`.

Exports:

| Function | Result |
| --- | --- |
| `buildActionPresentation(action, {presentationNumber})` | `{event, token, presentationNumber, id, kind, fingerprint, questions?, choices?, formFields?}` |
| `store.allocatePresentationNumber()` | Positive integer saved to the durable delivery store before it is returned |
| `decodeActionReply(action, presentation, input)` | `{kind, expectedFingerprint, answers? , choiceId?, content?}` |
| `progressMessage(text)` | `{type:'task_progress', completed:0, total:1, current:text}` |
| `clearProgressMessage()` | `{type:'task_progress', completed:1, total:1, current:''}` |

## Observed vendor wire protocol

Sources inspected: the installed npm `@evenrealities/even-terminal` **0.10.4** backend (`dist/routes/core.js`, `dist/routes/events.js`, `dist/codex/session.js`, `dist/claude/mappers.js`), plus two independent compatible implementations. The native Flutter client itself was **not** present in the package or found in a verified public repository. These findings establish what the backend sends and compatible implementations expect; they do not establish every native rendering behavior.

| Direction | Shape |
| --- | --- |
| Server → SSE question | `{type:'user_question',toolUseId:string,questions:[{question,header,multiSelect,options:[{label,description,preview}]}]}` |
| Stock `/api/question-response` fields consumed | `{sessionId,provider,answer:string}`; its handler ignores request identity fields |
| Server → SSE answer acknowledgement | `{type:'question_answer',answers:{[displayedQuestion]:answer}}` |
| Server → SSE permission | `{type:'permission_request',toolName,description,detail:string,toolUseId:string,options:[{text,key}]}` |
| Stock `/api/permission-response` fields consumed | `{sessionId,provider,decision:string}`; stock provider recognizes `allow`, `allowAlways`, `deny` |
| Server → SSE permission acknowledgement | `{type:'permission_result',toolName,summary,decision:'allowed'|'always'|'denied'}` |
| Client → `/api/interrupt` | `{sessionId,provider}` |
| Server → SSE progress | `{type:'task_progress',completed:number,total:number,current:string}` |
| Server → SSE elapsed statistics | `{type:'running_stats',durationMs:number,inputTokens:number,outputTokens:number}` |
| Server → SSE text | `status:think_start`, `status:think_end`, `status:text_start`, `text_delta`, `status:text_end`, `result`, then `status:idle` |

SSE uses `id: <number>` and `data: <JSON>` frames. The stock backend supports `needReplay=true`; the custom bridge also adds `Last-Event-ID` cursor replay. A compatible client's observed reconnect behavior cannot be assumed to request either. The provider restores current pending actions and terminal state deliberately after reconnection. Terminal markers, questions and acknowledgements, and retained public updates remain available during replay.

## Correlation and free text

The old route does not use a request ID. Its destructuring does **not** prove that a particular native-client version never sends extra fields. No hidden identity round-trip has been verified, so the bridge cannot rely on one. Mapping a bare `allow` to whichever approval happens to be current could approve a newer request after a delayed tap.

Permission choices retain hidden per-presentation keys `action:<random-token>:<choice-index>`; the visible labels remain ordinary English choices. Production question text now uses a short readable prefix, **Question 12**, or **Question 12.1 / Question 12.2** for a multi-question form. The random bracket suffix is removed. Stock-format JSON must still be keyed by that exact displayed question. The decoder accepts string, string-array, `{answer:string}`, or `{answers:string[]}` values, and an outer `{answers:{...}}` map.

The store reserves each number durably before display. The global `presentationCounter` survives restart and is preserved by older version-1 stores when they save the record. A legacy record without the field starts at zero. Invalid or exhausted counters and failed writes block allocation; an unreserved number is never returned. The journal must not be deleted to reset numbering. Omitting the helper option retains the earlier random-suffix format for compatibility callers and tests; production always supplies the saved number.

The compatible numbered JSON format is:

```json
{"Question 12\nWhere should it go?":"Paris, France"}
```

For a client that explicitly supplies the matching `actionToken`, a single free-text answer is accepted directly. A matching `requestId` alone never authorizes a reply. A manual single-question fallback is `[<token>] free text`. Commas remain part of the answer. Multi-question prose is refused instead of being split or assigned to every question. An explicit correlated `skip` dismisses the complete synchronous question request; asynchronous questions require an answer. The word `skip` inside a keyed answer remains ordinary answer text. Partial ordinary question forms are refused.

Earlier physical question selections preserved the exact tokenized question key. The readable numbering and selected-answer flow were subsequently confirmed in the user's physical tests. Custom permission-key echoing also requires validation: if a client hard-codes the three old values, approvals fail closed and need Codex/Remote or a separately patched client. The bridge never silently falls back to uncorrelated approvals.

## Display behavior and remaining limits

Public commentary uses matched `tool_start`/`tool_end` activity rows, the event family the user physically observed as dimmer. Their shared `name` is only the fixed timestamp, such as `[2m35]`; the end event carries the unchanged full paragraph in both `summary` and `detail: {output: paragraph}`. No dash padding or leading newline is added. The native client owns the `tool end:` prefix and ` · ` joining punctuation. There is no duplicate `text_delta` copy. Generic raw tool rows are suppressed. Both paired events retain the bridge-only `bridgePublicUpdate` marker for replay; this marker adds no native style capability.

Paragraphs flush at a native item boundary, turn closure/disconnection, or after 1.5 seconds without new text. A late suffix gets a new paired row containing only the missing text, never a repeated tool_end for the same ID. The final answer remains ordinary text, preceded by its timestamp and an extra blank line. The bridgeFinalHeader marker preserves this timestamp during completed replay.

Native per-message timing comes from turn.aeonAssistantMessageStartedAtMsById[item.id] relative to turnStartedAtMs when supplied, including final messages. First live observation is the fallback. Old suppressed commentary without a native timestamp has no artificial label. Cached labels stay fixed during streaming and reconnect. Ordinary history retains full prose and timestamps but its native styling may differ from live activity rows.

The client chooses brightness, wrapping, maximum visible summary length, and any built-in TOOLS caption. The user's screenshots confirm full long paragraphs in this activity format; the backend does not truncate them. Existing think/busy statuses are preserved. task_progress and running_stats remain available, and the latest physical screenshots show the native elapsed widget, while fixed text labels remain available. There is no verified per-message brightness parameter or thinking-text message type.

Supported helper presentations: ordinary and asynchronous questions, single/multiple selections, correlated native approval choices, and plan execution only when the IPC layer marks that exact action supported. Option-picker stays unsupported when no native response route exists. The helper does not manufacture desktop support.

Elicitation supports flat object forms with string, number, integer, boolean, or null fields. Submit creates typed content; native IPC validates the full schema. Sensitive fields, nested objects, arrays, verification, and sign-in must be completed in Codex or Remote; only decline/cancel is exposed on glasses for those forms. Blank optional fields are omitted. Native UI controls for complex forms, previews, uploaded files, and native plan editing are not reproduced.

Sources: [exact npm metadata](https://registry.npmjs.org/@evenrealities/even-terminal/0.10.4), [Even Better protocol observations](https://github.com/pawaca/even-better/blob/main/docs/PROTOCOL.md), [Even Terminal OpenCode compatible implementation](https://github.com/WichardRiezebos/even-terminal-opencode). The latter two are community implementation evidence, not vendor Flutter source.

## Verification

Run `node --test client-contract/client-contract.test.mjs bridge/delivery-store.test.mjs` from the repository root. The offline tests cover JSON/free text, stale and missing identity, multiple questions, duplicate labels/IDs, ambiguous replies, comma preservation, multiple selections, distinct approval choices, simple typed forms, secret/nested form rejection, progress clearing, readable numbering, restart uniqueness, malformed counters, and failed persistence. They simulate input/output contracts; they are not a phone or glasses rendering test.
