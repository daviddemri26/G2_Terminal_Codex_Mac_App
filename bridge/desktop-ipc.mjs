import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import net from 'node:net';

// Private desktop protocol, verified against the installed desktop bundle.
// This is a follower only: it never creates a router, resumes an app-server
// writer or replays a submitted message/action. Actions require an explicit
// selection bound to a freshly checked request ID and fingerprint.
export const VERSIONS = Object.freeze({
  'thread-owner-discovery': 1,
  'thread-stream-following-changed': 1,
  'thread-stream-state-changed': 11,
  'thread-follower-start-turn': 2,
  'thread-follower-load-complete-history': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-steer-turn': 1,
  'thread-follower-submit-user-input': 1,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-mcp-server-elicitation-response': 1,
});
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);

export class DesktopIpcError extends Error {
  constructor(message, { code = 'IPC_ERROR', method, outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'DesktopIpcError';
    this.code = code;
    this.method = method;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function encodeFrame(message, maxBytes = MAX_FRAME_BYTES) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (!body.length || body.length > maxBytes) throw new DesktopIpcError('IPC frame exceeds its size limit', { code: 'IPC_FRAME_LIMIT' });
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  constructor(onMessage, maxBytes = MAX_FRAME_BYTES) {
    this.onMessage = onMessage;
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (!size || size > this.maxBytes) throw new DesktopIpcError('Invalid IPC frame size', { code: 'IPC_FRAME_LIMIT' });
      if (this.buffer.length < size + 4) return;
      const body = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      const message = JSON.parse(body.toString('utf8'));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid IPC message');
      this.onMessage(message);
    }
  }
}

export async function validateSocketPath(socketPath) {
  if (!isAbsolute(socketPath) || typeof process.getuid !== 'function') throw new Error('A local Unix socket path is required');
  const directory = dirname(socketPath);
  const [socket, parent, actual] = await Promise.all([lstat(socketPath), lstat(directory), realpath(socketPath)]);
  const uid = process.getuid();
  if (!socket.isSocket() || socket.isSymbolicLink() || actual !== socketPath || !parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('Desktop IPC path must be a real socket in a real directory');
  }
  if (socket.uid !== uid || parent.uid !== uid || (socket.mode & 0o077) || (parent.mode & 0o077)) {
    throw new Error('Desktop IPC socket and directory must be private to the current user');
  }
}

// Immer uses an array of path components and array splice semantics.
export function applyPatches(state, patches) {
  if (!Array.isArray(patches)) throw new Error('Invalid IPC patches');
  let next = structuredClone(state);
  for (const patch of patches) {
    if (!patch || !['add', 'remove', 'replace'].includes(patch.op) || !Array.isArray(patch.path)) throw new Error('Unsupported IPC patch');
    if (patch.path.some(key => BAD_KEYS.has(String(key)) || !['string', 'number'].includes(typeof key))) throw new Error('Unsafe IPC patch path');
    if (!patch.path.length) {
      if (patch.op === 'remove') throw new Error('Cannot remove the conversation root');
      next = structuredClone(patch.value);
      continue;
    }
    let parent = next;
    for (const key of patch.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('IPC patch path does not exist');
      parent = parent[key];
    }
    const key = patch.path.at(-1);
    if (!parent || typeof parent !== 'object') throw new Error('Invalid IPC patch parent');
    if (Array.isArray(parent)) {
      const index = key === '-' && patch.op === 'add' ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length || (patch.op !== 'add' && index === parent.length)) throw new Error('Invalid IPC array index');
      if (patch.op === 'add') parent.splice(index, 0, structuredClone(patch.value));
      else if (patch.op === 'remove') parent.splice(index, 1);
      else parent[index] = structuredClone(patch.value);
    } else {
      if (patch.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error('IPC patch field does not exist');
      if (patch.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(patch.value);
    }
  }
  return next;
}

function mergeItems(base = [], overlay = []) {
  const out = [...base];
  for (const item of overlay) {
    const index = item.id == null ? -1 : out.findIndex(candidate => candidate.id === item.id);
    if (index < 0) out.push(item);
    else {
      const prior = out[index];
      // A stale optimistic overlay must not shorten already streamed text.
      const keepText = typeof prior.text === 'string' && typeof item.text === 'string' && prior.text.startsWith(item.text);
      // An accepted native steering item is immutable receipt evidence. A
      // stale optimistic overlay must not downgrade it back to pending.
      const keepAcceptedSteering = prior.type === 'steeringUserMessage' && prior.status === 'accepted' &&
        item.type === 'steeringUserMessage' && item.status !== 'accepted';
      out[index] = keepAcceptedSteering ? { ...item, ...prior }
        : { ...prior, ...item, ...(keepText ? { text: prior.text } : {}) };
    }
  }
  return out;
}

export function canonicalTurns(state) {
  if (!state) return [];
  if (state.turnHistory?.kind !== 'canonical') return state.turns ?? [];
  const history = state.turnHistory.history;
  const out = (history?.islands ?? []).flatMap(island => (island.entries ?? []).map(entry => history.entitiesByKey?.[entry.value]).filter(Boolean));
  // Desktop X_ merges canonical history with local/optimistic turns.
  for (const turn of state.turns ?? []) {
    const index = out.findIndex(candidate =>
      (turn.turnId != null && candidate.turnId === turn.turnId) ||
      (turn.params?.clientUserMessageId && candidate.params?.clientUserMessageId === turn.params.clientUserMessageId));
    if (index < 0) out.push(turn);
    else {
      const prior = out[index];
      out[index] = {
        ...prior, ...turn,
        turnId: turn.turnId ?? prior.turnId,
        params: { ...prior.params, ...turn.params },
        items: mergeItems(prior.items, turn.items),
        status: TERMINAL.has(prior.status) && turn.status === 'inProgress' ? prior.status : turn.status ?? prior.status,
      };
    }
  }
  return out;
}

export function latestTurn(state) {
  return canonicalTurns(state).at(-1) ?? null;
}

export function textFromInput(input) {
  return (Array.isArray(input) ? input : []).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n').trim();
}

export function readableHistory(state, limit = 10) {
  limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (!limit) return [];
  const messages = [];
  for (const turn of canonicalTurns(state)) {
    const items = turn.items ?? [];
    if (!items.some(item => item.type === 'userMessage')) {
      const text = textFromInput(turn.params?.input);
      if (text) messages.push({ role: 'user', text, turnId: turn.turnId, itemId: `input:${turn.turnId ?? turn.params?.clientUserMessageId ?? ''}` });
    }
    for (const item of items) {
      let role, text;
      if (item.type === 'userMessage') { role = 'user'; text = textFromInput(item.content); }
      else if (item.type === 'steeringUserMessage' && !item.serverUserMessageId) { role = 'user'; text = textFromInput(item.input); }
      else if (item.type === 'agentMessage') { role = 'assistant'; text = typeof item.text === 'string' ? item.text : ''; }
      if (text) messages.push({ role, text, turnId: turn.turnId, itemId: item.id, ...(item.phase ? { phase: item.phase } : {}) });
    }
  }
  return messages.slice(-limit);
}

export function conversationStatus(state) {
  if (!state) return 'disconnected';
  if (state.unconfirmedTurnSubmissions?.some(submission => submission.terminal !== true)) return 'busy';
  const runtime = state.threadRuntimeStatus;
  const requests = state.requests ?? [];
  if (runtime?.activeFlags?.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') || requests.some(request => [
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
    'item/tool/requestUserInput', 'item/tool/requestOptionPicker', 'mcpServer/elicitation/request',
  ].includes(request.method))) return 'awaiting';
  if (runtime?.type === 'active' || latestTurn(state)?.status === 'inProgress') return 'busy';
  return 'idle';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function requestFingerprint(request) {
  return createHash('sha256').update(stableJson(request)).digest('hex');
}

const QUESTION_OPEN = '<send_user_message_question_reply>';
const QUESTION_CLOSE = '</send_user_message_question_reply>';
export function parseAsyncQuestionReply(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (!value.startsWith(QUESTION_OPEN) || !value.endsWith(QUESTION_CLOSE)) return null;
  try {
    const parsed = JSON.parse(value.slice(QUESTION_OPEN.length, -QUESTION_CLOSE.length));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.length && rows.every(row => row && ['questionItemId', 'question', 'answer'].every(key => typeof row[key] === 'string')) ? rows : null;
  } catch { return null; }
}

// A native start acknowledgement can precede insertion of its userMessage
// item. A server-assigned turn ID plus its exact client message ID provides
// accepted input evidence in that interval. Optimistic/unconfirmed turns do
// not. Keep the identity with each answer to distinguish a concurrent reply.
export function acceptedAsyncQuestionReplies(state) {
  const replies = [];
  const uncertain = new Set((state?.unconfirmedTurnSubmissions ?? [])
    .filter(submission => submission.terminal !== true).map(submission => submission.clientUserMessageId)
    .filter(id => typeof id === 'string' && id));
  const add = (input, clientUserMessageId, turnId, source) => {
    if (!Array.isArray(input) || input.length !== 1 || input[0]?.type !== 'text') return;
    for (const reply of parseAsyncQuestionReply(input[0].text) ?? []) {
      replies.push({ ...reply, clientUserMessageId: clientUserMessageId ?? null, turnId, source });
    }
  };
  for (const turn of canonicalTurns(state)) {
    const messageId = turn.params?.clientUserMessageId;
    const acceptedTurn = typeof turn.turnId === 'string' && Boolean(turn.turnId) &&
      typeof messageId === 'string' && Boolean(messageId) && !uncertain.has(messageId);
    if (acceptedTurn) add(turn.params?.input, messageId, turn.turnId, 'turnInput');
    const initialUserItem = (turn.items ?? []).find(item => item.type === 'userMessage');
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage' && turn.turnId != null && !uncertain.has(item.clientId)) {
        const sameInitialInput = item === initialUserItem && acceptedTurn && item.content?.length === 1 &&
          turn.params?.input?.length === 1 && item.content[0]?.type === 'text' &&
          item.content[0]?.text === turn.params.input[0]?.text;
        add(item.content, item.clientId ?? (sameInitialInput ? messageId : null), turn.turnId, 'userMessage');
      } else if (item.type === 'steeringUserMessage' && item.status === 'accepted' && !uncertain.has(item.clientUserMessageId)) {
        add(item.input, item.clientUserMessageId, turn.turnId, 'steeringUserMessage');
      }
    }
  }
  return replies;
}

function normalizedQuestions(questions) {
  return (questions ?? []).map(question => ({
    id: question.id, header: question.header ?? '', question: question.question ?? question.title ?? '',
    multiSelect: question.multiSelect === true || question.allowMultiple === true,
    isSecret: question.isSecret === true,
    options: (question.options ?? []).map(option => typeof option === 'string'
      ? { label: option, description: '' }
      : { label: option.label ?? option.title ?? '', description: option.description ?? '' }),
  }));
}

function decisionChoice(decision, index) {
  const labels = { accept: 'Allow once', acceptForSession: 'Allow for this session', decline: 'Deny', cancel: 'Cancel' };
  if (typeof decision === 'string' && labels[decision]) return { id: decision, label: labels[decision], value: decision };
  if (decision?.acceptWithExecpolicyAmendment) return { id: `command-rule-${index}`, label: 'Allow and save this command rule', value: decision };
  if (decision?.applyNetworkPolicyAmendment) return { id: `network-rule-${index}`, label: 'Apply the displayed network rule', value: decision };
  return null;
}

export function pendingActions(state) {
  if (!state) return [];
  const actions = [];
  for (const request of state.requests ?? []) {
    const p = request.params ?? {};
    const base = { id: request.id, method: request.method, fingerprint: requestFingerprint(request), turnId: p.turnId ?? null,
      title: '', description: p.reason ?? p.message ?? '', supported: true, choices: [] };
    if (request.method === 'item/tool/requestUserInput' ||
      (request.method === 'item/tool/call' && p.tool === 'request_onboarding_input')) {
      const questions = request.method === 'item/tool/call' ? p.arguments?.questions : p.questions;
      actions.push({ ...base, kind: 'question', title: 'Question from Codex', questions: normalizedQuestions(questions),
        supported: Array.isArray(questions) && questions.length > 0 && questions.every(question =>
          typeof question.id === 'string' && question.id && !BAD_KEYS.has(question.id)) && new Set(questions.map(question => question.id)).size === questions.length });
    } else if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
      const decisions = Array.isArray(p.availableDecisions) && p.availableDecisions.length
        ? p.availableDecisions : p.additionalPermissions ? ['accept', 'cancel'] : ['accept', 'decline'];
      const command = Array.isArray(p.command) ? p.command.join(' ') : p.command;
      actions.push({ ...base, kind: request.method.includes('commandExecution') ? 'command-approval' : 'file-approval',
        title: request.method.includes('commandExecution') ? 'Allow this command?' : 'Allow these file changes?',
        description: [p.reason, command].filter(Boolean).join('\n'),
        choices: decisions.map(decisionChoice).filter(Boolean), details: { cwd: p.cwd ?? null, command: command ?? null, changes: p.changes ?? null } });
    } else if (request.method === 'item/permissions/requestApproval') {
      actions.push({ ...base, kind: 'permissions-approval', title: 'Allow these permissions?', permissions: p.permissions ?? {}, choices: [
        { id: 'allow_once', label: 'Allow for this turn', value: { permissions: p.permissions ?? {}, scope: 'turn' } },
        { id: 'allow_session', label: 'Allow for this session', value: { permissions: p.permissions ?? {}, scope: 'session' } },
        { id: 'deny', label: 'Deny', value: { permissions: {}, scope: 'turn' } },
      ] });
    } else if (request.method === 'mcpServer/elicitation/request') {
      const form = p.mode === 'form' && simpleFormSchema(p.requestedSchema);
      const verification = p.mode === 'openai/userVerification' || p._meta?.codex_approval_kind === 'browser_auth';
      const toolParams = p._meta?.tool_params;
      const specializedApproval = toolParams && typeof toolParams === 'object' &&
        (Object.hasOwn(toolParams, 'confirmation_summary') || Object.hasOwn(toolParams, 'plan_token'));
      const acceptSupported = form && !verification && !specializedApproval;
      actions.push({ ...base, kind: 'elicitation', title: p.title ?? 'Request from a connected tool', mode: p.mode,
        schema: acceptSupported ? p.requestedSchema : null,
        details: { serverName: p.serverName ?? null, toolName: typeof p._meta?.tool_name === 'string' ? p._meta.tool_name : null },
        reason: verification ? 'Complete verification in Codex or Remote.' : specializedApproval ? 'Review the detailed operation approval in Codex or Remote.'
          : !form ? 'Complete this form or sign-in in Codex or Remote.' : null,
        choices: [...(acceptSupported ? [{ id: 'accept', label: 'Submit / Allow once', value: 'accept' }] : []),
          { id: 'decline', label: 'Decline', value: 'decline' }, { id: 'cancel', label: 'Cancel', value: 'cancel' }] });
    } else if (request.method === 'item/tool/requestOptionPicker' ||
      (request.method === 'item/tool/call' && p.tool === 'request_option_picker')) {
      actions.push({ ...base, kind: 'option-picker', title: p.question ?? p.arguments?.question ?? 'Choose an option', supported: false,
        reason: 'The desktop follower protocol does not expose the option-picker response route.',
        questions: normalizedQuestions([{ id: request.id, ...(p.arguments ?? p) }]) });
    } else if (request.method === 'item/plan/requestImplementation') {
      const mode = defaultCollaborationMode(state);
      const supported = typeof p.planContent === 'string' && Boolean(p.planContent.trim()) &&
        p.turnId === latestTurn(state)?.turnId && conversationStatus(state) === 'idle' && mode !== null;
      actions.push({ ...base, kind: 'plan-implementation', title: 'Implement this plan?', supported,
        plan: p.planContent ?? '', choices: [{ id: 'implement', label: 'Implement this plan', value: 'implement' }],
        reason: supported ? null : 'Open the current plan in Codex or Remote before implementing it.' });
    }
  }
  // Historical question metadata is not an active request. Native async
  // notifications target the current turn; a later user instruction supersedes
  // earlier questions even when their reply items are no longer loaded. Keep
  // the current completed turn answerable for the supported post-completion
  // flow, but never turn a stopped or historical question into a new prompt.
  const current = latestTurn(state);
  if (typeof current?.turnId !== 'string' || !current.turnId || !['inProgress', 'completed'].includes(current.status)) return actions;
  const turnId = current.turnId;
  const answered = new Set(acceptedAsyncQuestionReplies(state).map(reply => reply.questionItemId));
  for (const item of current.items ?? []) {
    if (item.type !== 'agentMessage' || typeof item.id !== 'string' || !item.id || !Array.isArray(item.questions)) continue;
    for (const [index, question] of item.questions.entries()) {
      if (!question || typeof question !== 'object' || typeof question.title !== 'string' || !question.title.trim()) continue;
      const id = JSON.stringify(['request_user_input_async', item.id, index]);
      if (answered.has(id)) continue;
      const source = { id, turnId, sourceItemId: item.id, questionIndex: index, question };
      actions.push({ id, kind: 'async-question', method: 'agentMessage.questions', title: question.title ?? 'Question from Codex',
        description: '', supported: true, fingerprint: requestFingerprint(source), turnId, sourceItemId: item.id,
        questions: normalizedQuestions([{ ...question, id, question: question.title }]), choices: [] });
    }
  }
  return actions;
}

function simpleFormSchema(schema, depth = 0) {
  // Defer constraints we cannot faithfully validate rather than silently
  // flattening advanced forms into an unrestricted approval.
  if (!schema || typeof schema !== 'object' || depth > 4 || ['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'pattern', 'format',
    'patternProperties', 'dependentSchemas', 'if', 'then', 'else', 'contains', 'prefixItems'].some(key => key in schema)) return false;
  if (schema.type === 'object') return Object.values(schema.properties ?? {}).every(value => simpleFormSchema(value, depth + 1));
  if (schema.type === 'array') return simpleFormSchema(schema.items, depth + 1);
  return ['string', 'boolean', 'integer', 'number', 'null'].includes(schema.type);
}

function validateForm(schema, value, path = 'form') {
  const fail = () => { throw new DesktopIpcError(`Invalid value for ${path}`, { code: 'IPC_INVALID_ACTION' }); };
  if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(item, value))) fail();
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(schema.const, value)) fail();
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail();
    for (const [key, field] of Object.entries(value)) {
      if (BAD_KEYS.has(key) || !Object.hasOwn(schema.properties ?? {}, key)) fail();
      validateForm(schema.properties[key], field, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || (schema.minItems != null && value.length < schema.minItems) || (schema.maxItems != null && value.length > schema.maxItems)) fail();
    value.forEach((item, index) => validateForm(schema.items, item, `${path}[${index}]`));
    if (schema.uniqueItems && new Set(value.map(stableJson)).size !== value.length) fail();
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength != null && value.length < schema.minLength) || (schema.maxLength != null && value.length > schema.maxLength)) fail();
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) ||
      (schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum) ||
      (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) || (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) ||
      (schema.multipleOf != null && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-10)) fail();
  } else if (schema.type === 'boolean' ? typeof value !== 'boolean' : value !== null) fail();
}

function validatedAnswers(questions, answers, { allowSkip = false } = {}) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new DesktopIpcError('Select an answer for each question', { code: 'IPC_INVALID_ACTION' });
  // The native synchronous question Skip button submits exactly {answers:{}}.
  // Async questions use a text reply and have no equivalent empty response.
  if (allowSkip && Object.keys(answers).length === 0) return Object.create(null);
  const allowed = new Set(questions.map(question => String(question.id)));
  if (Object.keys(answers).some(key => !allowed.has(key) || BAD_KEYS.has(key))) throw new DesktopIpcError('The answer does not belong to this question', { code: 'IPC_INVALID_ACTION' });
  const result = Object.create(null);
  for (const question of questions) {
    const raw = answers[question.id];
    const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : raw?.answers;
    if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim())) throw new DesktopIpcError('Select an answer for each question', { code: 'IPC_INVALID_ACTION' });
    result[question.id] = { answers: [...values] };
  }
  return result;
}

export function turnStartParams(threadId, text, clientUserMessageId = randomUUID()) {
  if (!threadId || typeof text !== 'string' || !text.trim()) throw new Error('A task ID and nonempty text are required');
  if (typeof clientUserMessageId !== 'string' || !clientUserMessageId || clientUserMessageId.length > 256) throw new Error('Invalid client user message ID');
  return { conversationId: threadId, turnStart: {
    request: { threadId, clientUserMessageId, input: [{ type: 'text', text, text_elements: [] }] },
    context: { inheritThreadSettings: true },
  } };
}

function defaultCollaborationMode(state) {
  const settings = state.latestThreadSettings;
  const collaboration = settings?.collaborationMode ?? state.latestCollaborationMode;
  const model = settings?.model ?? collaboration?.settings?.model ?? state.latestModel;
  if (typeof model !== 'string' || !model.trim()) return null;
  const effort = settings?.effort !== undefined ? settings.effort
    : collaboration?.settings?.reasoning_effort ?? state.latestReasoningEffort ?? null;
  // Native getModeForSelection('default') preserves the selected model and
  // effort and explicitly clears the prior plan developer instructions.
  return { mode: 'default', settings: { model, reasoning_effort: effort, developer_instructions: null } };
}

function observedActionResolution(state, action, { expectedAnswers, expectedAsyncReply, messageId }) {
  if (!state) return null;
  if (expectedAsyncReply) {
    const observed = acceptedAsyncQuestionReplies(state).filter(reply => reply.questionItemId === action.id).at(-1);
    if (!observed) return null;
    return { resolution: observed.clientUserMessageId === messageId && observed.question === expectedAsyncReply.question &&
      observed.answer === expectedAsyncReply.answer ? 'answer-confirmed' : 'resolved-elsewhere' };
  }
  if (pendingActions(state).some(candidate => candidate.id === action.id && candidate.fingerprint === action.fingerprint)) return null;
  if (expectedAnswers) {
    const answerItem = canonicalTurns(state).filter(turn => !action.turnId || turn.turnId === action.turnId)
      .flatMap(turn => turn.items ?? []).findLast(item => item.type === 'userInputResponse' && item.requestId === action.id && item.completed);
    if (answerItem) {
      const expected = Object.fromEntries(Object.entries(expectedAnswers).map(([id, value]) => [id, value.answers]));
      return { resolution: isDeepStrictEqual(answerItem.answers, expected) ? 'answer-confirmed' : 'resolved-elsewhere' };
    }
  }
  return { resolution: 'request-resolved' };
}

function isMutation(method) {
  return method.startsWith('thread-follower-') && method !== 'thread-follower-load-complete-history';
}

export class DesktopIpcClient extends EventEmitter {
  constructor({ socketPath = join(homedir(), '.codex', 'ipc', 'ipc.sock'), timeoutMs = 10000, maxFrameBytes = MAX_FRAME_BYTES,
    socketFactory = path => net.createConnection(path), validatePath = validateSocketPath,
    reconnectDelays = [500, 1000, 2000, 5000, 10000, 30000],
    actionConfirmationMs = Math.min(timeoutMs, 4000), actionConfirmationPollMs = 200 } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.socketFactory = socketFactory;
    this.validatePath = validatePath;
    this.clientId = 'initializing-client';
    this.socket = null;
    this.pending = new Map();
    this.entries = new Map();
    this.wanted = new Set();
    this.following = new Map();
    this.followEpochs = new Map();
    this.snapshotWaiters = new Map();
    this.resyncing = new Set();
    this.connecting = null;
    this.closed = false;
    this.actionGuards = new Map();
    this.reconnectDelays = reconnectDelays;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.recovering = false;
    this.actionConfirmationMs = Math.max(0, actionConfirmationMs);
    this.actionConfirmationPollMs = Math.max(10, actionConfirmationPollMs);
    // Always emit errors, without making an unattached observer crash Node.
    this.on('error', () => {});
  }

  get connected() { return Boolean(this.socket?.writable && this.clientId !== 'initializing-client'); }
  getState(threadId) { const entry = this.entries.get(threadId); return entry?.synced ? entry.state : null; }
  getEntry(threadId) { return this.entries.get(threadId) ?? null; }

  async connect() {
    if (this.closed) throw new DesktopIpcError('Desktop IPC client is closed', { code: 'IPC_CLOSED' });
    if (this.connected) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async _connect() {
    await this.validatePath(this.socketPath);
    const socket = this.socketFactory(this.socketPath);
    this.socket = socket;
    const decoder = new FrameDecoder(message => this._handleMessage(message), this.maxFrameBytes);
    socket.on('data', chunk => { try { decoder.push(chunk); } catch (error) { this.emit('error', error); socket.destroy(); } });
    socket.on('error', error => { if (!this.recovering) this.emit('error', error); });
    socket.on('close', () => this._disconnect(socket));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new DesktopIpcError('Desktop IPC connection timed out', { code: 'IPC_TIMEOUT' })); }, this.timeoutMs);
        const cleanup = () => { clearTimeout(timer); socket.off('connect', onConnect); socket.off('error', onError); socket.off('close', onClose); };
        const onConnect = () => { cleanup(); resolve(); };
        const onError = error => { cleanup(); reject(error); };
        const onClose = () => { cleanup(); reject(new Error('Desktop IPC closed before connection')); };
        socket.once('connect', onConnect); socket.once('error', onError); socket.once('close', onClose);
      });
      const response = await this._request('initialize', { clientType: 'even-g2-bridge' }, { version: 0 });
      if (typeof response.result?.clientId !== 'string' || !response.result.clientId) throw new Error('Desktop IPC initialization returned no client ID');
      if (this.socket !== socket || !socket.writable || this.closed) throw new DesktopIpcError('Desktop IPC closed during initialization', { code: 'IPC_DISCONNECTED' });
      this.clientId = response.result.clientId;
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.emit('connected');
      // Recovery restores observations only. No prompt is queued or replayed.
      for (const threadId of this.wanted) queueMicrotask(() => this.follow(threadId).catch(() => this._scheduleReconnect()));
      return this;
    } catch (error) { socket.destroy(); throw error; }
  }

  async request(method, params, options = {}) {
    await this.connect();
    return this._request(method, params, options);
  }

  _request(method, params, { version = VERSIONS[method] ?? 0, targetClientId, timeoutMs = this.timeoutMs } = {}) {
    const requestId = randomUUID();
    const message = { type: 'request', requestId, sourceClientId: this.clientId, method, params, version, timeoutMs,
      ...(targetClientId ? { targetClientId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DesktopIpcError(isMutation(method) ? 'Desktop submission timed out; its outcome is unknown. Check the task before sending again.' : `Desktop request timed out: ${method}`, {
          code: 'IPC_TIMEOUT', method, outcomeUnknown: isMutation(method),
        }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method, targetClientId });
      try { this._send(message); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  _send(message) {
    if (!this.socket?.writable) throw new DesktopIpcError('Desktop IPC is disconnected', { code: 'IPC_DISCONNECTED' });
    this.socket.write(encodeFrame(message, this.maxFrameBytes));
  }

  async discover(threadId) {
    const response = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId });
    if (typeof response.handledByClientId !== 'string' || !response.handledByClientId) throw new Error('No desktop task owner was found');
    return response.handledByClientId;
  }

  async follow(threadId) {
    if (typeof threadId !== 'string' || !threadId || threadId.length > 256) throw new Error('Invalid task ID');
    this.wanted.add(threadId);
    if (this.connected && this.entries.get(threadId)?.synced) return this.entries.get(threadId);
    if (this.following.has(threadId)) return this.following.get(threadId);
    const epoch = this.followEpochs.get(threadId) ?? 0;
    const promise = (async () => {
      const owner = await this.discover(threadId);
      if (!this.wanted.has(threadId) || (this.followEpochs.get(threadId) ?? 0) !== epoch) throw new DesktopIpcError('Task observation ended', { code: 'IPC_UNFOLLOWED' });
      this.entries.set(threadId, { owner, revision: -1, state: null, synced: false });
      return this._requestSnapshot(threadId);
    })().catch(error => {
      this._scheduleReconnect();
      throw error;
    }).finally(() => { if (this.following.get(threadId) === promise) this.following.delete(threadId); });
    this.following.set(threadId, promise);
    return promise;
  }

  async refresh(threadId) {
    await this.follow(threadId);
    return this._requestSnapshot(threadId);
  }

  _followingBroadcast(threadId, owner, following) {
    this._send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId,
      targetClientIds: [owner], params: { conversationId: threadId, hostId: 'local', following } });
  }

  _requestSnapshot(threadId, { timeoutMs = this.timeoutMs } = {}) {
    const entry = this.entries.get(threadId);
    if (!entry) return Promise.reject(new Error('Task is not followed'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this._removeWaiter(threadId, waiter);
        reject(new DesktopIpcError('Desktop task snapshot timed out', { code: 'IPC_SNAPSHOT_TIMEOUT' }));
      }, timeoutMs);
      const waiters = this.snapshotWaiters.get(threadId) ?? new Set();
      waiters.add(waiter); this.snapshotWaiters.set(threadId, waiters);
      try { this._followingBroadcast(threadId, entry.owner, true); }
      catch (error) { this._removeWaiter(threadId, waiter); reject(error); }
    });
  }

  _removeWaiter(threadId, waiter) {
    clearTimeout(waiter.timer);
    const waiters = this.snapshotWaiters.get(threadId);
    waiters?.delete(waiter);
    if (!waiters?.size) this.snapshotWaiters.delete(threadId);
  }

  _resnapshot(threadId) {
    if (this.resyncing.has(threadId)) return;
    this.resyncing.add(threadId);
    const entry = this.entries.get(threadId);
    if (entry) entry.synced = false;
    this._requestSnapshot(threadId).catch(error => {
      if (this.entries.get(threadId) !== entry) return;
      this.entries.delete(threadId);
      this.emit('error', error);
      this.emit('threadDisconnected', threadId);
      this._scheduleReconnect();
    }).finally(() => this.resyncing.delete(threadId));
  }

  _handleMessage(message) {
    if (message.type === 'client-discovery-request') {
      this._send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.resultType !== 'success') {
        const detail = String(message.error ?? 'Desktop IPC request failed');
        pending.reject(new DesktopIpcError(detail, { method: pending.method,
          // The private router serializes errors as text and drops the native
          // delivery.stage metadata. An error may follow a sent request, so it
          // is never sufficient evidence that a mutation is safe to replay.
          outcomeUnknown: isMutation(pending.method) }));
      } else if (message.method !== pending.method || (pending.targetClientId && message.handledByClientId !== pending.targetClientId)) {
        pending.reject(new DesktopIpcError('Desktop IPC response identity mismatch', { code: 'IPC_IDENTITY_MISMATCH', method: pending.method, outcomeUnknown: isMutation(pending.method) }));
      } else pending.resolve(message);
      return;
    }
    if (message.type !== 'broadcast') return;
    if (message.method === 'client-status-changed' && message.version === 0 && message.params?.status === 'disconnected' && message.sourceClientId === message.params.clientId) {
      for (const [threadId, entry] of this.entries) if (entry.owner === message.params.clientId) {
        this.entries.delete(threadId); this.emit('threadDisconnected', threadId);
        for (const waiter of [...this.snapshotWaiters.get(threadId) ?? []]) {
          this._removeWaiter(threadId, waiter);
          waiter.reject(new DesktopIpcError('Desktop task owner disconnected', { code: 'IPC_DISCONNECTED' }));
        }
      }
      this._scheduleReconnect();
      return;
    }
    if (message.method !== 'thread-stream-state-changed' || message.version !== 11) return;
    if (!Array.isArray(message.targetClientIds) || !message.targetClientIds.includes(this.clientId)) return;
    const params = message.params;
    if (params?.hostId !== 'local' || typeof params.conversationId !== 'string') return;
    const entry = this.entries.get(params.conversationId);
    if (!entry || entry.owner !== message.sourceClientId) return;
    const change = params.change;
    if (!change || !Number.isSafeInteger(change.revision) || change.revision < 0) return;
    if (change.type === 'snapshot') {
      if (!change.conversationState || change.conversationState.id !== params.conversationId || change.revision < entry.revision) return;
      entry.state = change.conversationState; entry.revision = change.revision; entry.synced = true;
      this.resyncing.delete(params.conversationId);
      for (const waiter of [...this.snapshotWaiters.get(params.conversationId) ?? []]) {
        this._removeWaiter(params.conversationId, waiter); waiter.resolve(entry);
      }
    } else if (change.type === 'patches') {
      if (change.revision <= entry.revision) return;
      if (this.resyncing.has(params.conversationId)) return;
      if (!entry.state || change.baseRevision !== entry.revision) { this._resnapshot(params.conversationId); return; }
      try {
        const next = applyPatches(entry.state, change.patches);
        if (next?.id !== params.conversationId) throw new Error('Patch changed the task identity');
        entry.state = next; entry.revision = change.revision;
      } catch (error) { this.emit('error', error); this._resnapshot(params.conversationId); return; }
    } else return;
    if ([...this.wanted].every(id => this.entries.get(id)?.synced)) this.reconnectAttempt = 0;
    this.emit('state', params.conversationId, entry.state, entry);
  }

  async startTurn(threadId, text, clientUserMessageId, expectedTurnId, { queueOnly = false, allowStopped = false, afterTurnId } = {}) {
    const entry = await this.refresh(threadId);
    if (expectedTurnId !== undefined && latestTurn(entry.state)?.turnId !== expectedTurnId) throw new DesktopIpcError('The task changed. Review your prompt again.', { code: 'IPC_STALE_TURN' });
    if (conversationStatus(entry.state) !== 'idle') throw new DesktopIpcError('This desktop task is already running or awaiting input', { code: 'IPC_TASK_BUSY' });
    if (queueOnly) {
      const turns = canonicalTurns(entry.state);
      const sourceIndex = typeof afterTurnId === 'string' && afterTurnId.length
        ? turns.findIndex(turn => turn.turnId === afterTurnId) : -1;
      if (sourceIndex < 0) throw new DesktopIpcError('The queued prompt dependency is no longer available. Review the queue.', { code: 'IPC_STALE_TURN' });
      if (turns.slice(sourceIndex).some((turn, index) => ['failed', 'interrupted'].includes(turn.status) && !(allowStopped === true && index === 0))) {
        throw new DesktopIpcError('A response stopped before this queued prompt. Review and resume the queue.', { code: 'IPC_QUEUE_STOPPED' });
      }
      const turn = turns.at(-1);
      if (expectedTurnId === undefined || pendingActions(entry.state).length || !turn ||
          !(turn.status === 'completed' || (allowStopped === true && turn.turnId === afterTurnId && ['failed', 'interrupted'].includes(turn.status)))) {
        throw new DesktopIpcError('The queued prompt must wait for the current response to finish', { code: 'IPC_TASK_BUSY' });
      }
    }
    const response = await this.request('thread-follower-start-turn', turnStartParams(threadId, text, clientUserMessageId), { targetClientId: entry.owner });
    return response.result?.result;
  }

  _steerParams(threadId, text, state, clientUserMessageId = randomUUID()) {
    const input = turnStartParams(threadId, text, clientUserMessageId).turnStart.request.input;
    const roots = state.currentPermissions?.runtimeWorkspaceRoots ?? (state.cwd ? [state.cwd] : []);
    return { conversationId: threadId, clientUserMessageId, input, attachments: [],
      restoreMessage: { text, cwd: state.cwd ?? null, context: { workspaceRoots: roots,
        collaborationMode: state.latestThreadSettings?.collaborationMode ?? state.latestCollaborationMode ?? null,
        commentAttachments: [] } } };
  }

  async steerTurn(threadId, text, clientUserMessageId = randomUUID(), expectedTurnId) {
    const entry = await this.refresh(threadId);
    const turn = latestTurn(entry.state);
    if (expectedTurnId !== undefined && turn?.turnId !== expectedTurnId) throw new DesktopIpcError('The task changed. Review your prompt again.', { code: 'IPC_STALE_TURN' });
    if (!turn?.turnId || turn.status !== 'inProgress') throw new DesktopIpcError('The task has no active turn to guide', { code: 'IPC_TASK_IDLE' });
    if (expectedTurnId !== undefined && pendingActions(entry.state).length) throw new DesktopIpcError('Answer the current question or approval before adding a prompt', { code: 'IPC_TASK_BUSY' });
    if (entry.state.unconfirmedTurnSubmissions?.some(submission => submission.terminal !== true)) throw new DesktopIpcError('An earlier message is not yet confirmed', { code: 'IPC_TASK_BUSY' });
    const response = await this.request('thread-follower-steer-turn', this._steerParams(threadId, text, entry.state, clientUserMessageId), { targetClientId: entry.owner });
    return response.result?.result;
  }

  _waitForActionResolution(threadId, action, expected) {
    const deadline = Date.now() + this.actionConfirmationMs;
    return new Promise(resolve => {
      let settled = false, pollTimer;
      const finish = resolution => {
        if (settled) return;
        settled = true; clearTimeout(deadlineTimer); clearTimeout(pollTimer);
        this.off('state', onState); resolve(resolution);
      };
      const inspect = state => {
        const resolution = observedActionResolution(state, action, expected);
        if (resolution) finish(resolution);
      };
      const onState = (id, state) => { if (id === threadId) inspect(state); };
      const deadlineTimer = setTimeout(() => finish(null), this.actionConfirmationMs);
      this.on('state', onState);
      const poll = async () => {
        if (settled) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) { finish(null); return; }
        // Resnapshot only. Never retry or substitute the action itself, and
        // never extend the acknowledgement wait past the bounded deadline.
        try {
          if (this.connected && this.entries.has(threadId)) {
            const entry = await this._requestSnapshot(threadId, { timeoutMs: Math.min(this.timeoutMs, remaining) });
            inspect(entry.state);
          }
        } catch { /* A received native ack remains acknowledged while offline. */ }
        if (!settled) pollTimer = setTimeout(poll, Math.min(this.actionConfirmationPollMs, Math.max(0, deadline - Date.now())));
      };
      inspect(this.getState(threadId));
      if (!settled) void poll();
    });
  }

  async respondAction(threadId, requestId, selection) {
    const entry = await this.refresh(threadId);
    const action = pendingActions(entry.state).find(candidate => candidate.id === requestId);
    if (!action) throw new DesktopIpcError('This request has already been resolved or is no longer available', { code: 'IPC_STALE_ACTION' });
    if (!selection || selection.kind !== action.kind || selection.expectedFingerprint !== action.fingerprint) throw new DesktopIpcError('This request changed. Review the current request before responding.', { code: 'IPC_STALE_ACTION' });
    if (!action.supported) throw new DesktopIpcError(action.reason ?? 'Complete this action in Codex or Remote', { code: 'IPC_UNSUPPORTED_ACTION' });
    const guardKey = `${threadId}\0${typeof requestId}:${requestId}\0${action.fingerprint}`;
    if (this.actionGuards.has(guardKey)) throw new DesktopIpcError('A response was already submitted for this request. Wait for desktop confirmation.', { code: 'IPC_ACTION_ALREADY_SUBMITTED', outcomeUnknown: this.actionGuards.get(guardKey) === 'uncertain' });
    const params = { conversationId: threadId, requestId };
    let method;
    let messageId;
    let expectedAnswers;
    let expectedAsyncReply;
    if (action.kind === 'question') {
      method = 'thread-follower-submit-user-input';
      expectedAnswers = validatedAnswers(action.questions, selection.answers, { allowSkip: true });
      params.response = { answers: expectedAnswers };
    } else if (action.kind === 'async-question') {
      const sourceTurn = latestTurn(entry.state);
      if (sourceTurn?.turnId !== action.turnId || !['inProgress', 'completed'].includes(sourceTurn?.status)) {
        throw new DesktopIpcError('This question belongs to an earlier response. Use the current controls.', { code: 'IPC_STALE_ACTION' });
      }
      if (entry.state.unconfirmedTurnSubmissions?.some(submission => submission.terminal !== true)) {
        throw new DesktopIpcError('An earlier message is not yet confirmed. Wait before answering this question.', { code: 'IPC_TASK_BUSY' });
      }
      const answers = validatedAnswers(action.questions, selection.answers);
      const question = action.questions[0];
      if (answers[question.id].answers.length !== 1) throw new DesktopIpcError('Provide one text answer for this question', { code: 'IPC_INVALID_ACTION' });
      const reply = [{ questionItemId: question.id, question: question.question, answer: answers[question.id].answers[0] }];
      expectedAsyncReply = reply[0];
      const text = `${QUESTION_OPEN}\n${JSON.stringify(reply)}\n${QUESTION_CLOSE}`;
      messageId = selection.clientUserMessageId ?? randomUUID();
      const turn = latestTurn(entry.state);
      if (turn?.status === 'inProgress') {
        if (turn.turnId !== action.turnId) throw new DesktopIpcError('Wait for the current turn before answering this earlier question', { code: 'IPC_TASK_BUSY' });
        method = 'thread-follower-steer-turn';
        Object.assign(params, this._steerParams(threadId, text, entry.state, messageId));
      } else {
        if (conversationStatus(entry.state) !== 'idle') throw new DesktopIpcError('Wait until the current task is ready before answering this question', { code: 'IPC_TASK_BUSY' });
        method = 'thread-follower-start-turn';
        Object.assign(params, turnStartParams(threadId, text, messageId));
      }
      delete params.requestId;
    } else if (action.kind === 'plan-implementation') {
      if (selection.choiceId !== 'implement') throw new DesktopIpcError('Select Implement this plan to start it', { code: 'IPC_INVALID_ACTION' });
      messageId = selection.clientUserMessageId ?? randomUUID();
      method = 'thread-follower-start-turn';
      Object.assign(params, turnStartParams(threadId, `PLEASE IMPLEMENT THIS PLAN:\n${action.plan}`, messageId));
      params.turnStart.request.collaborationMode = defaultCollaborationMode(entry.state);
      delete params.requestId;
    } else {
      const choice = action.choices.find(candidate => candidate.id === selection.choiceId);
      if (!choice) throw new DesktopIpcError('Select one of the options currently offered by this request', { code: 'IPC_INVALID_ACTION' });
      if (action.kind === 'command-approval' || action.kind === 'file-approval') {
        method = action.kind === 'command-approval' ? 'thread-follower-command-approval-decision' : 'thread-follower-file-approval-decision';
        params.decision = structuredClone(choice.value);
      } else if (action.kind === 'permissions-approval') {
        method = 'thread-follower-permissions-request-approval-response';
        params.response = structuredClone(choice.value);
      } else if (action.kind === 'elicitation') {
        method = 'thread-follower-submit-mcp-server-elicitation-response';
        let content = null;
        if (choice.value === 'accept') {
          if (!action.schema) throw new DesktopIpcError('Complete this verification in Codex or Remote', { code: 'IPC_UNSUPPORTED_ACTION' });
          content = structuredClone(selection.content ?? {});
          validateForm(action.schema, content);
        }
        params.response = { action: choice.value, content };
      } else throw new DesktopIpcError('This action is not supported by the desktop follower protocol', { code: 'IPC_UNSUPPORTED_ACTION' });
    }
    this.actionGuards.set(guardKey, 'sending');
    let acknowledged = false;
    try {
      const response = await this.request(method, params, { targetClientId: entry.owner });
      if (messageId ? !response.result?.result : response.result?.ok !== true) {
        throw new DesktopIpcError('Desktop did not acknowledge this response', { code: 'IPC_ACTION_UNCONFIRMED', outcomeUnknown: true });
      }
      acknowledged = true;
      this.actionGuards.set(guardKey, 'acknowledged');
      const observed = await this._waitForActionResolution(threadId, action, { expectedAnswers, expectedAsyncReply, messageId });
      if (!observed) {
        // Native receipt is known. Keep the guard and let later observations
        // reconcile it, without alarming the user or permitting another send.
        return { ok: true, requestId, acknowledged: true, confirmed: false, pending: true,
          resolution: 'acknowledged-pending', ...(messageId ? { clientUserMessageId: messageId } : {}) };
      }
      this.actionGuards.set(guardKey, 'confirmed');
      // An acknowledgement plus request removal confirms resolution, not that
      // another client could not have answered concurrently.
      if (this.actionGuards.size > 500) for (const [key, value] of this.actionGuards) {
        if (value === 'confirmed') this.actionGuards.delete(key);
        if (this.actionGuards.size <= 400) break;
      }
      return { ok: true, requestId, acknowledged: true, confirmed: true, pending: false,
        resolution: observed.resolution, ...(messageId ? { clientUserMessageId: messageId } : {}) };
    } catch (error) {
      if (acknowledged || error.outcomeUnknown) {
        error.outcomeUnknown = true;
        this.actionGuards.set(guardKey, 'uncertain');
      } else this.actionGuards.delete(guardKey);
      throw error;
    }
  }

  async interrupt(threadId, expectedTurnId) {
    const entry = await this.refresh(threadId);
    const turn = [...canonicalTurns(entry.state)].reverse().find(item => item.turnId != null);
    if (expectedTurnId !== undefined && turn?.turnId !== expectedTurnId) throw new DesktopIpcError('The task changed. Select Stop response again.', { code: 'IPC_STALE_TURN' });
    if (!turn || turn.status !== 'inProgress') return { ok: true, interruptedTurnId: null };
    const response = await this.request('thread-follower-interrupt-turn', {
      conversationId: threadId, mode: 'user-stop', expectedTurnId: turn.turnId,
    }, { targetClientId: entry.owner });
    const result = response.result;
    if (result?.ok !== true || !Object.hasOwn(result, 'interruptedTurnId') ||
      (result.interruptedTurnId !== null && result.interruptedTurnId !== turn.turnId)) {
      throw new DesktopIpcError('Desktop did not confirm which turn was interrupted', {
        code: 'IPC_INTERRUPT_UNCONFIRMED', method: 'thread-follower-interrupt-turn', outcomeUnknown: true,
      });
    }
    return result;
  }

  unfollow(threadId) {
    this.wanted.delete(threadId);
    this.followEpochs.set(threadId, (this.followEpochs.get(threadId) ?? 0) + 1);
    this.following.delete(threadId);
    const entry = this.entries.get(threadId);
    if (this.connected && entry) {
      try { this._followingBroadcast(threadId, entry.owner, false); } catch (error) { this.emit('error', error); }
    }
    this.entries.delete(threadId); this.resyncing.delete(threadId);
    if (!this.wanted.size && this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const waiter of [...this.snapshotWaiters.get(threadId) ?? []]) {
      this._removeWaiter(threadId, waiter);
      waiter.reject(new DesktopIpcError('Task observation ended', { code: 'IPC_UNFOLLOWED' }));
    }
  }

  _disconnect(socket) {
    if (this.socket !== socket) return;
    this.socket = null; this.clientId = 'initializing-client';
    this.entries.clear(); this.resyncing.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DesktopIpcError('Desktop IPC disconnected; check the task before retrying a submitted message', {
        code: 'IPC_DISCONNECTED', method: pending.method, outcomeUnknown: isMutation(pending.method),
      }));
    }
    this.pending.clear();
    for (const [threadId, waiters] of this.snapshotWaiters) for (const waiter of [...waiters]) {
      this._removeWaiter(threadId, waiter); waiter.reject(new DesktopIpcError('Desktop IPC disconnected', { code: 'IPC_DISCONNECTED' }));
    }
    this.emit('disconnected');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed || !this.wanted.size || !this.reconnectDelays.length || this.reconnectTimer) return;
    if (this.connected && [...this.wanted].every(id => this.entries.get(id)?.synced)) return;
    const index = Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1);
    const delayMs = this.reconnectDelays[index];
    this.reconnectAttempt++;
    this.emit('reconnecting', { attempt: this.reconnectAttempt, delayMs });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.recovering = true;
      try {
        await this.connect();
        const results = await Promise.allSettled([...this.wanted].map(threadId => this.follow(threadId)));
        if (results.some(result => result.status === 'rejected')) this._scheduleReconnect();
      } catch { this._scheduleReconnect(); }
      finally { this.recovering = false; }
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async close() {
    this.closed = true; this.wanted.clear();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.connected) for (const [threadId, entry] of this.entries) {
      try { this._followingBroadcast(threadId, entry.owner, false); } catch { /* passive shutdown */ }
    }
    const socket = this.socket;
    if (!socket) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { socket.destroy(); resolve(); }, 200);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      socket.end();
    });
  }
}
