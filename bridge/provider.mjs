import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopIpcClient, canonicalTurns, readableHistory, conversationStatus, pendingActions, parseAsyncQuestionReply, acceptedAsyncQuestionReplies } from './desktop-ipc.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { buildActionPresentation, decodeActionReply, progressMessage, clearProgressMessage } from './client-contract.mjs';
import { publicActivityHeading, publicToolLabel, turnElapsedMs, formatElapsed, messageTimeLabel } from './activity.mjs';

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
  let store, storageError;
  try { store = options.store ?? new DeliveryStore({ directory: process.env.EVEN_CODEX_BRIDGE_STATE_DIR || join(homedir(), '.even-terminal', 'desktop-bridge-state') }); }
  catch (error) { storageError = error; }
  const sessions = new Map(), starting = new Set(), actionSending = new Set(), refreshing = new Set();
  const now = options.now ?? Date.now;
  let catalogCache = [], catalogAt = 0, catalogPromise, checkedBuildAt = 0, checkingBuild, closed = false;
  const send = (id, message) => emit(id, { ...message, sessionId: id, provider: 'codex' });
  const safeMessage = error => error.outcomeUnknown
    ? 'Delivery is unconfirmed. Check this task on the Mac or in Remote. Your message will not be sent again automatically.'
    : /no-client-found|No desktop task owner/i.test(error.message ?? '')
      ? 'Open this task in the Mac app to make it available on your glasses.'
      : /ENOENT|ECONNREFUSED|IPC_DISCONNECTED/.test(`${error.code} ${error.message}`)
        ? 'The Mac app is unavailable. Reconnecting automatically; work already sent may still continue on the Mac.'
        : error.message ?? String(error);

  function setStatus(id, state, detail, force = false) {
    const local = sessions.get(id); if (!local) return;
    if (force || state !== local.status || detail !== local.detail) send(id, { type: 'status', state, detail });
    local.status = state; local.detail = detail;
  }
  function endActivity(id) {
    const local = sessions.get(id); if (!local) return;
    closeCommentary(id);
    send(id, { type: 'status', state: 'think_end' });
    send(id, { type: 'status', state: 'text_end' });
    send(id, clearProgressMessage());
    local.thinking = false; local.progress = ''; local.finalTextOpen = false;
  }
  function emitCommentary(id, record) {
    if (!record || record.text === record.sentText || !record.text) return;
    const local = sessions.get(id);
    const body = record.text.startsWith(record.sentText) ? record.text.slice(record.sentText.length) : record.text;
    if (!body) return;
    const toolId = `bridge-commentary:${local.turnKey}:${record.id}:${record.segment++}`;
    // Keep the dim native style: the timestamp and full prose share a line.
    // The client owns its tool prefix and joining punctuation.
    send(id, { type: 'tool_start', toolId, name: record.name, bridgePublicUpdate: true });
    send(id, { type: 'tool_end', toolId, name: record.name, summary: body, detail: { output: body }, bridgePublicUpdate: true });
    record.sentText = record.text;
  }
  function closeCommentary(id) {
    for (const record of sessions.get(id)?.commentaryTexts?.values() ?? []) emitCommentary(id, record);
  }
  function messageHeader(id, turn, itemId, final = false, capture = false) {
    const local = sessions.get(id);
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
  function showCommentary(id, turn, messages, initial) {
    const local = sessions.get(id);
    const commentary = messages.filter(item => item.phase === 'commentary' && !item.questions?.length);
    for (const item of commentary) {
      if (!item.text) continue;
      let record = local.commentaryTexts.get(item.id);
      if (!record) {
        const historical = initial && item !== commentary.at(-1);
        record = { id: item.id, text: item.text, sentText: historical ? item.text : '',
          changedAt: now(), segment: 0, name: messageHeader(id, turn, item.id, false, !historical).trimEnd() };
        local.commentaryTexts.set(item.id, record);
      } else if (record.text !== item.text) {
        record.text = item.text; record.changedAt = now();
      }
      // The next native item marks the paragraph boundary. A short quiet-time
      // fallback handles a final progress paragraph while work waits elsewhere.
      if (terminal(turn.status) || item !== turn.items?.at(-1)) emitCommentary(id, record);
    }
  }
  function sendRunningStats(id, force = false) {
    const local = sessions.get(id), state = client.getState(id), turn = state && canonicalTurns(state).at(-1);
    if (!local || local.disconnected || !working(state, turn)) return;
    if (!force && now() - (local.lastStatsAt ?? -Infinity) < (options.statsIntervalMs ?? 10000)) return;
    const durationMs = turnElapsedMs(turn, { now: now(), fallbackStartedAtMs: local.startedAt });
    send(id, { type: 'running_stats', durationMs, inputTokens: turn.usage?.inputTokens ?? 0, outputTokens: turn.usage?.outputTokens ?? 0 });
    if (local.progress) send(id, progressMessage(`${formatElapsed(durationMs)} · ${local.progress}`));
    local.lastStatsAt = now();
  }
  function syncTerminalDisplay(id, state, force = false) {
    const local = sessions.get(id), turn = state && canonicalTurns(state).at(-1);
    if (!local || !turn || !terminal(turn.status) || conversationStatus(state) === 'busy' || local.status === 'busy') return;
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
    catch (error) { if (error.statusCode !== 409) storageError = error; throw error; }
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

  function showAction(id, actions, force = false) {
    const local = sessions.get(id), action = actions[0];
    if (!action) { local.action = null; local.presentation = null; return; }
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
      if (displayed) send(id, { type: 'question_answer', answers: { [displayed]: reply.answer } });
      else send(id, { type: 'user_prompt', text: `${reply.question}\n${reply.answer}` });
    }
  }

  function observe(id, state) {
    const local = sessions.get(id); if (!local || !state) return;
    local.disconnected = false;
    const turns = canonicalTurns(state), turn = turns.at(-1), actions = pendingActions(state);
    try { store?.reconcilePrompt(id, turns); store?.reconcileActions(id, actions); }
    catch (error) { storageError = error; report(id, error); }
    const pending = store?.prompt(id);
    let status = conversationStatus(state);
    if (pending && pending.phase !== 'unknown' && status === 'idle') status = 'busy';
    const key = turn?.params?.clientUserMessageId ?? turn?.turnId, initial = !local.ready;
    if (key && key !== local.turnKey) {
      if (local.ready) endActivity(id);
      local.turnKey = key; local.texts = new Map(); local.finished = false;
      local.startedAt = now(); local.progress = ''; local.thinking = false;
      local.commentaryTexts = new Map(); local.lastStatsAt = undefined;
      local.finalLabelSent = false; local.finalTextOpen = false;
      if (!initial || !terminal(turn.status)) {
        const text = textInput(turn.params?.input);
        // Async answer transport is represented once by accepted native replies.
        if (text && !parseAsyncQuestionReply(text)) send(id, { type: 'user_prompt', text: displayUserText(text) });
      }
    }
    showAcceptedQuestionReplies(id, state, initial, turn);
    const items = turn?.items ?? [];
    const messages = items.filter(i => i.type === 'agentMessage' && typeof i.text === 'string');
    const finals = messages.filter(i => !i.questions?.length && (i.phase === 'final_answer' || !i.phase));
    const done = turn && terminal(turn.status);
    let finishedNow = false;
    if (initial && (done || status === 'idle')) {
      for (const item of finals) local.texts.set(item.id, item.text);
      local.finished = true;
    } else {
      // Public commentary is ordinary visible assistant text in the Mac app.
      if (!done || !local.finished) showCommentary(id, turn, messages, initial);
      const commentary = messages.filter(i => i.phase === 'commentary' && !i.questions?.length).at(-1)?.text;
      const activeTool = items.filter(i => TOOL_NAMES[i.type] && i.status === 'inProgress').at(-1);
      const heading = items.map(publicActivityHeading).filter(Boolean).at(-1);
      const progress = done ? '' : heading || commentary || (activeTool ? publicToolLabel(activeTool) : status === 'busy' ? 'Working…' : '');
      if (progress !== local.progress) {
        send(id, progress ? progressMessage(`${formatElapsed(turnElapsedMs(turn, { now: now(), fallbackStartedAtMs: local.startedAt }))} · ${progress}`) : clearProgressMessage()); local.progress = progress;
      }
      const thinking = !done && items.at(-1)?.type === 'reasoning';
      if (thinking !== local.thinking) { send(id, { type: 'status', state: thinking ? 'think_start' : 'think_end' }); local.thinking = thinking; }
      for (const item of finals) {
        const previous = local.texts.get(item.id) ?? '';
        if (item.text.startsWith(previous) && item.text.length > previous.length) {
          closeCommentary(id);
          if (!local.finalTextOpen) { send(id, { type: 'status', state: 'text_start' }); local.finalTextOpen = true; }
          if (!local.finalLabelSent) {
            send(id, { type: 'text_delta', text: messageHeader(id, turn, item.id, true, true), bridgeFinalHeader: true }); local.finalLabelSent = true;
          }
          send(id, { type: 'text_delta', text: item.text.slice(previous.length) });
        }
        local.texts.set(item.id, item.text);
      }
      if (done && !local.finished) {
        endActivity(id);
        const failure = turn.error?.message ?? (turn.status === 'interrupted' ? 'Stopped by user.' : 'Codex could not complete this response.');
        if (turn.status === 'failed') send(id, { type: 'error', message: failure });
        send(id, { type: 'result', success: turn.status === 'completed',
          text: finals.map(i => i.text).join('\n\n') || (turn.status === 'completed' ? '' : failure),
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
    endActivity(id);
    report(id, Object.assign(new Error('IPC_DISCONNECTED'), { code: 'IPC_DISCONNECTED' }));
    setStatus(id, 'idle', 'Reconnecting to Mac');
  };
  client.on('disconnected', () => { for (const id of sessions.keys()) disconnected(id); });
  client.on('threadDisconnected', disconnected);
  client.on('reconnecting', () => { for (const id of sessions.keys()) setStatus(id, 'idle', 'Reconnecting to Mac'); });

  async function watch(id, { reshowAction = false } = {}) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw codedError('Invalid task identifier.', 400);
    await checkBuild();
    if (!(await catalog()).some(t => t.id === id)) throw codedError('Open an existing Codex task in the Mac app, then select it on your glasses.', 404);
    let local = sessions.get(id);
    if (!local) {
      local = { ready: false, turnKey: null, texts: new Map(), status: 'idle', detail: 'Connecting to Mac', lastAccess: Date.now(), lastSeen: 0,
        questionLabels: new Map(), shownAnswers: new Set(), messageHeaders: new Map() };
      sessions.set(id, local);
    }
    local.lastAccess = Date.now(); await client.follow(id);
    const state = client.getState(id); if (state) observe(id, state);
    if (reshowAction) showAction(id, pendingActions(state), true);
    if (reshowAction) syncTerminalDisplay(id, state, true);
    if (reshowAction) sendRunningStats(id, true);
    return state;
  }
  async function refresh(id) {
    const entry = await client.refresh(id), state = entry?.state ?? client.getState(id);
    if (state) observe(id, state); return state;
  }

  async function respond(id, input) {
    if (actionSending.has(id)) throw codedError('A response is already being sent for this task.', 409);
    actionSending.add(id);
    try {
      ensureStorage(); await watch(id);
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
        else if (result?.resolution === 'resolved-elsewhere') send(id, progressMessage('This request was answered on another device.'));
        else if (result?.confirmed === true && response.answers && action.kind !== 'async-question') send(id, { type: 'question_answer', answers: Object.fromEntries((presentation.questions ?? []).map(question => [question.displayed, response.answers[question.id]?.answers?.join(', ') ?? 'Skipped'])) });
        else if (result?.confirmed === true && action.kind.endsWith('approval')) send(id, { type: 'permission_result', toolName: action.title, summary: 'Your choice was sent. This request is now closed.',
          decision: /deny|decline|cancel/.test(response.choiceId ?? '') ? 'denied' : 'allowed' });
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
      if (!store?.prompt(id) && !unresolvedAction && !actionSending.has(id) && Date.now() - local.lastAccess > 180000 && !options.hasClients?.(id)) {
        client.unfollow(id); sessions.delete(id); continue;
      }
      if (refreshing.has(id)) continue;
      refreshing.add(id);
      checkBuild().then(() => refresh(id)).catch(error => report(id, error)).finally(() => refreshing.delete(id));
    }
  }, options.refreshIntervalMs ?? 20000);
  interval.unref();
  const statsInterval = setInterval(() => {
    if (!closed) for (const id of sessions.keys()) sendRunningStats(id);
  }, options.statsIntervalMs ?? 10000);
  statsInterval.unref();
  const commentaryInterval = setInterval(() => {
    if (closed) return;
    for (const [id, local] of sessions) {
      if (local.disconnected) continue;
      for (const record of local.commentaryTexts?.values() ?? []) {
        if (now() - record.changedAt >= (options.commentarySettleMs ?? 1500)) emitCommentary(id, record);
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
        provider: 'codex', status: sessions.get(t.id)?.status ?? 'idle', statusKnown: sessions.has(t.id),
      }));
    },
    async getSessionStatus(id) { return sessions.get(id)?.status ?? 'idle'; },
    async getInfo() { return { account: {}, model: 'Codex — Mac app', version: 'G2 Desktop Bridge 0.2.7', provider: 'codex' }; },
    async getHistory(id, limit = 10) {
      const state = await watch(id);
      const turns = canonicalTurns(state);
      const questions = new Set(turns.flatMap(turn => (turn.items ?? []).filter(item => item.questions?.length).map(item => item.id)));
      const byTurn = new Map(turns.map(turn => [turn.turnId, turn]));
      return readableHistory(state, 1000).filter(m => !questions.has(m.itemId))
        .map(m => m.role === 'user' ? { ...m, text: displayUserText(m.text) }
          : { ...m, text: messageHeader(id, byTurn.get(m.turnId), m.itemId, m.phase !== 'commentary') + m.text }).slice(-Math.max(1, limit));
    },
    async watch(id) { try { return await watch(id, { reshowAction: true }); } catch (error) { report(id, error); throw error; } },
    async prompt(id, text) {
      if (!id) throw codedError('Create or open a task in the Mac app, then select it on your glasses.', 400);
      if (typeof text !== 'string' || !text.trim()) throw codedError('Enter a message first.', 400);
      if (starting.has(id)) throw codedError('A message is already being sent for this task.', 409);
      starting.add(id);
      try {
        ensureStorage(); await watch(id);
        const state = await refresh(id), actions = pendingActions(state);
        if (actions.length) throw codedError('Please answer the displayed question or approval using its controls. Your message has not been sent as a new task instruction.', 409);
        const steering = conversationStatus(state) === 'busy';
        if (conversationStatus(state) === 'awaiting') throw codedError('This task needs a response in the Mac app or Remote before it can continue.', 409);
        const clientUserMessageId = randomUUID(); beginDelivery(() => store.beginPrompt(id, clientUserMessageId));
        setStatus(id, 'busy', 'Sending message');
        let acknowledged = false;
        try {
          const result = steering ? await client.steerTurn(id, text, clientUserMessageId) : await client.startTurn(id, text, clientUserMessageId);
          acknowledged = true;
          store.markPrompt(id, { phase: 'acknowledged', ...(!steering ? { turnId: result?.turn?.id } : {}) }); observe(id, client.getState(id) ?? state);
        } catch (error) {
          if (acknowledged) error.outcomeUnknown = true;
          try { if (error.outcomeUnknown) store.markPrompt(id, { phase: 'unknown' }); else store.clearPrompt(id); }
          catch (storageFailure) { storageError = storageFailure; }
          observe(id, client.getState(id) ?? state); throw error;
        }
        return { sessionId: id, provider: 'codex' };
      } catch (error) { report(id, error); throw error; }
      finally { starting.delete(id); }
    },
    async interrupt(id) {
      try {
        await watch(id); await checkBuild(); const result = await client.interrupt(id);
        const state = client.getState(id); if (state) observe(id, state);
        if (store?.prompt(id)) throw codedError('Stop is unconfirmed for the pending message. Check the task on the Mac or in Remote before sending again.', 409);
        return result;
      } catch (error) { report(id, error); throw error; }
    },
    respondPermission(id, decision, context = {}) { return respond(id, { ...context, decision }); },
    respondQuestion(id, answer, context = {}) { return respond(id, { ...context, answer }); },
    respondAction(id, input) { return respond(id, input); },
    async getActions(id) {
      await watch(id);
      const local = sessions.get(id);
      return pendingActions(client.getState(id)).map((a, index) => ({ ...a, presentation: index === 0 ? local.presentation : null }));
    },
    getStatus(id) {
      const local = sessions.get(id); return local ? { state: local.status, detail: local.detail, lastUpdate: local.lastSeen, provider: 'codex' } : null;
    },
    getSubscribedSessions() {
      return [...sessions].map(([threadId, s]) => ({ threadId, status: s.status, detail: s.detail,
        submissionPending: Boolean(store?.prompt(threadId)) || actionSending.has(threadId) || Object.values(store?.data.actions ?? {}).some(a => a.threadId === threadId),
        idleSinceMs: Date.now() - s.lastAccess }));
    },
    async close() { closed = true; clearInterval(interval); clearInterval(statsInterval); clearInterval(commentaryInterval); await client.close(); },
  };
}
