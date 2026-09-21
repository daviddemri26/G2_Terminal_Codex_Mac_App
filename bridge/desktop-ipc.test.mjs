import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import {
  DesktopIpcClient, FrameDecoder, encodeFrame, applyPatches, canonicalTurns,
  readableHistory, conversationStatus, turnStartParams,
  pendingActions, parseAsyncQuestionReply, acceptedAsyncQuestionReplies,
} from './desktop-ipc.mjs';

const THREAD = 'synthetic-task';
const OWNER = 'synthetic-owner';
const tick = () => new Promise(resolve => setImmediate(resolve));

function conversation({ status = 'completed', text = 'Hello', canonical = true } = {}) {
  const turn = { turnId: 'turn-1', status, params: { input: [{ type: 'text', text: 'Question' }] },
    items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] },
      { id: 'assistant-1', type: 'agentMessage', phase: 'final_answer', text }] };
  return { id: THREAD, title: 'Synthetic task', threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle', activeFlags: [] },
    requests: [], turns: canonical ? [] : [turn],
    ...(canonical ? { turnHistory: { kind: 'canonical', history: { isComplete: true,
      islands: [{ id: 'tail', entries: [{ key: 'turn:turn-1', value: 'turn:turn-1' }], newerBoundary: { status: 'exhausted' } }],
      entitiesByKey: { 'turn:turn-1': turn } } } } : {}) };
}

class FakeSocket extends EventEmitter {
  constructor(desktop, id) {
    super(); this.desktop = desktop; this.id = id; this.writable = true; this.destroyed = false;
    this.decoder = new FrameDecoder(message => desktop.receive(this, message));
    queueMicrotask(() => this.emit('connect'));
  }
  write(bytes) { this.decoder.push(bytes); return true; }
  fromDesktop(message) { if (!this.destroyed) this.emit('data', encodeFrame(message)); }
  end() { this.destroy(); }
  destroy() { if (this.destroyed) return; this.writable = false; this.destroyed = true; this.emit('close'); }
}

class FakeDesktop {
  constructor() {
    this.state = conversation(); this.revision = 1; this.messages = []; this.sockets = [];
    this.autoSnapshots = true; this.ignoreStart = false; this.delayDiscovery = false;
  }
  client(options = {}) {
    return new DesktopIpcClient({ socketPath: '/synthetic/ipc.sock', validatePath: async () => {}, timeoutMs: 100,
      socketFactory: () => { const socket = new FakeSocket(this, `observer-${this.sockets.length + 1}`); this.sockets.push(socket); return socket; }, ...options });
  }
  receive(socket, message) {
    this.messages.push(message);
    if (message.type === 'broadcast' && message.params.following && this.autoSnapshots) {
      queueMicrotask(() => this.snapshot(socket)); return;
    }
    if (message.type !== 'request') return;
    if (message.method === 'thread-follower-start-turn' && this.ignoreStart) return;
    if (message.method === 'thread-owner-discovery' && this.delayDiscovery) return;
    let result, owner = OWNER;
    if (message.method === 'initialize') { result = { clientId: socket.id }; owner = socket.id; }
    else if (message.method === 'thread-owner-discovery') result = { supportsUntrustedAppInput: true };
    else if (message.method === 'thread-follower-start-turn' || message.method === 'thread-follower-steer-turn') {
      result = { result: { turn: { id: 'new-turn', status: 'inProgress' } } };
      if (this.applyMessage) this.applyMessage(message);
    }
    else if (message.method === 'thread-follower-interrupt-turn') result = this.interruptResult ?? { ok: true, interruptedTurnId: message.params.expectedTurnId };
    else if (/^thread-follower-(submit-user-input|command-approval-decision|file-approval-decision|permissions-request-approval-response|submit-mcp-server-elicitation-response)$/.test(message.method)) {
      if (this.ignoreAction) return;
      result = { ok: true };
      if (!this.preserveRequest) {
        this.state.requests = this.state.requests.filter(request => request.id !== message.params.requestId);
        if (message.method === 'thread-follower-submit-user-input') canonicalTurns(this.state).at(-1).items.push({
          id: `response-${message.params.requestId}`, type: 'userInputResponse', requestId: message.params.requestId, completed: true,
          answers: this.otherAnswers ?? Object.fromEntries(Object.entries(message.params.response.answers).map(([id, answer]) => [id, answer.answers])),
        });
        this.revision++;
      }
    }
    else throw new Error(`Unexpected fake request ${message.method}`);
    queueMicrotask(() => socket.fromDesktop({ type: 'response', requestId: message.requestId, method: message.method,
      handledByClientId: owner, resultType: 'success', result }));
  }
  snapshot(socket = this.sockets.at(-1), overrides = {}) {
    this.broadcast({ type: 'snapshot', revision: this.revision, conversationState: structuredClone(this.state) }, socket, overrides);
  }
  broadcast(change, socket = this.sockets.at(-1), overrides = {}) {
    socket.fromDesktop({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
      sourceClientId: OWNER, targetClientIds: [socket.id],
      params: { conversationId: THREAD, hostId: 'local', change }, ...overrides });
  }
}

test('frame decoder handles fragmentation, multiple frames, and oversized headers', () => {
  const received = [];
  const decoder = new FrameDecoder(value => received.push(value), 100);
  const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 'é' })]);
  decoder.push(bytes.subarray(0, 3)); decoder.push(bytes.subarray(3, 8)); decoder.push(bytes.subarray(8));
  assert.deepEqual(received, [{ a: 1 }, { b: 'é' }]);
  const header = Buffer.alloc(4); header.writeUInt32LE(101);
  assert.throws(() => decoder.push(header), /frame size/);
});

test('Immer patches preserve array splice semantics without mutating input or traversing prototypes', () => {
  const original = { id: THREAD, values: ['a', 'c'], text: '' };
  const changed = applyPatches(original, [
    { op: 'add', path: ['values', 1], value: 'b' },
    { op: 'remove', path: ['values', 0] },
    { op: 'replace', path: ['text'], value: 'done' },
  ]);
  assert.deepEqual(changed, { id: THREAD, values: ['b', 'c'], text: 'done' });
  assert.deepEqual(original.values, ['a', 'c']);
  assert.throws(() => applyPatches(original, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]), /Unsafe/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => applyPatches(original, [{ op: 'remove', path: ['values', 8] }]), /index/);
});

test('canonical history exposes text when turns is empty and merges optimistic overlays once', () => {
  const state = conversation({ text: 'Hello world' });
  state.turns = [{ turnId: 'turn-1', status: 'inProgress', params: {}, items: [{ id: 'assistant-1', type: 'agentMessage', text: 'Hello' }] },
    { turnId: null, status: 'inProgress', params: { clientUserMessageId: 'local-id', input: [{ type: 'text', text: 'Next' }] }, items: [] }];
  const turns = canonicalTurns(state);
  assert.equal(turns.length, 2); assert.equal(turns[0].status, 'completed');
  assert.equal(turns[0].items.at(-1).text, 'Hello world');
  assert.deepEqual(readableHistory(state, 10).map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'Question' }, { role: 'assistant', text: 'Hello world' }, { role: 'user', text: 'Next' },
  ]);
  assert.deepEqual(readableHistory(state, 0), []);
  assert.deepEqual(readableHistory(state, -2), []);
  assert.deepEqual(readableHistory(state, 0.5), []);
});

test('status distinguishes awaiting user action from desktop dynamic tool execution', () => {
  const state = conversation({ status: 'inProgress' });
  state.requests = [{ id: 'dynamic', method: 'item/tool/call', params: {} }];
  assert.equal(conversationStatus(state), 'busy');
  state.requests.push({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
  assert.equal(conversationStatus(state), 'awaiting');
  assert.equal(conversationStatus(null), 'disconnected');
  const unconfirmed = conversation();
  unconfirmed.unconfirmedTurnSubmissions = [{ requestId: 'sent-without-confirmation' }];
  assert.equal(conversationStatus(unconfirmed), 'busy');
});

test('plain turn schema inherits desktop configuration and introduces no permission/model overrides', () => {
  assert.deepEqual(turnStartParams(THREAD, 'Bonjour', 'id-1'), {
    conversationId: THREAD, turnStart: { request: { threadId: THREAD, clientUserMessageId: 'id-1', input: [{ type: 'text', text: 'Bonjour', text_elements: [] }] },
      context: { inheritThreadSettings: true } },
  });
});

test('follower refuses ownership, validates broadcast identity, and passively detaches', async () => {
  const desktop = new FakeDesktop(); const client = desktop.client();
  try {
    const entry = await client.follow(THREAD);
    assert.equal(entry.owner, OWNER); assert.equal(entry.revision, 1);
    const socket = desktop.sockets[0];
    socket.fromDesktop({ type: 'client-discovery-request', requestId: 'probe', request: { method: 'thread-owner-discovery' } });
    assert.deepEqual(desktop.messages.at(-1).response, { canHandle: false });
    const changes = { type: 'snapshot', revision: 9, conversationState: { ...desktop.state, title: 'Wrong' } };
    for (const overrides of [{ sourceClientId: 'intruder' }, { version: 10 }, { targetClientIds: ['someone-else'] },
      { params: { conversationId: THREAD, hostId: 'remote', change: changes } }]) desktop.broadcast(changes, socket, overrides);
    assert.equal(client.getState(THREAD).title, 'Synthetic task');
    client.unfollow(THREAD);
    assert.equal(client.getState(THREAD), null);
    assert.equal(desktop.messages.at(-1).params.following, false);
    assert.ok(!desktop.messages.some(message => /interrupt|approval|submit-user-input/.test(message.method)));
  } finally { await client.close(); }
});

test('revision gap triggers one resnapshot and blocks stale state until a valid snapshot', async () => {
  const desktop = new FakeDesktop(); const client = desktop.client();
  try {
    await client.follow(THREAD); desktop.autoSnapshots = false;
    const before = desktop.messages.length;
    desktop.broadcast({ type: 'patches', baseRevision: 4, revision: 5, patches: [{ op: 'replace', path: ['title'], value: 'Lost' }] });
    desktop.broadcast({ type: 'patches', baseRevision: 5, revision: 6, patches: [] });
    assert.equal(client.getState(THREAD), null);
    assert.equal(desktop.messages.length, before + 1);
    desktop.revision = 6; desktop.state.title = 'Fresh'; desktop.snapshot();
    // A patch in the same socket tick after the snapshot must not be dropped.
    desktop.broadcast({ type: 'patches', baseRevision: 6, revision: 7, patches: [{ op: 'replace', path: ['title'], value: 'Current' }] });
    assert.equal(client.getState(THREAD).title, 'Current');
    assert.equal(client.getEntry(THREAD).revision, 7);
  } finally { await client.close(); }
});

test('startTurn refreshes desktop state, uses owner IPC, and rejects busy state', async () => {
  const desktop = new FakeDesktop(); const client = desktop.client();
  try {
    await client.follow(THREAD);
    const result = await client.startTurn(THREAD, 'Hello desktop', 'provider-submission-id');
    assert.equal(result.turn.id, 'new-turn');
    const message = desktop.messages.find(message => message.method === 'thread-follower-start-turn');
    assert.equal(message.version, 2); assert.equal(message.targetClientId, OWNER); assert.equal(message.hostId, undefined);
    assert.equal(message.params.turnStart.request.input[0].text, 'Hello desktop');
    assert.equal(message.params.turnStart.request.clientUserMessageId, 'provider-submission-id');
    assert.equal(message.params.turnStart.context.inheritThreadSettings, true);
    desktop.state = conversation({ status: 'inProgress' }); desktop.revision++;
    await assert.rejects(client.startTurn(THREAD, 'Should not send'), error => error.code === 'IPC_TASK_BUSY');
    assert.equal(desktop.messages.filter(message => message.method === 'thread-follower-start-turn').length, 1);
  } finally { await client.close(); }
});

test('interrupt targets only the observed active turn and close never interrupts', async () => {
  const desktop = new FakeDesktop(); desktop.state = conversation({ status: 'inProgress' }); const client = desktop.client();
  try {
    const result = await client.interrupt(THREAD);
    assert.equal(result.interruptedTurnId, 'turn-1');
    const message = desktop.messages.find(message => message.method === 'thread-follower-interrupt-turn');
    assert.equal(message.version, 4);
    assert.deepEqual(message.params, { conversationId: THREAD, mode: 'user-stop', expectedTurnId: 'turn-1' });
    desktop.state = conversation(); desktop.revision++;
    assert.equal((await client.interrupt(THREAD)).interruptedTurnId, null);
  } finally { await client.close(); }
  assert.equal(desktop.messages.filter(message => message.method === 'thread-follower-interrupt-turn').length, 1);
});

test('unknown submission outcome is explicit and reconnection never replays the prompt', async () => {
  const desktop = new FakeDesktop(); const client = desktop.client({ timeoutMs: 30 });
  try {
    desktop.ignoreStart = true;
    await assert.rejects(client.startTurn(THREAD, 'Do not replay'), error => error.outcomeUnknown === true && error.code === 'IPC_TIMEOUT');
    const disconnected = once(client, 'disconnected'); desktop.sockets[0].destroy(); await disconnected;
    assert.equal(client.getState(THREAD), null);
    await client.connect(); await client.follow(THREAD);
    assert.equal(desktop.sockets.length, 2);
    assert.equal(desktop.messages.filter(message => message.method === 'thread-follower-start-turn').length, 1);
  } finally { await client.close(); }
});

test('interrupt of an idle task is an explicit no-op without any cancellation request', async () => {
  const desktop = new FakeDesktop(); const client = desktop.client();
  try {
    assert.deepEqual(await client.interrupt(THREAD), { ok: true, interruptedTurnId: null });
    assert.ok(!desktop.messages.some(message => message.method === 'thread-follower-interrupt-turn'));
  } finally { await client.close(); }
});

test('an incomplete interrupt acknowledgement cannot claim that a turn was cancelled', async () => {
  const desktop = new FakeDesktop(); desktop.state = conversation({ status: 'inProgress' });
  desktop.interruptResult = { ok: true };
  const client = desktop.client();
  try {
    await assert.rejects(client.interrupt(THREAD), error => error.code === 'IPC_INTERRUPT_UNCONFIRMED' && error.outcomeUnknown === true);
  } finally { await client.close(); }
});

test('unfollow cancels pending discovery without reattaching the task', async () => {
  const desktop = new FakeDesktop(); const client = desktop.client({ timeoutMs: 30 });
  try {
    await client.connect(); desktop.delayDiscovery = true;
    const pending = client.follow(THREAD);
    await tick(); client.unfollow(THREAD);
    await assert.rejects(pending);
    assert.equal(client.getState(THREAD), null);
    assert.ok(!desktop.messages.some(message => message.type === 'broadcast' && message.params.following));
  } finally { await client.close(); }
});

function questionRequest(id = 17) {
  return { id, method: 'item/tool/requestUserInput', params: { threadId: THREAD, turnId: 'turn-1', questions: [
    { id: 'choice_a', header: 'Colour', question: 'Choose a colour', options: [{ label: 'Blue', description: 'A calm colour' }, { label: 'Red', description: 'A bright colour' }] },
    { id: 'details', header: 'Details', question: 'Any details?' },
  ] } };
}
const choiceFor = (action, value) => ({ kind: action.kind, expectedFingerprint: action.fingerprint, ...value });
const mutations = desktop => desktop.messages.filter(message => message.type === 'request' && message.method.startsWith('thread-follower-'));

test('question response preserves exact request ID and question IDs with native response schema', async () => {
  const desktop = new FakeDesktop(); desktop.state.requests = [questionRequest()]; const client = desktop.client();
  const action = pendingActions(desktop.state)[0];
  try {
    const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: { choice_a: { answers: ['Blue'] }, details: 'Exact freeform answer' } }));
    assert.equal(result.resolution, 'answer-confirmed');
    const wire = mutations(desktop)[0];
    assert.equal(wire.method, 'thread-follower-submit-user-input'); assert.equal(wire.version, 1); assert.equal(wire.targetClientId, OWNER);
    assert.deepEqual(wire.params, { conversationId: THREAD, requestId: 17, response: { answers: { choice_a: { answers: ['Blue'] }, details: { answers: ['Exact freeform answer'] } } } });
    await assert.rejects(client.respondAction(THREAD, action.id, choiceFor(action, { answers: {} })), error => error.code === 'IPC_STALE_ACTION');
    assert.equal(mutations(desktop).length, 1);
  } finally { await client.close(); }
});

test('fresh-state stale checks reject changed, wrong-type, absent and malformed question responses before transmission', async () => {
  const desktop = new FakeDesktop(); desktop.state.requests = [questionRequest()]; const client = desktop.client();
  const initial = pendingActions(desktop.state)[0];
  try {
    await client.follow(THREAD);
    desktop.state.requests[0].params.questions[0].question = 'Changed question'; desktop.revision++;
    await assert.rejects(client.respondAction(THREAD, initial.id, choiceFor(initial, { answers: {} })), error => error.code === 'IPC_STALE_ACTION');
    const current = pendingActions(desktop.state)[0];
    await assert.rejects(client.respondAction(THREAD, String(current.id), choiceFor(current, { answers: {} })), error => error.code === 'IPC_STALE_ACTION');
    await assert.rejects(client.respondAction(THREAD, current.id, choiceFor(current, { answers: { unknown_id: 'No' } })), error => error.code === 'IPC_INVALID_ACTION');
    await assert.rejects(client.respondAction(THREAD, current.id, choiceFor(current, { answers: { choice_a: 'Blue' } })), error => error.code === 'IPC_INVALID_ACTION');
    assert.equal(mutations(desktop).length, 0);
  } finally { await client.close(); }
});

test('explicit synchronous question skip uses the native empty answer map', async () => {
  const desktop = new FakeDesktop(); desktop.state.requests = [questionRequest()]; const client = desktop.client();
  const action = pendingActions(desktop.state)[0];
  try {
    const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: {} }));
    assert.equal(result.resolution, 'answer-confirmed');
    assert.deepEqual(mutations(desktop)[0].params.response, { answers: {} });
  } finally { await client.close(); }
});

test('a native acknowledgement without state resolution stays pending and cannot be retried', async () => {
  const desktop = new FakeDesktop(); desktop.state.requests = [questionRequest()]; desktop.preserveRequest = true;
  const client = desktop.client(); const action = pendingActions(desktop.state)[0];
  const selection = choiceFor(action, { answers: { choice_a: 'Blue', details: 'None' } });
  try {
    const result = await client.respondAction(THREAD, action.id, selection);
    assert.equal(result.acknowledged, true); assert.equal(result.confirmed, false); assert.equal(result.pending, true);
    assert.equal(result.resolution, 'acknowledged-pending');
    await assert.rejects(client.respondAction(THREAD, action.id, selection), error => error.code === 'IPC_ACTION_ALREADY_SUBMITTED' && !error.outcomeUnknown);
    assert.equal(mutations(desktop).length, 1);
  } finally { await client.close(); }
});

test('concurrent desktop resolution is identified without claiming the bridge answer was applied', async () => {
  const desktop = new FakeDesktop(); desktop.state.requests = [questionRequest()]; desktop.otherAnswers = { choice_a: ['Red'], details: ['From desktop'] };
  const client = desktop.client(); const action = pendingActions(desktop.state)[0];
  try {
    const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: { choice_a: 'Blue', details: 'None' } }));
    assert.equal(result.resolution, 'resolved-elsewhere');
  } finally { await client.close(); }
});

test('approval routes accept only a choice offered by the freshly observed request', async () => {
  for (const [method, kind, route] of [
    ['item/commandExecution/requestApproval', 'command-approval', 'thread-follower-command-approval-decision'],
    ['item/fileChange/requestApproval', 'file-approval', 'thread-follower-file-approval-decision'],
  ]) {
    const desktop = new FakeDesktop(); desktop.state.requests = [{ id: `test-${kind}`, method, params: { turnId: 'turn-1', reason: 'Synthetic approval', availableDecisions: ['accept', 'decline'] } }];
    const client = desktop.client(); const action = pendingActions(desktop.state)[0];
    try {
      await assert.rejects(client.respondAction(THREAD, action.id, choiceFor(action, { choiceId: 'acceptForSession' })), error => error.code === 'IPC_INVALID_ACTION');
      assert.equal(mutations(desktop).length, 0);
      await client.respondAction(THREAD, action.id, choiceFor(action, { choiceId: 'decline' }));
      assert.equal(mutations(desktop)[0].method, route); assert.equal(mutations(desktop)[0].params.decision, 'decline');
    } finally { await client.close(); }
  }
});

test('permission response sends only the exact requested permissions and explicit selected scope', async () => {
  const desktop = new FakeDesktop(); const permissions = { network: { enabled: true }, fileSystem: { read: ['/synthetic/read'] } };
  desktop.state.requests = [{ id: 'permission-1', method: 'item/permissions/requestApproval', params: { turnId: 'turn-1', permissions } }];
  const client = desktop.client(); const action = pendingActions(desktop.state)[0];
  try {
    await client.respondAction(THREAD, action.id, choiceFor(action, { choiceId: 'allow_once', permissions: { all: true } }));
    assert.deepEqual(mutations(desktop)[0].params.response, { permissions, scope: 'turn' });
    assert.equal(mutations(desktop)[0].method, 'thread-follower-permissions-request-approval-response');
  } finally { await client.close(); }
});

test('simple elicitation validates typed fields, does not persist approval, and defers auth or advanced forms', async () => {
  const desktop = new FakeDesktop(); desktop.state.requests = [{ id: 'form-1', method: 'mcpServer/elicitation/request', params: {
    turnId: 'turn-1', mode: 'form', requestedSchema: { type: 'object', properties: { copies: { type: 'integer', minimum: 1 }, agree: { type: 'boolean' } }, required: ['copies', 'agree'] },
  } }];
  const client = desktop.client(); const action = pendingActions(desktop.state)[0];
  try {
    await assert.rejects(client.respondAction(THREAD, action.id, choiceFor(action, { choiceId: 'accept', content: { copies: 0, agree: true } })), error => error.code === 'IPC_INVALID_ACTION');
    await client.respondAction(THREAD, action.id, choiceFor(action, { choiceId: 'accept', content: { copies: 1, agree: true }, _meta: { persist: 'always' } }));
    assert.deepEqual(mutations(desktop)[0].params.response, { action: 'accept', content: { copies: 1, agree: true } });
    desktop.state.requests[0] = { id: 'auth', method: 'mcpServer/elicitation/request', params: { mode: 'openai/userVerification' } };
    assert.deepEqual(pendingActions(desktop.state)[0].choices.map(choice => choice.id), ['decline', 'cancel']);
    desktop.state.requests[0].params = { mode: 'form', requestedSchema: { type: 'string', format: 'uri' } };
    assert.equal(pendingActions(desktop.state)[0].schema, null);
    desktop.state.requests[0].params = { mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { tool_params: { confirmation_summary: 'native summary', plan_token: 'synthetic-not-a-real-token' } } };
    assert.deepEqual(pendingActions(desktop.state)[0].choices.map(choice => choice.id), ['decline', 'cancel']);
    assert.ok(!JSON.stringify(pendingActions(desktop.state)[0]).includes('synthetic-not-a-real-token'));
  } finally { await client.close(); }
});

test('async question replies use exact native tags and steer only the matching active source turn', async () => {
  for (const status of ['inProgress', 'completed']) {
    const desktop = new FakeDesktop(); desktop.state = conversation({ status });
    canonicalTurns(desktop.state)[0].items.at(-1).questions = [{ title: 'Which colour?', options: ['Blue', 'Red'] }];
    const action = pendingActions(desktop.state)[0];
    desktop.applyMessage = message => {
      const input = message.params.input ?? message.params.turnStart.request.input;
      canonicalTurns(desktop.state)[0].items.push(message.method.includes('steer')
        ? { id: 'reply', type: 'steeringUserMessage', input, status: 'accepted', clientUserMessageId: message.params.clientUserMessageId }
        : { id: 'reply', type: 'userMessage', content: input, clientId: message.params.turnStart.request.clientUserMessageId });
      desktop.revision++;
    };
    const client = desktop.client();
    try {
      const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: { [action.id]: 'Blue' }, clientUserMessageId: 'specific-reply-id' }));
      assert.equal(result.clientUserMessageId, 'specific-reply-id');
      assert.equal(result.resolution, 'answer-confirmed');
      const wire = mutations(desktop)[0];
      assert.equal(wire.method, status === 'inProgress' ? 'thread-follower-steer-turn' : 'thread-follower-start-turn');
      const text = (wire.params.input ?? wire.params.turnStart.request.input)[0].text;
      assert.deepEqual(parseAsyncQuestionReply(text), [{ questionItemId: '["request_user_input_async","assistant-1",0]', question: 'Which colour?', answer: 'Blue' }]);
      assert.equal(wire.params.requestId, undefined); assert.equal(pendingActions(client.getState(THREAD)).length, 0);
    } finally { await client.close(); }
  }
});

test('ordinary steering preserves observed settings and never starts a replacement turn when inactive', async () => {
  const desktop = new FakeDesktop(); desktop.state = conversation({ status: 'inProgress' });
  desktop.state.cwd = '/synthetic/work'; desktop.state.latestCollaborationMode = { mode: 'plan', settings: { model: 'current-model', reasoning_effort: 'high' } };
  const client = desktop.client();
  try {
    await client.steerTurn(THREAD, 'Please focus on the answer', 'steer-id');
    const wire = mutations(desktop)[0];
    assert.equal(wire.method, 'thread-follower-steer-turn'); assert.equal(wire.version, 1);
    assert.equal(wire.params.clientUserMessageId, 'steer-id');
    assert.deepEqual(wire.params.restoreMessage.context.collaborationMode, desktop.state.latestCollaborationMode);
    assert.equal(wire.params.approvalPolicy, undefined);
    desktop.state = conversation(); desktop.revision++;
    await assert.rejects(client.steerTurn(THREAD, 'Do not replace'), error => error.code === 'IPC_TASK_IDLE');
    assert.equal(mutations(desktop).length, 1);
  } finally { await client.close(); }
});

test('plan implementation requires explicit current plan and makes only the native mode transition', async () => {
  const desktop = new FakeDesktop(); desktop.state.latestModel = 'observed-model'; desktop.state.latestReasoningEffort = 'high';
  desktop.state.requests = [{ id: 'implement-plan:turn-1', method: 'item/plan/requestImplementation', params: { threadId: THREAD, turnId: 'turn-1', planContent: '1. Do the explicitly selected work.' } }];
  const client = desktop.client(); const action = pendingActions(desktop.state)[0];
  desktop.applyMessage = () => { desktop.state.requests = []; desktop.revision++; };
  try {
    await assert.rejects(client.respondAction(THREAD, action.id, choiceFor(action, { choiceId: 'cancel' })), error => error.code === 'IPC_INVALID_ACTION');
    assert.equal(mutations(desktop).length, 0); assert.equal(conversationStatus(desktop.state), 'idle');
    await client.respondAction(THREAD, action.id, choiceFor(action, { choiceId: 'implement', clientUserMessageId: 'plan-id' }));
    const wire = mutations(desktop)[0];
    assert.equal(wire.params.turnStart.request.input[0].text, 'PLEASE IMPLEMENT THIS PLAN:\n1. Do the explicitly selected work.');
    assert.deepEqual(wire.params.turnStart.request.collaborationMode, { mode: 'default', settings: { model: 'observed-model', reasoning_effort: 'high', developer_instructions: null } });
    assert.deepEqual(wire.params.turnStart.context, { inheritThreadSettings: true });
    assert.equal(wire.params.turnStart.request.sandboxPolicy, undefined);
  } finally { await client.close(); }
});

test('unsupported option picker cannot be routed as generic user input or an approval', async () => {
  const desktop = new FakeDesktop(); desktop.state.requests = [{ id: 'picker', method: 'item/tool/requestOptionPicker', params: { question: 'Choose', options: [{ label: 'One' }] } }];
  const client = desktop.client(); const action = pendingActions(desktop.state)[0];
  try {
    assert.equal(action.supported, false);
    await assert.rejects(client.respondAction(THREAD, action.id, choiceFor(action, { choiceId: 'One' })), error => error.code === 'IPC_UNSUPPORTED_ACTION');
    assert.equal(mutations(desktop).length, 0);
  } finally { await client.close(); }
});

test('passive recovery restores observation with bounded backoff and never resubmits uncertain actions', async () => {
  const desktop = new FakeDesktop(); desktop.state.requests = [questionRequest()]; desktop.ignoreAction = true;
  const client = desktop.client({ timeoutMs: 20, reconnectDelays: [5, 10, 20] }); const action = pendingActions(desktop.state)[0];
  const selection = choiceFor(action, { answers: { choice_a: 'Blue', details: 'None' } });
  try {
    await assert.rejects(client.respondAction(THREAD, action.id, selection), error => error.outcomeUnknown);
    const recovery = once(client, 'reconnecting'); desktop.sockets[0].destroy();
    assert.deepEqual((await recovery)[0], { attempt: 1, delayMs: 5 });
    await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Recovery failed')), 200); client.once('state', () => { clearTimeout(timeout); resolve(); }); });
    assert.equal(desktop.sockets.length, 2); assert.equal(client.getState(THREAD).id, THREAD);
    await assert.rejects(client.respondAction(THREAD, action.id, selection), error => error.code === 'IPC_ACTION_ALREADY_SUBMITTED');
    assert.equal(mutations(desktop).length, 1);
    client.unfollow(THREAD); desktop.sockets.at(-1).destroy();
    assert.equal(client.reconnectTimer, null);
  } finally { await client.close(); }
});

test('owner loss retries read-only discovery and resolves after the desktop owner becomes available', async () => {
  const desktop = new FakeDesktop(); const client = desktop.client({ timeoutMs: 10, reconnectDelays: [2, 5, 10] });
  try {
    await client.follow(THREAD); desktop.delayDiscovery = true;
    const observedAttempts = []; client.on('reconnecting', attempt => observedAttempts.push(attempt));
    desktop.sockets[0].fromDesktop({ type: 'broadcast', method: 'client-status-changed', version: 0, sourceClientId: OWNER,
      params: { clientId: OWNER, status: 'disconnected' } });
    assert.equal(client.getState(THREAD), null);
    const timer = setTimeout(() => { desktop.delayDiscovery = false; }, 18);
    try {
      await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Owner discovery did not recover')), 150); client.once('state', () => { clearTimeout(timeout); resolve(); }); });
    } finally { clearTimeout(timer); }
    assert.equal(client.getState(THREAD).id, THREAD);
    assert.ok(observedAttempts.length >= 2);
    assert.ok(observedAttempts.every(attempt => attempt.delayMs <= 10));
    assert.equal(mutations(desktop).length, 0);
  } finally { await client.close(); }
});

test('native mutation errors with erased delivery metadata cannot unlock replay', async () => {
  const desktop = new FakeDesktop(); desktop.state.requests = [questionRequest()]; desktop.ignoreAction = true;
  const client = desktop.client(); const action = pendingActions(desktop.state)[0];
  const selection = choiceFor(action, { answers: { choice_a: 'Blue', details: 'None' } });
  try {
    const response = client.respondAction(THREAD, action.id, selection);
    await tick();
    const wire = mutations(desktop)[0];
    desktop.sockets[0].fromDesktop({ type: 'response', requestId: wire.requestId, method: wire.method, handledByClientId: OWNER,
      resultType: 'error', error: 'Codex app-server is not available' });
    await assert.rejects(response, error => error.outcomeUnknown === true);
    await assert.rejects(client.respondAction(THREAD, action.id, selection), error => error.code === 'IPC_ACTION_ALREADY_SUBMITTED');
    assert.equal(mutations(desktop).length, 1);
  } finally { await client.close(); }
});

function asyncQuestionDesktop() {
  const desktop = new FakeDesktop(); desktop.state = conversation({ canonical: false });
  desktop.state.turns[0].items.at(-1).questions = [{ title: 'Tea or coffee?', options: ['Tea', 'Coffee'] }];
  return desktop;
}

test('accepted native start input resolves an async question before its userMessage item arrives', async () => {
  const desktop = asyncQuestionDesktop(); const action = pendingActions(desktop.state)[0];
  desktop.applyMessage = message => {
    desktop.state.turns.push({ turnId: 'server-assigned-reply', status: 'inProgress', params: message.params.turnStart.request, items: [] });
    desktop.revision++;
  };
  const client = desktop.client();
  try {
    const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: { [action.id]: 'Coffee' }, clientUserMessageId: 'coffee-id' }));
    assert.equal(result.confirmed, true); assert.equal(result.resolution, 'answer-confirmed');
    assert.equal(pendingActions(client.getState(THREAD)).length, 0);
    assert.equal(acceptedAsyncQuestionReplies(client.getState(THREAD))[0].source, 'turnInput');
    assert.equal(mutations(desktop).length, 1);
  } finally { await client.close(); }
});

test('optimistic or unconfirmed turn params do not prove an async answer was accepted', async () => {
  const desktop = asyncQuestionDesktop(); const action = pendingActions(desktop.state)[0];
  const input = [{ type: 'text', text: '<send_user_message_question_reply>\n' + JSON.stringify([
    { questionItemId: action.id, question: 'Tea or coffee?', answer: 'Coffee' },
  ]) + '\n</send_user_message_question_reply>' }];
  desktop.state.turns.push({ turnId: null, status: 'inProgress', params: { clientUserMessageId: 'optimistic-id', input }, items: [] });
  assert.equal(pendingActions(desktop.state).length, 1); assert.equal(acceptedAsyncQuestionReplies(desktop.state).length, 0);
  desktop.state.turns.at(-1).turnId = 'native-turn';
  desktop.state.unconfirmedTurnSubmissions = [{ clientUserMessageId: 'optimistic-id', terminal: false }];
  assert.equal(pendingActions(desktop.state).length, 1); assert.equal(acceptedAsyncQuestionReplies(desktop.state).length, 0);
  desktop.state.unconfirmedTurnSubmissions = [];
  assert.equal(pendingActions(desktop.state).length, 0);
  desktop.state.turns.at(-1).items.push({ type: 'userMessage', id: 'canonical-user', content: input });
  assert.equal(acceptedAsyncQuestionReplies(desktop.state).at(-1).clientUserMessageId, 'optimistic-id');
});

test('delayed accepted async reply after native ack is confirmed by read-only resnapshot without resending', async () => {
  const desktop = asyncQuestionDesktop(); const action = pendingActions(desktop.state)[0];
  const client = desktop.client({ actionConfirmationMs: 150, actionConfirmationPollMs: 10 });
  let timer;
  desktop.applyMessage = message => {
    timer = setTimeout(() => {
      desktop.state.turns.push({ turnId: 'delayed-native-reply', status: 'inProgress', params: message.params.turnStart.request, items: [] });
      desktop.revision++;
      // No broadcast: the bounded observation retry must discover this state.
    }, 25);
  };
  try {
    const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: { [action.id]: 'Coffee' }, clientUserMessageId: 'delayed-coffee' }));
    assert.equal(result.confirmed, true); assert.equal(result.resolution, 'answer-confirmed');
    assert.equal(mutations(desktop).length, 1);
    assert.ok(desktop.messages.filter(message => message.type === 'broadcast' && message.params.following).length > 2);
  } finally { clearTimeout(timer); await client.close(); }
});

test('an async answer acknowledged before a delayed userMessage broadcast does not cause a false delivery error', async () => {
  const desktop = asyncQuestionDesktop(); desktop.state.turns[0].status = 'inProgress';
  const action = pendingActions(desktop.state)[0]; const client = desktop.client({ actionConfirmationMs: 150, actionConfirmationPollMs: 100 });
  let timer;
  desktop.applyMessage = message => {
    timer = setTimeout(() => {
      desktop.state.turns[0].items.push({ id: 'late-steer', type: 'steeringUserMessage', input: message.params.input,
        clientUserMessageId: message.params.clientUserMessageId, status: 'accepted' });
      desktop.revision++; desktop.snapshot();
    }, 25);
  };
  try {
    const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: { [action.id]: 'Coffee' }, clientUserMessageId: 'late-steer-id' }));
    assert.equal(result.confirmed, true); assert.equal(result.pending, false);
    assert.equal(mutations(desktop).length, 1);
  } finally { clearTimeout(timer); await client.close(); }
});

test('disappearance of async question history alone cannot falsely confirm our response', async () => {
  const desktop = asyncQuestionDesktop(); const action = pendingActions(desktop.state)[0];
  desktop.applyMessage = () => { desktop.state.turns = []; desktop.revision++; };
  const client = desktop.client({ actionConfirmationMs: 25, actionConfirmationPollMs: 10 });
  try {
    const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: { [action.id]: 'Coffee' }, clientUserMessageId: 'missing-id' }));
    assert.equal(result.confirmed, false); assert.equal(result.pending, true); assert.equal(result.acknowledged, true);
    assert.equal(mutations(desktop).length, 1);
  } finally { await client.close(); }
});

test('concurrent async answer from another client is distinguished even if it has the same text', async () => {
  const desktop = asyncQuestionDesktop(); const action = pendingActions(desktop.state)[0];
  desktop.applyMessage = message => {
    desktop.state.turns.push({ turnId: 'other-client-turn', status: 'completed',
      params: { ...message.params.turnStart.request, clientUserMessageId: 'other-client-message' }, items: [] });
    desktop.revision++;
  };
  const client = desktop.client();
  try {
    const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: { [action.id]: 'Coffee' }, clientUserMessageId: 'our-message' }));
    assert.equal(result.confirmed, true); assert.equal(result.resolution, 'resolved-elsewhere');
    assert.equal(mutations(desktop).length, 1);
  } finally { await client.close(); }
});

test('disconnect after native ack stays acknowledged-pending within the bounded wait', async () => {
  const desktop = asyncQuestionDesktop(); const action = pendingActions(desktop.state)[0];
  desktop.applyMessage = () => { setImmediate(() => desktop.sockets.at(-1).destroy()); };
  const client = desktop.client({ actionConfirmationMs: 30, actionConfirmationPollMs: 10, reconnectDelays: [] });
  try {
    const result = await client.respondAction(THREAD, action.id, choiceFor(action, { answers: { [action.id]: 'Coffee' }, clientUserMessageId: 'acked-id' }));
    assert.equal(result.confirmed, false); assert.equal(result.pending, true); assert.equal(result.acknowledged, true);
    assert.equal(mutations(desktop).length, 1);
  } finally { await client.close(); }
});
