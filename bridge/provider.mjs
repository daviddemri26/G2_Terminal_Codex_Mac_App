import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopIpcClient, canonicalTurns, readableHistory, conversationStatus, pendingActions, parseAsyncQuestionReply, acceptedAsyncQuestionReplies } from './desktop-ipc.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { PromptQueue } from './prompt-queue.mjs';
import { buildActionPresentation, decodeActionReply, progressMessage, clearProgressMessage } from './client-contract.mjs';
import { publicActivityHeading, publicToolLabel, turnElapsedMs, formatElapsed, messageTimeLabel } from './activity.mjs';
import { activityEntriesForTurn } from './activity-extras.mjs';
import { summarizeTurnDiff } from './diff-summary.mjs';
import { createLocalMenu, decodeLocalChoice } from './local-interaction.mjs';
import { DEFAULT_TEXT_FORMATTING, readTextFormatting, validateTextFormatting, formatAssistantText, streamAssistantText } from './text-formatting.mjs';

const exec = promisify(execFile);
const catalogScript = join(dirname(fileURLToPath(import.meta.url)), 'catalog.py');
const expectedBuild = { CFBundleShortVersionString: '26.915.31945', CFBundleVersion: '9922' };
const terminal = status => ['completed', 'failed', 'interrupted'].includes(status);
const working = (state, turn) => {
  if (turn?.status !== 'inProgress') return false;
  if (conversationStatus(state) === 'busy') return true;
  const actions = pendingActions(state);
  // Async questions may stay open while the Mac continues independent work.
  return state.threadRuntimeStatus?.type === 'active' && actions.length > 0 && actions.every(action => action.kind === 'async-question');
};
const textInput = input => (input ?? []).filter(x => x.type === 'text').map(x => x.text ?? '').join('\n');
const codedError = (message, statusCode = 503) => Object.assign(new Error(message), { statusCode });
const appendFormattedText = (rendered, previous) => {
  if (rendered.startsWith(previous)) return rendered.slice(previous.length);
  // A message thought complete may later gain text after a trailing paragraph
  // gap. Keep the already visible spacing and deliver the new words once.
  const prefix = previous.replace(/[ \t\r\n]+$/, '');
  if (prefix && prefix !== previous && rendered.startsWith(prefix)) {
    return rendered.slice(prefix.length).replace(/^[ \t\r\n]+/, '');
  }
  return '';
};
const displayUserText = text => {
  const answers = parseAsyncQuestionReply(text);
  if (answers) return answers.map(answer => `${answer.question}\n${answer.answer}`).join('\n\n');
  if (text.startsWith('PLEASE IMPLEMENT THIS PLAN:\n')) return 'Implement the selected plan.';
  return text;
};
const TOOL_NAMES = { commandExecution: 'Running a command', fileChange: 'Updating files', mcpToolCall: 'Using a connected tool',
  dynamicToolCall: 'Using a tool', webSearch: 'Searching the web', imageView: 'Viewing an image',
  imageGeneration: 'Creating an image', collabAgentToolCall: 'Working with another agent' };

export function createDesktopProvider(emit, options = {}) {
  const client = options.client ?? new DesktopIpcClient();
  let store, queue, storageError;
  try {
    const directory = process.env.EVEN_CODEX_BRIDGE_STATE_DIR || join(homedir(), '.even-terminal', 'desktop-bridge-state');
    store = options.store ?? new DeliveryStore({ directory });
    queue = options.queueStore ?? new PromptQueue({ directory: options.store ? (store.path ? dirname(store.path) : null) : directory, now: options.now ?? Date.now });
  }
  catch (error) { storageError = error; }
  const sessions = new Map(), starting = new Set(), actionSending = new Set(), refreshing = new Set(), queuePumping = new Set();
  const now = options.now ?? Date.now;
  const readFormatting = () => {
    try { return validateTextFormatting((options.readTextFormatting ?? readTextFormatting)()); }
    catch { return { ...DEFAULT_TEXT_FORMATTING }; }
  };
  let catalogCache = [], catalogAt = 0, catalogPromise, checkedBuildAt = 0, checkingBuild, closed = false;
  const send = (id, message) => emit(id, {
    ...(['question_answer', 'permission_result'].includes(message.type) ? { bridgeActionReset: true } : {}),
    ...message, sessionId: id, provider: 'codex',
  });
  const safeMessage = error => error.outcomeUnknown
    ? 'Delivery is unconfirmed. Check this task on the Mac or in Remote. Your message will not be sent again automatically.'
    : /no-client-found|No desktop task owner/i.test(error.message ?? '')
      ? 'Open this task in the Mac app to make it available on your glasses.'
      : /ENOENT|ECONNREFUSED|IPC_DISCONNECTED/.test(`${error.code} ${error.message}`)
        ? 'The Mac app is unavailable. Reconnecting automatically; work already sent may still continue on the Mac.'
        : error.message ?? String(error);

  function displayStatus(local) {
    if (local?.syncFailed) return { state: 'idle', detail: 'Unable to sync with the Mac. Reopen this task to retry.' };
    if (local?.interaction) return { state: local.interaction.phase === 'compose' ? 'idle' : 'awaiting',
      detail: local.interaction.phase === 'compose' ? 'Add prompt: tap and hold to dictate. Mac work continues.' : 'Choose a prompt action' };
    return { state: local?.status ?? 'idle', detail: local?.detail ?? 'Ready' };
  }
  function showInteraction(id) {
    const local = sessions.get(id), interaction = local?.interaction;
    if (!interaction) return;
    const presentation = { bridgeLocalInteraction: true };
    send(id, { type: 'status', state: 'think_end', ...presentation, bridgeLocalReset: true });
    send(id, { type: 'status', state: 'text_end', ...presentation });
    send(id, { ...clearProgressMessage(), ...presentation });
    if (interaction.menu && !interaction.menu.consumed) send(id, { ...interaction.menu.presentation.event, ...presentation });
    if (interaction.phase === 'compose') send(id, { type: 'notification',
      message: 'Add prompt: tap and hold to dictate. Your text will be reviewed before sending. Mac work continues.', ...presentation });
    send(id, { type: 'status', ...displayStatus(local), ...presentation });
  }
  function closeInteraction(id, message) {
    const local = sessions.get(id); if (!local?.interaction) return;
    local.interaction = null;
    // Close transient native controls without claiming the Mac turn ended.
    send(id, { type: 'status', state: 'text_end', bridgeLocalReset: true });
    if (message) send(id, { type: 'notification', message });
  }
  function resumeDisplay(id, message) {
    const local = sessions.get(id); if (!local) return;
    closeInteraction(id, message);
    // The client stopped its spinner/text view for composition; reassert both
    // while keeping the transcript markers, so buffered native text appears once.
    local.thinking = false; local.finalTextOpen = false;
    if (local.disconnected) { setStatus(id, 'idle', 'Reconnecting to Mac', true); return; }
    const state = client.getState(id); if (state) observe(id, state);
    setStatus(id, local.status, local.detail, true);
  }
  function openMenu(id, stage, state, draftText, selectedId) {
    ensureStorage();
    const local = sessions.get(id), turn = canonicalTurns(state).at(-1);
    if (!turn?.turnId) throw codedError('Open a task with an existing response first.', 409);
    const mode = stage === 'interrupt' || conversationStatus(state) === 'busy' ? 'steer' : 'send';
    const menu = createLocalMenu({ stage, presentationNumber: store.allocatePresentationNumber(),
      turnId: turn.turnId, draftText, mode, queueEntries: queueEntries(id), selectedId });
    local.interaction = { phase: stage, menu, turnId: turn.turnId, expiresAt: now() + (options.interactionTimeoutMs ?? 120000) };
    showInteraction(id);
  }
  function queueEntries(id) { return queue?.list(id) ?? []; }
  function acceptedQueueTurn(state, messageId) {
    return canonicalTurns(state).find(turn => typeof turn.turnId === 'string' && turn.turnId &&
      (turn.params?.clientUserMessageId === messageId || (turn.items ?? []).some(item =>
        item.type === 'userMessage' && item.clientId === messageId)));
  }
  function reconcileQueue(id, state) {
    for (const entry of queueEntries(id)) {
      if (!['sending', 'unknown'].includes(entry.phase)) continue;
      const accepted = acceptedQueueTurn(state, entry.id);
      if (accepted) {
        beginDelivery(() => queue.complete(entry.id, accepted.turnId));
        if (store?.prompt(id)?.clientUserMessageId === entry.id) beginDelivery(() => store.clearPrompt(id));
      }
    }
  }
  function maybeShowQueue(id, force = false) {
    const local = sessions.get(id), state = client.getState(id), entries = queueEntries(id);
    if (!local || !state || !entries.length || local.interaction || local.disconnected ||
        starting.has(id) || actionSending.has(id) || queuePumping.has(id) || pendingActions(state).length ||
        conversationStatus(state) !== 'idle' || storageError) return;
    const needsAttention = entries.some(entry => ['paused', 'unknown', 'sending'].includes(entry.phase));
    if (!force && !needsAttention) return;
    const signature = JSON.stringify(entries.map(entry => [entry.id, entry.phase]));
    if (!force && local.queueNotice === signature) return;
    local.queueNotice = signature;
    openMenu(id, 'queue-list', state);
  }
  function pauseQueue(id, reason) {
    if (queueEntries(id).some(entry => entry.phase === 'queued')) beginDelivery(() => queue.pauseThread(id, reason));
  }
  async function pumpQueue(id) {
    if (closed || storageError || queuePumping.has(id) || starting.has(id) || actionSending.has(id)) return;
    const first = queueEntries(id)[0]; if (!first) return;
    let local = sessions.get(id);
    if (local?.interaction || local?.queueRetryAt > now()) return;
    queuePumping.add(id);
    let sending;
    try {
      if (!local) await watch(id);
      local = sessions.get(id);
      if (closed || local?.interaction || local?.disconnected) return;
      // Live snapshots already reconcile uncertain submissions. Polling remains
      // the ordinary refresh loop; never replay an unknown queued send.
      if (first.phase !== 'queued' || store.prompt(id)) return;
      let state = client.getState(id), turns = canonicalTurns(state), latest = turns.at(-1);
      let source = turns.findIndex(turn => turn.turnId === first.afterTurnId);
      if (source < 0) { pauseQueue(id, 'task-changed'); return; }
      let stopped = turns.slice(source).find((turn, index) => ['failed', 'interrupted'].includes(turn.status) && !(index === 0 && first.resumed));
      if (stopped) { pauseQueue(id, stopped.status); return; }
      if (!latest || conversationStatus(state) !== 'idle' || pendingActions(state).length ||
          !(latest.status === 'completed' || (first.resumed && latest.turnId === first.afterTurnId && terminal(latest.status)))) {
        local.queueReadyKey = null; return;
      }
      const key = `${first.id}:${latest.turnId}`;
      if (local.queueReadyKey !== key) { local.queueReadyKey = key; local.queueReadyAt = now(); }
      if (now() - local.queueReadyAt < (options.queueQuietMs ?? 1500)) return;
      await checkBuild(); state = await refresh(id); turns = canonicalTurns(state); latest = turns.at(-1);
      if (closed || storageError || local.interaction || local.disconnected || starting.has(id) || actionSending.has(id) ||
          queueEntries(id)[0]?.id !== first.id || queueEntries(id)[0]?.phase !== 'queued' || store.prompt(id) ||
          `${first.id}:${latest?.turnId}` !== key || conversationStatus(state) !== 'idle' || pendingActions(state).length ||
          !(latest.status === 'completed' || (first.resumed && latest.turnId === first.afterTurnId && terminal(latest.status)))) return;
      // Refresh can reveal an intervening failure even if the latest turn ID
      // is unchanged. Recheck the full dependency before committing a send.
      source = turns.findIndex(turn => turn.turnId === first.afterTurnId);
      if (source < 0) { pauseQueue(id, 'task-changed'); return; }
      stopped = turns.slice(source).find((turn, index) => ['failed', 'interrupted'].includes(turn.status) && !(index === 0 && first.resumed));
      if (stopped) { pauseQueue(id, stopped.status); return; }
      // Persist both the exact queued identity and the normal delivery guard
      // before the only native mutation. Recovery observes; it never resends.
      beginDelivery(() => queue.update(first.id, { phase: 'sending', reason: null }));
      sending = first;
      beginDelivery(() => store.beginPrompt(id, first.id));
      const result = await client.startTurn(id, first.text, first.id, latest.turnId,
        { queueOnly: true, allowStopped: first.resumed === true, afterTurnId: first.afterTurnId });
      const accepted = acceptedQueueTurn(client.getState(id), first.id);
      const turnId = accepted?.turnId ?? result?.turn?.id;
      if (typeof turnId !== 'string' || !turnId) throw Object.assign(new Error('The queued prompt was submitted but its delivery needs confirmation.'), { outcomeUnknown: true });
      beginDelivery(() => store.markPrompt(id, { phase: 'acknowledged', turnId }));
      if (queueEntries(id).some(entry => entry.id === first.id)) beginDelivery(() => queue.complete(first.id, turnId));
      const current = client.getState(id); if (current) observe(id, current);
      send(id, { type: 'notification', message: `Queued prompt sent. ${queueEntries(id).length} remaining.` });
    } catch (error) {
      if (sending) {
        const accepted = acceptedQueueTurn(client.getState(id), sending.id);
        if (accepted && !storageError) {
          reconcileQueue(id, client.getState(id));
          send(id, { type: 'notification', message: `Queued prompt sent. ${queueEntries(id).length} remaining.` });
          return; // Exact native identity confirms receipt despite a lost RPC acknowledgement.
        } else if (!storageError) {
          const pending = queueEntries(id).find(entry => entry.id === sending.id);
          if (error.outcomeUnknown) {
            if (pending) beginDelivery(() => queue.update(sending.id, { phase: 'unknown', reason: 'delivery-unknown' }));
            beginDelivery(() => store.markPrompt(id, { phase: 'unknown' }));
            pauseQueue(id, 'delivery-unknown');
          } else {
            beginDelivery(() => store.clearPrompt(id));
            if (pending) beginDelivery(() => queue.update(sending.id, { phase: 'queued', reason: null }));
            if (!['IPC_TASK_BUSY', 'IPC_TASK_IDLE', 'IPC_STALE_TURN'].includes(error.code)) pauseQueue(id, 'send-failed');
          }
        }
      }
      if (local) local.queueRetryAt = now() + 5000;
      report(id, error);
    } finally {
      queuePumping.delete(id);
      maybeShowQueue(id);
    }
  }

  async function deliverPrompt(id, text, { expectedTurnId, mode, expectedInteraction } = {}) {
    ensureStorage();
    const state = await refresh(id), actions = pendingActions(state);
    if (actions.length || conversationStatus(state) === 'awaiting') throw codedError('Answer the current question or approval first. Your prompt has not been sent.', 409);
    const turn = canonicalTurns(state).at(-1);
    if (expectedInteraction && sessions.get(id)?.interaction !== expectedInteraction) throw codedError('This prompt menu closed. Review your prompt again; nothing was sent.', 409);
    if (expectedTurnId !== undefined && turn?.turnId !== expectedTurnId) throw codedError('The task changed. Review your prompt again.', 409);
    const steering = conversationStatus(state) === 'busy';
    if (mode && steering !== (mode === 'steer')) throw codedError('The task state changed. Review your prompt again.', 409);
    const clientUserMessageId = randomUUID(); beginDelivery(() => store.beginPrompt(id, clientUserMessageId));
    if (sessions.get(id)?.interaction) sessions.get(id).interaction.submitting = true;
    setStatus(id, 'busy', 'Sending message');
    let acknowledged = false;
    try {
      const result = steering ? await client.steerTurn(id, text, clientUserMessageId, expectedTurnId)
        : await client.startTurn(id, text, clientUserMessageId, expectedTurnId);
      acknowledged = true;
      store.markPrompt(id, { phase: 'acknowledged', ...(!steering ? { turnId: result?.turn?.id } : {}) });
      const current = client.getState(id); if (current) observe(id, current);
    } catch (error) {
      if (acknowledged) error.outcomeUnknown = true;
      try { if (error.outcomeUnknown) store.markPrompt(id, { phase: 'unknown' }); else store.clearPrompt(id); }
      catch (storageFailure) { storageError = storageFailure; }
      const current = client.getState(id); if (current) observe(id, current);
      throw error;
    }
    return { sessionId: id, provider: 'codex' };
  }
  async function respondLocal(id, input) {
    const local = sessions.get(id), interaction = local.interaction;
    if (now() >= interaction.expiresAt) {
      resumeDisplay(id, 'Add prompt timed out. Nothing was sent.');
      throw codedError('This prompt menu expired. Open the current controls.', 409);
    }
    const { choiceId, menu } = decodeLocalChoice(interaction.menu, input);
    interaction.menu = menu; // consume synchronously before any desktop refresh
    interaction.sending = true;
    try {
      await checkBuild(); const state = await refresh(id);
      if (local.interaction !== interaction || canonicalTurns(state).at(-1)?.turnId !== interaction.turnId || pendingActions(state).length) {
        throw codedError('This prompt menu expired. Use the current controls; nothing was sent.', 409);
      }
      if (choiceId === 'add') {
        beginDelivery(() => store.guardPromptInput(id));
        interaction.phase = 'compose'; interaction.menu = null; interaction.sending = false;
        interaction.expiresAt = now() + (options.interactionTimeoutMs ?? 120000);
        showInteraction(id); return { ok: true, inputReady: true };
      }
      if (choiceId === 'stop') {
        pauseQueue(id, 'user');
        const result = await client.interrupt(id, interaction.turnId);
        resumeDisplay(id); return result;
      }
      if (choiceId === 'queue') {
        beginDelivery(() => queue.enqueue(id, menu.draftText, interaction.turnId));
        const latest = canonicalTurns(state).at(-1);
        if (['failed', 'interrupted'].includes(latest?.status)) pauseQueue(id, latest.status);
        resumeDisplay(id, `Queued. ${queueEntries(id).length} prompt${queueEntries(id).length === 1 ? '' : 's'} waiting.`);
        return { ok: true, queued: true, queueCount: queueEntries(id).length };
      }
      if (choiceId === 'view-queue' || choiceId.startsWith('item:')) {
        openMenu(id, choiceId === 'view-queue' ? 'queue-list' : 'queue-item', state, undefined,
          choiceId.startsWith('item:') ? choiceId.slice(5) : undefined);
        return { ok: true };
      }
      if (['pause', 'resume', 'clear', 'remove'].includes(choiceId)) {
        if (choiceId === 'pause') pauseQueue(id, 'user');
        if (choiceId === 'resume') beginDelivery(() => queue.resumeThread(id, interaction.turnId, {
          allowStopped: ['failed', 'interrupted'].includes(canonicalTurns(state).at(-1)?.status),
        }));
        if (choiceId === 'clear') beginDelivery(() => queue.discardThread(id));
        if (choiceId === 'remove') {
          const selected = queueEntries(id).find(entry => entry.id === menu.selectedId);
          if (!selected || !['queued', 'paused'].includes(selected.phase)) throw codedError('This queued prompt is no longer available to remove.', 409);
          beginDelivery(() => queue.remove(selected.id));
        }
        if (choiceId === 'resume') resumeDisplay(id, 'Queue resumed. Prompts will be sent one at a time when the task is ready.');
        else if (queueEntries(id).length) openMenu(id, 'queue-list', state);
        else resumeDisplay(id, 'Queue cleared.');
        return { ok: true, queueCount: queueEntries(id).length };
      }
      if (choiceId === 'back') {
        if (menu.stage === 'queue-item') openMenu(id, 'queue-list', state);
        else resumeDisplay(id);
        return { ok: true };
      }
      if (choiceId === 'steer' || choiceId === 'send') {
        const result = await deliverPrompt(id, menu.draftText, { expectedTurnId: interaction.turnId, mode: menu.mode, expectedInteraction: interaction });
        resumeDisplay(id, 'Prompt sent to the Mac.'); return { ...result, ok: true };
      }
      resumeDisplay(id, choiceId === 'cancel' ? 'Draft discarded. Nothing was sent.' : undefined);
      return { ok: true };
    } catch (error) { resumeDisplay(id); throw error; }
  }

  function setStatus(id, state, detail, force = false) {
    const local = sessions.get(id); if (!local) return;
    if (!local.interaction && (force || state !== local.status || detail !== local.detail)) send(id, { type: 'status', state, detail });
    local.status = state; local.detail = detail;
  }
  function endActivity(id) {
    const local = sessions.get(id); if (!local) return;
    closeCommentary(id);
    for (const record of local.extraTexts?.values() ?? []) emitExtra(id, record);
    send(id, { type: 'status', state: 'think_end' });
    send(id, { type: 'status', state: 'text_end' });
    send(id, clearProgressMessage());
    local.thinking = false; local.progress = ''; local.finalTextOpen = false;
  }
  function emitCommentary(id, record, complete = false) {
    if (!record || record.text === record.sentText || !record.text) return;
    const local = sessions.get(id);
    if (!local.formatting.showProgressUpdates) { record.sentText = record.text; return; }
    const rendered = streamAssistantText(record.text, local.formatting, complete);
    const previous = record.renderedText ?? '';
    // A native replacement cannot retract text already displayed by the client.
    const body = local.formatting.paragraphSpacing === 'original'
      ? (rendered.startsWith(previous) ? rendered.slice(previous.length) : rendered)
      : appendFormattedText(rendered, previous);
    if (!body) return;
    const toolId = `bridge-commentary:${local.turnKey}:${record.id}:${record.segment++}`;
    // Keep the dim native style: the timestamp and full prose share a line.
    // The client owns its tool prefix and joining punctuation.
    send(id, { type: 'tool_start', toolId, name: record.name, bridgePublicUpdate: true });
    send(id, { type: 'tool_end', toolId, name: record.name, summary: body, detail: { output: body }, bridgePublicUpdate: true });
    record.renderedText = rendered;
    if (complete || local.formatting.paragraphSpacing === 'original') record.sentText = record.text;
  }
  function closeCommentary(id) {
    for (const record of sessions.get(id)?.commentaryTexts?.values() ?? []) emitCommentary(id, record, true);
  }
  function messageHeader(id, turn, itemId, final = false, capture = false, preferences) {
    const local = sessions.get(id);
    if (!(preferences ?? local.formatting).showTimestamps) return '';
    const key = JSON.stringify([turn?.turnId ?? local.turnKey, final ? 'final' : itemId]);
    if (local.messageHeaders.has(key)) return local.messageHeaders.get(key);
    // Prefer native item timing. Otherwise capture live receipt time once;
    // never assign the final duration to old intermediate messages.
    let elapsed = final && terminal(turn?.status) ? turnElapsedMs(turn) : null;
    const messageStartedAtMs = turn?.aeonAssistantMessageStartedAtMsById?.[itemId];
    if (Number.isFinite(turn?.turnStartedAtMs) && Number.isFinite(messageStartedAtMs)) {
      elapsed = Math.max(0, messageStartedAtMs - turn.turnStartedAtMs);
    } else if (final && Number.isFinite(turn?.turnStartedAtMs) && Number.isFinite(turn?.finalAssistantStartedAtMs)) {
      elapsed = Math.max(0, turn.finalAssistantStartedAtMs - turn.turnStartedAtMs);
    }
    if (capture && elapsed === null) elapsed = turnElapsedMs(turn, { now: now(), fallbackStartedAtMs: local.startedAt });
    const label = messageTimeLabel(elapsed);
    const header = label ? `${label}${final ? '\n\n' : ' '}` : '';
    if (capture || elapsed !== null) {
      local.messageHeaders.set(key, header);
      if (local.messageHeaders.size > 2000) local.messageHeaders.delete(local.messageHeaders.keys().next().value);
    }
    return header;
  }
  function showCommentary(id, turn, messages, initial, latestCommentaryId) {
    const local = sessions.get(id);
    const commentary = messages.filter(item => item.phase === 'commentary' && !item.questions?.length);
    for (const item of commentary) {
      if (!item.text) continue;
      let record = local.commentaryTexts.get(item.id);
      if (!record) {
        const historical = initial && item.id !== (latestCommentaryId ?? commentary.at(-1)?.id);
        record = { id: item.id, text: item.text, sentText: historical ? item.text : '',
          renderedText: historical ? formatAssistantText(item.text, local.formatting) : '',
          changedAt: now(), segment: 0, name: messageHeader(id, turn, item.id, false, !historical).trimEnd() };
        local.commentaryTexts.set(item.id, record);
      } else if (record.text !== item.text) {
        record.text = item.text; record.changedAt = now();
      }
      // The next native item marks the paragraph boundary. A short quiet-time
      // fallback handles a final progress paragraph while work waits elsewhere.
      if (terminal(turn.status) || item !== turn.items?.at(-1)) emitCommentary(id, record, true);
    }
  }
  function emitExtra(id, record) {
    const local = sessions.get(id);
    if (!record?.text || record.active === false || record.text === record.sentText) return;
    // Never append activity after final text, or reveal hidden progress later.
    if (!local.formatting.showProgressUpdates || local.finalLabelSent || local.finished) {
      record.sentText = record.text; return;
    }
    const toolId = `bridge-activity:${local.turnKey}:${record.key}:${record.segment++}`;
    send(id, { type: 'tool_start', toolId, name: record.name, bridgePublicUpdate: true });
    send(id, { type: 'tool_end', toolId, name: record.name, summary: record.text,
      detail: { output: record.text }, bridgePublicUpdate: true });
    record.sentText = record.text;
  }
  function showExtra(id, turn, entry, { historical = false, complete = false, capture = true } = {}) {
    const local = sessions.get(id);
    let record = local.extraTexts.get(entry.key);
    if (!record) {
      record = { ...entry, sentText: historical ? entry.text : '', changedAt: now(), segment: 0,
        name: messageHeader(id, turn, entry.itemId, false, capture && !historical).trimEnd() };
      local.extraTexts.set(entry.key, record);
    } else if (record.text !== entry.text) {
      record.text = entry.text; record.changedAt = now();
      if (entry.kind === 'diff') {
        record.itemId = entry.itemId;
        record.name = messageHeader(id, turn, entry.itemId, false, capture).trimEnd();
      }
    }
    record.active = true;
    if (!local.formatting.showProgressUpdates) record.sentText = record.text;
    if (complete) emitExtra(id, record);
  }
  function showPublicUpdates(id, turn, messages, initial) {
    if (!turn) return;
    const entries = activityEntriesForTurn(turn), byItem = new Map();
    for (const entry of entries) {
      if (!byItem.has(entry.itemId)) byItem.set(entry.itemId, []);
      byItem.get(entry.itemId).push(entry);
    }
    const items = turn.items ?? [];
    const latestCommentary = messages.filter(item => item.phase === 'commentary' && !item.questions?.length).at(-1);
    const latestExtra = entries.at(-1);
    const latestVisibleIndex = Math.max(items.findIndex(item => item.id === latestCommentary?.id),
      items.findIndex(item => item.id === latestExtra?.itemId));
    for (const [index, item] of items.entries()) {
      if (item.type === 'agentMessage') showCommentary(id, turn, [item], initial, latestCommentary?.id);
      for (const entry of byItem.get(item.id) ?? []) {
        showExtra(id, turn, entry, { historical: initial && index < latestVisibleIndex, capture: !initial,
          complete: terminal(turn.status) || index < items.length - 1 || entry.kind !== 'heading' });
      }
    }
    const summary = summarizeTurnDiff(turn);
    const activeKeys = new Set(entries.map(entry => entry.key));
    if (summary) activeKeys.add('diff-summary');
    for (const [key, record] of sessions.get(id).extraTexts) record.active = activeKeys.has(key);
    if (summary) showExtra(id, turn, { key: 'diff-summary', itemId: `diff:${summary.fingerprint}`,
      text: summary.text, kind: 'diff' }, { complete: terminal(turn.status), capture: !initial });
    // Pending titles/statistics must settle before the final answer starts.
    if (messages.some(item => !item.questions?.length && (item.phase === 'final_answer' || !item.phase) && item.text)) {
      closeCommentary(id);
      for (const record of sessions.get(id).extraTexts.values()) emitExtra(id, record);
    }
  }
  function historyWithActivity(turns) {
    return turns.flatMap(turn => {
      const items = turn.items ?? [], positions = new Map(items.map((item, index) => [item.id, index]));
      const messages = readableHistory({ turns: [turn] }, Number.MAX_SAFE_INTEGER)
        .map(message => ({ ...message, position: positions.get(message.itemId) ?? -1 }));
      for (const entry of activityEntriesForTurn(turn)) messages.push({ role: 'assistant', phase: 'commentary',
        text: entry.text, turnId: turn.turnId, itemId: `activity:${entry.key}`, headerItemId: entry.itemId,
        position: (positions.get(entry.itemId) ?? items.length) + 0.1 });
      const summary = summarizeTurnDiff(turn);
      if (summary) {
        const finalIndex = items.findIndex(item => item.type === 'agentMessage' && !item.questions?.length
          && (item.phase === 'final_answer' || !item.phase) && item.text);
        messages.push({ role: 'assistant', phase: 'commentary', text: summary.text, turnId: turn.turnId,
          itemId: `diff:${summary.fingerprint}`, position: finalIndex < 0 ? items.length : finalIndex - 0.1 });
      }
      return messages.sort((a, b) => a.position - b.position).map(({ position, ...message }) => message);
    });
  }
  function sendRunningStats(id, force = false) {
    const local = sessions.get(id), state = client.getState(id), turn = state && canonicalTurns(state).at(-1);
    if (!local || local.interaction || local.disconnected || !working(state, turn)) return;
    if (!force && now() - (local.lastStatsAt ?? -Infinity) < (options.statsIntervalMs ?? 10000)) return;
    const durationMs = turnElapsedMs(turn, { now: now(), fallbackStartedAtMs: local.startedAt });
    send(id, { type: 'running_stats', durationMs, inputTokens: turn.usage?.inputTokens ?? 0, outputTokens: turn.usage?.outputTokens ?? 0 });
    if (local.progress && local.formatting.showProgressUpdates) send(id, progressMessage(`${formatElapsed(durationMs)} · ${local.progress}`));
    local.lastStatsAt = now();
  }
  function syncTerminalDisplay(id, state, force = false) {
    const local = sessions.get(id), turn = state && canonicalTurns(state).at(-1);
    if (!local || local.interaction || !turn || !terminal(turn.status) || conversationStatus(state) === 'busy' || local.status === 'busy') return;
    if (!force && Date.now() - (local.lastTerminalSyncAt ?? 0) < 15000) return;
    endActivity(id);
    setStatus(id, local.status, local.detail, true);
    local.lastTerminalSyncAt = Date.now();
  }
  function report(id, error) {
    const local = sessions.get(id), message = safeMessage(error);
    if (!local || message !== local.lastError) send(id, { type: 'error', message });
    if (local) local.lastError = message;
    const state = client.getState(id), status = state ? conversationStatus(state) : 'idle';
    setStatus(id, status, error.outcomeUnknown ? 'Delivery unconfirmed' : state ? 'Action needs attention' : 'Reconnecting to Mac');
    syncTerminalDisplay(id, state, true);
  }
  function ensureStorage() { if (storageError) throw storageError; }
  function beginDelivery(callback) {
    try { callback(); }
    catch (error) { if (error.statusCode !== 409 || error.code === 'QUEUE_STORAGE_ERROR') storageError = error; throw error; }
  }
  async function checkBuild() {
    if (options.skipBuildGuard || Date.now() - checkedBuildAt < 10000) return;
    checkingBuild ??= exec('python3', [catalogScript, 'version'], { timeout: 5000, maxBuffer: 4096 })
      .then(({ stdout }) => {
        const actual = JSON.parse(stdout);
        if (Object.keys(expectedBuild).some(k => actual[k] !== expectedBuild[k]))
          throw codedError('The Mac app has been updated. This bridge must be checked for compatibility before sending messages or approvals.');
        checkedBuildAt = Date.now();
      }).finally(() => { checkingBuild = undefined; });
    return checkingBuild;
  }
  async function catalog() {
    if (options.catalog) return options.catalog();
    if (Date.now() - catalogAt < 10000) return catalogCache;
    catalogPromise ??= exec('python3', [catalogScript, 'list', process.env.CODEX_HOME || join(homedir(), '.codex')], { timeout: 5000, maxBuffer: 1024 * 1024 })
      .then(({ stdout }) => { catalogCache = JSON.parse(stdout); catalogAt = Date.now(); return catalogCache; })
      .finally(() => { catalogPromise = undefined; });
    return catalogPromise;
  }

  function clearActionControls(id, { force = false, preservePresentation = false, answerWillRender = false } = {}) {
    const local = sessions.get(id); if (!local) return;
    const previous = local.action;
    if (!force && !previous && !local.presentation) return;
    // This only closes the glasses UI. It does not submit an answer or infer
    // an approval decision when the Mac no longer exposes that decision.
    if (force || (local.presentation?.questions && !answerWillRender && !actionSending.has(id) &&
        local.answeredActionFingerprint !== previous?.fingerprint)) {
      send(id, { type: 'question_answer', answers: {}, bridgeActionReset: true });
    }
    send(id, { type: 'status', state: 'text_end', bridgeActionReset: true });
    local.finalTextOpen = false;
    if (!preservePresentation) { local.action = null; local.presentation = null; local.presentationError = null; }
  }

  function showAction(id, actions, force = false) {
    const local = sessions.get(id), action = actions[0];
    if (local.interaction) { if (force) showInteraction(id); return; }
    if (!action) { clearActionControls(id); return; }
    if (local.action && (local.action.id !== action.id || local.action.fingerprint !== action.fingerprint)) clearActionControls(id);
    if (storageError) { setStatus(id, 'awaiting', 'Sending paused: delivery history needs attention'); return; }
    if (store?.pendingAction(id, action.id, action.fingerprint)) {
      setStatus(id, 'awaiting', 'Response sent; waiting for the Mac'); return;
    }
    const same = local.action?.id === action.id && local.action?.fingerprint === action.fingerprint && local.action?.supported === action.supported;
    if (same && local.presentation) {
      if (force) send(id, local.presentation.event);
      return;
    }
    if (same && !force && local.presentationError) return;
    local.action = action;
    local.presentationError = null;
    if (!action.supported) {
      local.presentation = null;
      local.presentationError = action.reason ?? 'Unsupported control';
      send(id, { type: 'notification', message: action.reason ?? 'This control needs the Mac app or Remote on your phone.' }); return;
    }
    try {
      local.presentation = buildActionPresentation(action, { presentationNumber: store.allocatePresentationNumber() });
      if (action.kind === 'async-question') for (const question of local.presentation.questions ?? []) {
        local.questionLabels.set(question.id, question.displayed);
      }
      send(id, local.presentation.event);
    } catch (error) {
      local.presentation = null;
      local.presentationError = safeMessage(error);
      send(id, { type: 'notification', message: `${safeMessage(error)} Continue in the Mac app or Remote.` });
    }
  }

  function showAcceptedQuestionReplies(id, state, initial, currentTurn) {
    const local = sessions.get(id), replies = acceptedAsyncQuestionReplies(state);
    const alias = reply => JSON.stringify(['question-in-turn', reply.questionItemId, reply.turnId, reply.answer]);
    const identities = new Map(replies.filter(reply => reply.clientUserMessageId).map(reply => [alias(reply), reply.clientUserMessageId]));
    for (const reply of replies) {
      // A snapshot can expose the same accepted input as turn parameters,
      // a steering item, and a userMessage. Use its native identity once.
      const identity = reply.clientUserMessageId ?? identities.get(alias(reply)) ?? reply.turnId;
      const key = JSON.stringify([reply.questionItemId, identity, reply.answer]);
      if (local.shownAnswers.has(key) || local.shownAnswers.has(alias(reply))) continue;
      local.shownAnswers.add(key); local.shownAnswers.add(alias(reply));
      if (reply.turnId !== currentTurn?.turnId || (initial && terminal(currentTurn?.status))) continue;
      const displayed = local.questionLabels.get(reply.questionItemId);
      if (local.action?.id === reply.questionItemId && displayed) local.answeredActionFingerprint = local.action.fingerprint;
      if (displayed) send(id, { type: 'question_answer', answers: { [displayed]: reply.answer } });
      else send(id, { type: 'user_prompt', text: `${reply.question}\n${reply.answer}` });
    }
  }

  function showAcceptedSteeringPrompts(id, turn, initial) {
    const local = sessions.get(id); local.shownSteering ??= new Set();
    for (const item of turn?.items ?? []) {
      if (item.type !== 'steeringUserMessage' || item.status !== 'accepted') continue;
      const text = textInput(item.input);
      if (!text || parseAsyncQuestionReply(text)) continue;
      const aliases = [item.clientUserMessageId, item.serverUserMessageId, item.id]
        .filter(value => typeof value === 'string' && value).map(value => `${turn.turnId}:${value}`);
      if (!aliases.length) continue;
      const seen = aliases.some(value => local.shownSteering.has(value));
      for (const value of aliases) local.shownSteering.add(value);
      if (!seen && !(initial && terminal(turn.status))) send(id, { type: 'user_prompt', text: displayUserText(text) });
    }
    while (local.shownSteering.size > 2000) local.shownSteering.delete(local.shownSteering.values().next().value);
  }

  function observe(id, state) {
    const local = sessions.get(id); if (!local || !state || local.resyncing) return;
    local.disconnected = false; local.syncFailed = false;
    const turns = canonicalTurns(state), turn = turns.at(-1), actions = pendingActions(state);
    const nextAction = actions[0];
    if (local.action && (local.action.id !== nextAction?.id || local.action.fingerprint !== nextAction?.fingerprint)) {
      clearActionControls(id, { answerWillRender: acceptedAsyncQuestionReplies(state).some(reply =>
        reply.questionItemId === local.action.id && reply.turnId === turn?.turnId &&
        !(!local.ready && terminal(turn?.status)) &&
        !local.shownAnswers.has(JSON.stringify(['question-in-turn', reply.questionItemId, reply.turnId, reply.answer]))) });
    }
    try { store?.reconcilePrompt(id, turns); store?.reconcileActions(id, actions); reconcileQueue(id, state); }
    catch (error) { storageError = error; report(id, error); }
    const pending = store?.prompt(id);
    let status = conversationStatus(state);
    if (pending && pending.phase !== 'unknown' && status === 'idle') status = 'busy';
    if (conversationStatus(state) !== 'idle' || actions.length) local.queueReadyKey = null;
    if (local.interaction) {
      local.lastSeen = Date.now();
      setStatus(id, actions.length ? 'awaiting' : status, actions.length ? 'Your response is needed' : status === 'busy' ? 'Working' : 'Ready');
      const interaction = local.interaction;
      if (!actions.length && turn?.turnId === interaction.turnId &&
          (interaction.sending || now() < interaction.expiresAt)) return;
      closeInteraction(id, interaction.submitting ? undefined : actions.length ? 'A Mac question needs your answer. The local draft was not sent.'
        : turn?.turnId !== interaction.turnId ? 'The task changed. The local draft was not sent.'
        : 'Add prompt timed out. Nothing was sent.');
      local.thinking = false; local.finalTextOpen = false;
    }
    const key = turn?.params?.clientUserMessageId ?? turn?.turnId, initial = !local.ready;
    if (key && key !== local.turnKey) {
      if (local.ready) endActivity(id);
      local.turnKey = key; local.texts = new Map(); local.finished = false;
      local.formatting = readFormatting(); local.renderedTexts = new Map();
      local.startedAt = now(); local.progress = ''; local.thinking = false;
      local.commentaryTexts = new Map(); local.extraTexts = new Map(); local.lastStatsAt = undefined;
      local.finalLabelSent = false; local.finalTextOpen = false;
      if (!initial || !terminal(turn.status)) {
        const text = textInput(turn.params?.input);
        // Async answer transport is represented once by accepted native replies.
        if (text && !parseAsyncQuestionReply(text)) send(id, { type: 'user_prompt', text: displayUserText(text) });
      }
    }
    showAcceptedQuestionReplies(id, state, initial, turn);
    showAcceptedSteeringPrompts(id, turn, initial);
    const items = turn?.items ?? [];
    const messages = items.filter(i => i.type === 'agentMessage' && typeof i.text === 'string');
    const finals = messages.filter(i => !i.questions?.length && (i.phase === 'final_answer' || !i.phase));
    const done = turn && terminal(turn.status);
    let finishedNow = false;
    if (initial && (done || status === 'idle')) {
      for (const item of finals) {
        local.texts.set(item.id, item.text);
        local.renderedTexts.set(item.id, formatAssistantText(item.text, local.formatting));
      }
      local.finished = true;
    } else {
      // Public commentary is ordinary visible assistant text in the Mac app.
      if (!done || !local.finished) showPublicUpdates(id, turn, messages, initial);
      const commentary = messages.filter(i => i.phase === 'commentary' && !i.questions?.length).at(-1)?.text;
      const activeTool = items.filter(i => TOOL_NAMES[i.type] && i.status === 'inProgress').at(-1);
      const heading = items.map(publicActivityHeading).filter(Boolean).at(-1);
      const progress = done ? '' : heading || commentary || (activeTool ? publicToolLabel(activeTool) : status === 'busy' ? 'Working…' : '');
      if (progress !== local.progress) {
        if (!progress || local.formatting.showProgressUpdates) send(id, progress ? progressMessage(`${formatElapsed(turnElapsedMs(turn, { now: now(), fallbackStartedAtMs: local.startedAt }))} · ${progress}`) : clearProgressMessage()); local.progress = progress;
      }
      const thinking = !done && items.at(-1)?.type === 'reasoning';
      if (thinking !== local.thinking) { send(id, { type: 'status', state: thinking ? 'think_start' : 'think_end' }); local.thinking = thinking; }
      for (const item of finals) {
        const previous = local.texts.get(item.id) ?? '';
        const displayed = local.formatting.paragraphSpacing === 'original' ? previous : (local.renderedTexts.get(item.id) ?? '');
        const rendered = streamAssistantText(item.text, local.formatting, done);
        if (item.text.startsWith(previous) && rendered.startsWith(displayed) && rendered.length > displayed.length) {
          closeCommentary(id);
          if (!local.finalTextOpen) { send(id, { type: 'status', state: 'text_start' }); local.finalTextOpen = true; }
          if (!local.finalLabelSent) {
            send(id, { type: 'text_delta', text: messageHeader(id, turn, item.id, true, true), bridgeFinalHeader: true }); local.finalLabelSent = true;
          }
          send(id, { type: 'text_delta', text: rendered.slice(displayed.length) });
          local.renderedTexts.set(item.id, rendered);
        }
        local.texts.set(item.id, item.text);
      }
      if (done && !local.finished) {
        endActivity(id);
        const failure = turn.error?.message ?? (turn.status === 'interrupted' ? 'Stopped by user.' : 'Codex could not complete this response.');
        if (turn.status === 'failed') send(id, { type: 'error', message: failure });
        send(id, { type: 'result', success: turn.status === 'completed',
          text: formatAssistantText(finals.map(i => i.text).join('\n\n'), local.formatting) || (turn.status === 'completed' ? '' : failure),
          durationMs: turnElapsedMs(turn, { now: now(), fallbackStartedAtMs: local.startedAt })
            ?? turnElapsedMs({ ...turn, status: 'inProgress' }, { now: now(), fallbackStartedAtMs: local.startedAt }), turns: 1,
          costUsd: 0, inputTokens: turn.usage?.inputTokens ?? 0, outputTokens: turn.usage?.outputTokens ?? 0 });
        local.finished = true;
        finishedNow = true;
      }
    }
    local.ready = true; local.lastSeen = Date.now(); local.lastError = null;
    const detail = storageError ? 'Sending paused: delivery history needs attention' : pending?.phase === 'unknown' ? 'Delivery unconfirmed'
      : actions.length ? (actions[0].supported ? 'Your response is needed' : 'Continue in the Mac app or Remote')
      : status === 'busy' ? 'Working' : 'Ready';
    setStatus(id, actions.length ? 'awaiting' : status, detail, initial || finishedNow); showAction(id, actions);
    sendRunningStats(id);
    syncTerminalDisplay(id, state, finishedNow);
  }

  client.on('state', (id, state) => { try { observe(id, state); } catch (error) { report(id, error); } });
  client.on('error', error => { for (const id of sessions.keys()) report(id, error); });
  const disconnected = id => {
    const local = sessions.get(id); if (!local) return;
    // Keep turn/text markers: a fresh snapshot fills only missing text.
    local.presentation = null; local.action = null;
    local.disconnected = true;
    closeInteraction(id, local.interaction?.submitting
      ? 'The Mac connection changed during submission. Check the task before sending again.'
      : 'The Mac connection changed. The local draft was not sent.');
    endActivity(id);
    report(id, Object.assign(new Error('IPC_DISCONNECTED'), { code: 'IPC_DISCONNECTED' }));
    setStatus(id, 'idle', 'Reconnecting to Mac');
  };
  client.on('disconnected', () => { for (const id of sessions.keys()) disconnected(id); });
  client.on('threadDisconnected', disconnected);
  client.on('reconnecting', () => { for (const id of sessions.keys()) setStatus(id, 'idle', 'Reconnecting to Mac'); });

  async function watch(id, { reshowAction = false, fresh = false } = {}) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw codedError('Invalid task identifier.', 400);
    await checkBuild();
    if (!(await catalog()).some(t => t.id === id)) throw codedError('Open an existing Codex task in the Mac app, then select it on your glasses.', 404);
    let local = sessions.get(id);
    if (!local) {
      local = { ready: false, turnKey: null, texts: new Map(), status: 'idle', detail: 'Connecting to Mac', lastAccess: Date.now(), lastSeen: 0,
        questionLabels: new Map(), shownAnswers: new Set(), messageHeaders: new Map(),
        formatting: readFormatting(), renderedTexts: new Map() };
      sessions.set(id, local);
    }
    local.lastAccess = Date.now();
    let state;
    if (fresh) {
      // A cached follow result is not authority for a reopened question.
      // Hide those observations until the requested native snapshot arrives.
      local.resyncing = (local.resyncing ?? 0) + 1;
      try {
        await client.follow(id);
        const entry = await client.refresh(id);
        state = entry?.state ?? client.getState(id);
      } finally { local.resyncing--; }
      if (reshowAction) clearActionControls(id, { force: true, preservePresentation:
        pendingActions(state).some(action => action.id === local.action?.id && action.fingerprint === local.action?.fingerprint) });
    } else { await client.follow(id); state = client.getState(id); }
    if (state) observe(id, state);
    if (reshowAction) showAction(id, pendingActions(state), true);
    if (reshowAction) syncTerminalDisplay(id, state, true);
    if (reshowAction) sendRunningStats(id, true);
    return state;
  }
  async function freshWatch(id, reshowAction = false) {
    try { return await watch(id, { fresh: true, reshowAction }); }
    catch (error) {
      const local = sessions.get(id);
      if (local) { local.syncFailed = true; local.disconnected = true; }
      closeInteraction(id, 'The Mac state could not be refreshed. The local draft was not sent.');
      clearActionControls(id, { force: true });
      send(id, { type: 'status', state: 'think_end' });
      send(id, clearProgressMessage());
      send(id, { type: 'status', state: 'idle', detail: 'Unable to sync with the Mac. Reopen this task to retry.' });
      send(id, { type: 'notification', message: 'Current task state is unavailable. Old questions were cleared; reconnect to continue.' });
      throw error;
    }
  }
  async function refresh(id) {
    const entry = await client.refresh(id), state = entry?.state ?? client.getState(id);
    if (state) observe(id, state); return state;
  }

  async function respond(id, input) {
    if (actionSending.has(id) || starting.has(id) || queuePumping.has(id)) throw codedError('A response is already being sent for this task.', 409);
    actionSending.add(id);
    try {
      ensureStorage();
      if (sessions.get(id)?.interaction?.menu) return await respondLocal(id, input);
      await watch(id);
      const local = sessions.get(id), displayed = local.action, presentation = local.presentation;
      if (!displayed || !presentation) throw codedError('No supported question or approval is waiting on your glasses. Open the task to refresh it.', 409);
      const state = await refresh(id);
      const action = pendingActions(state).find(a => a.id === displayed.id && a.fingerprint === displayed.fingerprint);
      if (!action) throw codedError('This request has already changed or been answered. Please use the current question.', 409);
      const response = decodeActionReply(action, presentation, input);
      beginDelivery(() => store.beginAction(id, action.id, action.fingerprint)); setStatus(id, 'awaiting', 'Sending your response');
      let acknowledged = false;
      try {
        const result = await client.respondAction(id, action.id, response);
        acknowledged = true;
        store.markAction(id, action.id, action.fingerprint, 'acknowledged');
        local.presentation = null;
        const current = client.getState(id); if (current) observe(id, current);
        if (store.pendingAction(id, action.id, action.fingerprint)) setStatus(id, 'awaiting', 'Response sent; waiting for the Mac');
        else if (result?.resolution === 'resolved-elsewhere') {
          send(id, { type: 'question_answer', answers: {}, bridgeActionReset: true });
          send(id, progressMessage('This request was answered on another device.'));
        }
        else if (result?.confirmed === true && response.answers && action.kind !== 'async-question') send(id, { type: 'question_answer', answers: Object.fromEntries((presentation.questions ?? []).map(question => [question.displayed, response.answers[question.id]?.answers?.join(', ') ?? 'Skipped'])) });
        else if (result?.confirmed === true && action.kind.endsWith('approval')) send(id, { type: 'permission_result', toolName: action.title, summary: 'Your choice was sent. This request is now closed.',
          decision: /deny|decline|cancel/.test(response.choiceId ?? '') ? 'denied' : 'allowed' });
        // Acknowledgements close client controls, so restore any next question
        // already reported by the Mac before that late acknowledgement.
        const remaining = pendingActions(client.getState(id));
        if (remaining.length) showAction(id, remaining, true);
        // A late answer acknowledgement must not be the last lifecycle event.
        syncTerminalDisplay(id, client.getState(id), true);
        return { ok: true, sessionId: id, provider: 'codex', confirmed: result?.confirmed === true,
          pending: result?.pending === true, acknowledged: result?.acknowledged === true };
      } catch (error) {
        if (acknowledged) error.outcomeUnknown = true;
        try {
          if (error.outcomeUnknown) store.markAction(id, action.id, action.fingerprint, 'unknown');
          else store.rejectAction(id, action.id, action.fingerprint);
        } catch (storageFailure) { storageError = storageFailure; }
        throw error;
      }
    } catch (error) { report(id, error); throw error; }
    finally { actionSending.delete(id); }
  }

  const interval = setInterval(() => {
    if (closed) return;
    for (const [id, local] of sessions) {
      const unresolvedAction = Object.values(store?.data.actions ?? {}).some(a => a.threadId === id);
      if (!local.interaction && !starting.has(id) && !queuePumping.has(id) && !queueEntries(id).length && !store?.prompt(id) && !unresolvedAction && !actionSending.has(id) && Date.now() - local.lastAccess > 180000 && !options.hasClients?.(id)) {
        client.unfollow(id); sessions.delete(id); continue;
      }
      if (refreshing.has(id)) continue;
      refreshing.add(id);
      checkBuild().then(() => refresh(id)).catch(error => report(id, error)).finally(() => refreshing.delete(id));
    }
  }, options.refreshIntervalMs ?? 20000);
  interval.unref();
  const queueInterval = setInterval(() => {
    if (!closed) for (const id of queue?.threadIds() ?? []) pumpQueue(id).catch(error => { storageError ??= error; report(id, error); });
  }, options.queueIntervalMs ?? 1000);
  queueInterval.unref();
  const statsInterval = setInterval(() => {
    if (!closed) for (const id of sessions.keys()) sendRunningStats(id);
  }, options.statsIntervalMs ?? 10000);
  statsInterval.unref();
  const commentaryInterval = setInterval(() => {
    if (closed) return;
    for (const [id, local] of sessions) {
      if (local.disconnected) continue;
      if (local.interaction) {
        if (!local.interaction.sending && now() >= local.interaction.expiresAt) resumeDisplay(id, 'Add prompt timed out. Nothing was sent.');
        continue;
      }
      for (const record of local.commentaryTexts?.values() ?? []) {
        if (now() - record.changedAt >= (options.commentarySettleMs ?? 1500)) emitCommentary(id, record);
      }
      for (const record of local.extraTexts?.values() ?? []) {
        if (now() - record.changedAt >= (options.commentarySettleMs ?? 1500)) emitExtra(id, record);
      }
    }
  }, Math.min(250, options.commentarySettleMs ?? 1500));
  commentaryInterval.unref();

  return {
    isDesktopBridge: true,
    async listSessions(limit = 10, cwd) {
      const rows = await catalog();
      return rows.filter(t => !cwd || t.cwd === cwd).slice(0, Math.min(Math.max(1, limit), 100)).map(t => ({
        id: t.id, title: t.title, cwd: t.cwd, timestamp: new Date(t.updated_at * 1000).toISOString(),
        provider: 'codex', status: displayStatus(sessions.get(t.id)).state, statusKnown: sessions.has(t.id),
      }));
    },
    async getSessionStatus(id) { return displayStatus(sessions.get(id)).state; },
    async getInfo() { return { account: {}, model: 'Codex — Mac app', version: 'G2 Desktop Bridge 0.3.2', provider: 'codex' }; },
    async getHistory(id, limit = 10) {
      const state = await freshWatch(id);
      const turns = canonicalTurns(state);
      const questions = new Set(turns.flatMap(turn => (turn.items ?? []).filter(item => item.questions?.length).map(item => item.id)));
      const byTurn = new Map(turns.map(turn => [turn.turnId, turn]));
      const formatting = terminal(turns.at(-1)?.status) ? readFormatting() : sessions.get(id).formatting;
      return historyWithActivity(turns).filter(m => !questions.has(m.itemId))
        .filter(m => formatting.showProgressUpdates || m.role !== 'assistant' || m.phase !== 'commentary')
        .map(m => m.role === 'user' ? { ...m, text: displayUserText(m.text) }
          : { ...m, text: messageHeader(id, byTurn.get(m.turnId), m.headerItemId ?? m.itemId, m.phase !== 'commentary', false, formatting)
            + formatAssistantText(m.text, formatting) }).slice(-Math.max(1, limit));
    },
    async sync(id) { return freshWatch(id); },
    async watch(id) { const state = await freshWatch(id, true); maybeShowQueue(id, true); return state; },
    async prompt(id, text) {
      if (!id) throw codedError('New session is not supported by this bridge yet. Create a task in the Mac app or Remote, then select it on your glasses.', 400);
      if (typeof text !== 'string' || !text.trim()) throw codedError('Enter a message first.', 400);
      if (starting.has(id) || actionSending.has(id) || queuePumping.has(id)) throw codedError('An action is already being sent for this task.', 409);
      starting.add(id);
      try {
        ensureStorage(); await watch(id);
        const state = await refresh(id), local = sessions.get(id), actions = pendingActions(state);
        if (actions.length) throw codedError('Please answer the displayed question or approval using its controls. Your message has not been sent as a new task instruction.', 409);
        if (conversationStatus(state) === 'awaiting') throw codedError('This task needs a response in the Mac app or Remote before it can continue.', 409);
        if (local.interaction || (conversationStatus(state) === 'busy' && store.requiresPromptReview(id))) {
          if (store.prompt(id)) throw codedError('A previous message still needs confirmation. Your new prompt was not sent.', 409);
          if (local.interaction && local.interaction.phase !== 'compose') throw codedError('Choose an option in the current prompt menu first. Nothing was sent.', 409);
          openMenu(id, 'draft', state, text);
          return { sessionId: id, provider: 'codex', draft: true, sent: false };
        }
        // Ordinary idle follow-ups go directly, even after an earlier Add prompt.
        // Lock the observed mode so a race cannot turn an idle send into steering.
        return await deliverPrompt(id, text, { expectedTurnId: canonicalTurns(state).at(-1)?.turnId,
          mode: conversationStatus(state) === 'busy' ? 'steer' : 'send' });
      } catch (error) { report(id, error); throw error; }
      finally { starting.delete(id); }
    },
    async interrupt(id) {
      const cancellingLocalInput = Boolean(sessions.get(id)?.interaction);
      if (starting.has(id) || actionSending.has(id) || queuePumping.has(id)) throw codedError('An action is already being sent for this task.', 409);
      actionSending.add(id);
      try {
        await watch(id); await checkBuild(); const state = await refresh(id), local = sessions.get(id);
        if (cancellingLocalInput || local.interaction) { resumeDisplay(id, 'Prompt entry cancelled.'); return { ok: true, cancelledLocalInput: true }; }
        if (conversationStatus(state) === 'busy' && !pendingActions(state).length && !store?.prompt(id)) {
          openMenu(id, 'interrupt', state); return { ok: true, menuOpened: true, interrupted: false };
        }
        if (store?.prompt(id)) throw codedError('Stop is unconfirmed for the pending message. Check the task on the Mac or in Remote before sending again.', 409);
        if (pendingActions(state).length || conversationStatus(state) === 'awaiting') throw codedError('A question or approval is waiting. Use its current controls, or stop the task on the Mac.', 409);
        return { ok: true, interrupted: false };
      } catch (error) { report(id, error); throw error; }
      finally { actionSending.delete(id); }
    },
    respondPermission(id, decision, context = {}) { return respond(id, { ...context, decision }); },
    respondQuestion(id, answer, context = {}) { return respond(id, { ...context, answer }); },
    respondAction(id, input) { return respond(id, input); },
    async getActions(id) {
      await freshWatch(id);
      maybeShowQueue(id);
      const local = sessions.get(id);
      if (local.interaction?.menu && !local.interaction.menu.consumed) return [{ ...local.interaction.menu.action, local: true, presentation: local.interaction.menu.presentation }];
      return pendingActions(client.getState(id)).map((a, index) => ({ ...a, presentation: index === 0 ? local.presentation : null }));
    },
    getStatus(id) {
      const local = sessions.get(id); return local ? { ...displayStatus(local), engineState: local.status, localInput: Boolean(local.interaction), queueCount: queueEntries(id).length, queuePaused: queueEntries(id).some(entry => entry.phase !== 'queued'), lastUpdate: local.lastSeen, provider: 'codex' } : null;
    },
    getSubscribedSessions() {
      return [...sessions].map(([threadId, s]) => ({ threadId, status: s.status, detail: s.detail,
        submissionPending: Boolean(s.syncFailed) || queueEntries(threadId).length > 0 || queuePumping.has(threadId) || Boolean(s.interaction) || starting.has(threadId) || Boolean(store?.prompt(threadId)) || actionSending.has(threadId) || Object.values(store?.data.actions ?? {}).some(a => a.threadId === threadId),
        idleSinceMs: Date.now() - s.lastAccess }));
    },
    async close() { closed = true; clearInterval(interval); clearInterval(queueInterval); clearInterval(statsInterval); clearInterval(commentaryInterval); await client.close(); },
  };
}
