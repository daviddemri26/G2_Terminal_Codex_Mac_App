import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopProvider } from './provider.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { DEFAULT_TEXT_FORMATTING } from './text-formatting.mjs';

const id = '11111111-1111-4111-8111-111111111111';
function state(status = 'completed', text = 'Previous answer', turnId = 'old') {
  return { threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle' }, requests: [],
    turns: [{ turnId, status, params: { input: [{ type: 'text', text: 'Question' }] }, items: [{ id: 'answer-' + turnId, type: 'agentMessage', phase: 'final_answer', text }] }] };
}
function setup(options = {}) {
  class Fake extends EventEmitter {
    current = state();
    starts = [];
    closes = 0;
    interrupts = 0;
    replies = [];
    async follow(thread) { this.emit('state', thread, this.current); return { state: this.current }; }
    async refresh(thread) { this.emit('state', thread, this.current); return { state: this.current }; }
    getState() { return this.current; }
    async startTurn(thread, text, clientUserMessageId) { this.starts.push({ thread, text }); this.current = state('inProgress', '', 'new'); this.current.turns[0].params.clientUserMessageId = clientUserMessageId; this.emit('state', thread, this.current); return { turn: { id: 'new' } }; }
    async interrupt() { this.interrupts++; }
    async respondAction(thread, requestId, response) {
      this.replies.push({ requestId, response });
      this.current.requests = this.current.requests.filter(request => request.id !== requestId);
      this.current.threadRuntimeStatus = { type: 'active' };
      this.emit('state', thread, this.current);
      return { confirmed: true };
    }
    async steerTurn(thread, text, clientUserMessageId) {
      this.starts.push({ thread, text, steering: true });
      this.current.turns.at(-1).items.push({ id: clientUserMessageId, type: 'steeringUserMessage', status: 'accepted', clientUserMessageId,
        input: [{ type: 'text', text }] });
      this.emit('state', thread, this.current);
      return { turnId: this.current.turns.at(-1).turnId };
    }
    unfollow() {}
    async close() { this.closes++; }
  }
  const client = new Fake();
  const events = [];
  const provider = createDesktopProvider((thread, message) => events.push({ thread, ...message }), {
    client, store: options.store ?? new DeliveryStore(), skipBuildGuard: true, catalog: async () => [{ id, title: 'Desktop task', cwd: '/test', updated_at: 1 }],
    readTextFormatting: options.readTextFormatting ?? (() => ({ ...DEFAULT_TEXT_FORMATTING })),
    ...(options.commentarySettleMs ? { commentarySettleMs: options.commentarySettleMs } : {}), ...(options.now ? { now: options.now } : {}), ...(options.statsIntervalMs ? { statsIntervalMs: options.statsIntervalMs } : {}),
  });
  return { provider, client, events };
}

test('opening completed history does not replay an old result as a new response', async () => {
  const { provider, events } = setup();
  try {
    const history = await provider.getHistory(id, 10);
    assert.ok(history.some(m => m.text === 'Previous answer'));
    assert.equal(events.some(e => e.type === 'result'), false);
    assert.equal(events.at(-1).state, 'idle');
  } finally { await provider.close(); }
});

test('a turn replacement closes prior thinking even when the next turn is already complete', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'before');
    client.current.turns[0].items.push({ id: 'thinking', type: 'reasoning' });
    await provider.watch(id);
    client.current = state('completed', 'Tu préfères le café.', 'after');
    client.emit('state', id, client.current);
    const start = events.findIndex(event => event.state === 'think_start');
    assert.ok(start >= 0);
    assert.ok(events.slice(start + 1).some(event => event.state === 'think_end'));
    assert.equal(events.at(-1).state, 'idle');
    assert.equal(events.filter(event => event.type === 'result').length, 1);
  } finally { await provider.close(); }
});

test('a late question acknowledgement ends with explicit terminal state, not renewed activity', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'new'); client.current.requests = [questionRequest()];
    await provider.watch(id);
    const [action] = await provider.getActions(id);
    client.respondAction = async () => {
      client.current = state('completed', 'The answer is Blue.', 'new');
      client.emit('state', id, client.current);
      return { confirmed: true, acknowledged: true };
    };
    await provider.respondQuestion(id, 'Blue', { requestId: action.id, actionToken: action.presentation.token });
    const answerIndex = events.findIndex(event => event.type === 'question_answer');
    assert.ok(answerIndex > events.findIndex(event => event.type === 'result'));
    assert.ok(events.slice(answerIndex + 1).some(event => event.state === 'think_end'));
    assert.equal(events.at(-1).state, 'idle');
    assert.equal(events.filter(event => event.type === 'result').length, 1);
  } finally { await provider.close(); }
});

test('turn changes keep raw tool rows hidden while pending commentary is delivered once', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'old');
    client.current.turns[0].items.push({ id: 'tool-before', type: 'commandExecution', status: 'inProgress' },
      { id: 'update', type: 'agentMessage', phase: 'commentary', text: 'Progress before the next turn.' });
    await provider.watch(id);
    client.current = state('completed', 'Done', 'next'); client.emit('state', id, client.current);
    assert.equal(events.some(event => event.toolId === 'tool-before'), false);
    assert.equal(events.filter(event => event.type === 'tool_end' && event.summary === 'Progress before the next turn.').length, 1);
    assert.equal(events.at(-1).state, 'idle');
  } finally { await provider.close(); }
});

test('native acknowledgement pending state convergence is waiting, not a delivery error or a retry', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'new'); client.current.requests = [questionRequest()];
    const [action] = await provider.getActions(id);
    client.respondAction = async () => { client.replies.push({}); return { acknowledged: true, confirmed: false, pending: true }; };
    const result = await provider.respondQuestion(id, 'Blue', { requestId: action.id, actionToken: action.presentation.token });
    assert.equal(result.pending, true);
    assert.equal(provider.getSubscribedSessions()[0].submissionPending, true);
    assert.match(provider.getStatus(id).detail, /Response sent/);
    assert.equal(events.some(event => event.type === 'error'), false);
    await assert.rejects(provider.respondQuestion(id, 'Blue'), /No supported question/);
    assert.equal(client.replies.length, 1);
    client.current = state('completed', 'Blue', 'new'); client.emit('state', id, client.current);
    assert.equal(provider.getSubscribedSessions()[0].submissionPending, false);
    assert.equal(events.at(-1).state, 'idle');
  } finally { await provider.close(); }
});

test('reselecting a completed task resets client activity flags without duplicating the final answer', async () => {
  const { provider, events } = setup();
  try {
    await provider.watch(id);
    events.length = 0;
    await provider.watch(id);
    assert.ok(events.some(event => event.state === 'think_end'));
    assert.ok(events.some(event => event.state === 'text_end'));
    assert.ok(events.some(event => event.type === 'task_progress' && event.current === ''));
    assert.equal(events.at(-1).state, 'idle');
    assert.equal(events.some(event => event.type === 'result' || event.type === 'text_delta'), false);
  } finally { await provider.close(); }
});

test('phone prompt, desktop streaming, and final reply preserve the selected task', async () => {
  const { provider, client, events } = setup();
  try {
    assert.deepEqual(await provider.prompt(id, 'Hello'), { sessionId: id, provider: 'codex' });
    assert.deepEqual(client.starts, [{ thread: id, text: 'Hello' }]);
    client.current = state('inProgress', 'Bon', 'new'); client.emit('state', id, client.current);
    client.current = state('completed', 'Bonjour', 'new'); client.emit('state', id, client.current);
    assert.equal(events.filter(e => e.type === 'text_delta' && !e.bridgeFinalHeader).map(e => e.text).join(''), 'Bonjour');
    assert.equal(events.filter(e => e.type === 'result').length, 1);
    assert.equal(events.find(e => e.type === 'result').text, 'Bonjour');
    assert.equal(events.at(-1).state, 'idle');
    assert.ok(events.every(e => e.thread === id));
  } finally { await provider.close(); }
});

test('explicit message to busy task uses native steering with the same message identity', async () => {
  const { provider, client } = setup();
  try {
    client.current = state('inProgress', '', 'active');
    await provider.prompt(id, 'Second message');
    assert.deepEqual(client.starts, [{ thread: id, text: 'Second message', steering: true }]);
    assert.equal(provider.getSubscribedSessions()[0].submissionPending, false);
  } finally { await provider.close(); }
});

test('new task and noncatalog task are refused before any start', async () => {
  const { provider, client } = setup();
  try {
    await assert.rejects(provider.prompt(null, 'New'), e => e.statusCode === 400);
    await assert.rejects(provider.prompt('00000000-0000-0000-0000-000000000000', 'Unknown'), e => e.statusCode === 404);
    assert.equal(client.starts.length, 0);
  } finally { await provider.close(); }
});

test('disconnect/close and remote approval clicks never cancel or approve desktop work', async () => {
  const { provider, client, events } = setup();
  await provider.watch(id);
  await assert.rejects(provider.respondPermission(id, 'allow'), /No supported question/);
  await assert.rejects(provider.respondQuestion(id, 'skip'), /No supported question/);
  client.emit('disconnected');
  await provider.close();
  assert.equal(client.interrupts, 0);
  assert.equal(client.closes, 1);
  assert.equal(events.at(-1).state, 'idle');
});

test('public commentary remains readable in history while final result excludes updates and all output excludes private content', async () => {
  const { provider, client, events } = setup();
  try {
    await provider.prompt(id, 'Work');
    client.current.turns[0].items.push({ id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Checking the source.' },
      { id: 'private', type: 'reasoning', content: ['PRIVATE_REASONING_NOT_FOR_UI'] });
    client.emit('state', id, client.current);
    assert.ok(events.some(e => e.type === 'task_progress' && e.current.endsWith('Checking the source.')));
    assert.ok(events.some(e => e.type === 'tool_end' && e.summary === 'Checking the source.'));
    assert.equal(events.some(e => e.type === 'text_delta' && e.text.includes('Checking')), false);
    client.current.turns[0].status = 'completed';
    client.current.threadRuntimeStatus = { type: 'idle' };
    client.current.turns[0].items[0].text = 'Final answer.';
    client.emit('state', id, client.current);
    assert.equal(events.find(e => e.type === 'result').text, 'Final answer.');
    assert.ok(events.some(e => e.type === 'task_progress' && e.current === '' && e.completed === 1));
    assert.equal(JSON.stringify(events).includes('PRIVATE_REASONING_NOT_FOR_UI'), false);
    assert.ok((await provider.getHistory(id, 20)).some(m => /^\[0m00\] Checking the source\.$/.test(m.text)));
  } finally { await provider.close(); }
});

test('a final-phase async question is presented as a control and excluded from the final answer text', async () => {
  const { provider, client, events } = setup();
  try {
    await provider.prompt(id, 'Ask me a question');
    client.current.turns[0].items.push({ id: 'async-question', type: 'agentMessage', phase: 'final_answer',
      text: 'QUESTION_CONTROL_TEXT', questions: [{ title: 'Which color?',
        options: [{ label: 'Blue' }, { label: 'Green' }] }] });
    client.current.turns[0].status = 'completed';
    client.current.threadRuntimeStatus = { type: 'idle' };
    client.emit('state', id, client.current);
    assert.ok(events.some(event => event.type === 'user_question'));
    assert.equal(events.some(event => event.type === 'text_delta' && event.text.includes('QUESTION_CONTROL_TEXT')), false);
    assert.equal(events.find(event => event.type === 'result').text.includes('QUESTION_CONTROL_TEXT'), false);
    assert.equal(provider.getStatus(id).state, 'awaiting');
  } finally { await provider.close(); }
});

function questionRequest(requestId = 7) {
  return { id: requestId, method: 'item/tool/requestUserInput', params: { turnId: 'new', questions: [
    { id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Blue', description: 'Blue theme' }, { label: 'Green', description: 'Green theme' }] },
  ] } };
}

function asyncQuestionState(status = 'completed', questionItemId = 'native-question') {
  const current = state(status, '', 'question-turn');
  current.turns[0].items = [{ id: questionItemId, type: 'agentMessage', phase: 'final_answer',
    text: 'Thé ou café ?', questions: [{ title: 'Thé ou café ?', options: ['Thé', 'Café'] }] }];
  return current;
}
const asyncReplyText = questionId => '<send_user_message_question_reply>\n' +
  JSON.stringify([{ questionItemId: questionId, question: 'Thé ou café ?', answer: 'Café' }]) +
  '\n</send_user_message_question_reply>';

test('local async choice is rendered once despite turn input, native userMessage, and response acknowledgement', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = asyncQuestionState();
    const [action] = await provider.getActions(id);
    const reply = asyncReplyText(action.id);
    client.respondAction = async () => {
      client.current.threadRuntimeStatus = { type: 'active' };
      const turn = { turnId: 'answer-turn', status: 'inProgress', params: {
        clientUserMessageId: 'accepted-choice', input: [{ type: 'text', text: reply }] }, items: [] };
      client.current.turns.push(turn); client.emit('state', id, client.current);
      turn.items.push({ id: 'native-user-message', type: 'userMessage', clientId: 'accepted-choice', content: turn.params.input });
      client.emit('state', id, client.current);
      turn.status = 'completed'; client.current.threadRuntimeStatus = { type: 'idle' };
      turn.items.push({ id: 'native-final', type: 'agentMessage', phase: 'final_answer', text: 'Tu préfères le café.' });
      client.emit('state', id, client.current);
      return { acknowledged: true, confirmed: true, resolution: 'answer-confirmed' };
    };
    await provider.respondQuestion(id, 'Café', { requestId: action.id, actionToken: action.presentation.token });
    await provider.watch(id);
    const answers = events.filter(event => event.type === 'question_answer');
    assert.equal(answers.length, 1);
    assert.deepEqual(Object.values(answers[0].answers), ['Café']);
    assert.equal(events.some(event => event.type === 'user_prompt' && event.text.includes('Café')), false);
    assert.equal(events.find(event => event.type === 'result').text, 'Tu préfères le café.');
    assert.equal(events.at(-1).state, 'idle');
    const history = await provider.getHistory(id, 20);
    assert.equal(history.filter(message => message.role === 'user' && message.text === 'Thé ou café ?\nCafé').length, 1);
  } finally { await provider.close(); }
});

test('an async choice accepted on the Mac during an active turn appears once without a local response call', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = asyncQuestionState('inProgress');
    const [action] = await provider.getActions(id);
    const input = [{ type: 'text', text: asyncReplyText(action.id) }];
    client.current.turns[0].items.push({ id: 'steer', type: 'steeringUserMessage', status: 'accepted', clientUserMessageId: 'remote-choice', input });
    client.emit('state', id, client.current);
    client.current.turns[0].items.push({ id: 'native-copy', type: 'userMessage', clientId: 'remote-choice', content: input });
    client.emit('state', id, client.current);
    assert.equal(events.filter(event => event.type === 'question_answer').length, 1);
    assert.equal(client.replies.length, 0);
  } finally { await provider.close(); }
});

test('unseen remote question replies retain one readable message, while identical ordinary prompts are not deduplicated', async () => {
  const { provider, client, events } = setup();
  try {
    await provider.watch(id);
    client.current = state('inProgress', '', 'remote-answer');
    client.current.turns[0].params = { clientUserMessageId: 'remote-input', input: [{ type: 'text', text: asyncReplyText('unseen-question') }] };
    client.emit('state', id, client.current); client.emit('state', id, client.current);
    assert.equal(events.filter(event => event.type === 'user_prompt' && event.text === 'Thé ou café ?\nCafé').length, 1);
    for (const turnId of ['ordinary-one', 'ordinary-two']) {
      client.current = state('inProgress', '', turnId);
      client.current.turns[0].params.input = [{ type: 'text', text: 'Café' }];
      client.emit('state', id, client.current);
    }
    assert.equal(events.filter(event => event.type === 'user_prompt' && event.text === 'Café').length, 2);
  } finally { await provider.close(); }
});

test('storage failure before an answer sends nothing and shows a storage pause after refresh', async () => {
  const store = new DeliveryStore();
  const { provider, client } = setup({ store });
  try {
    client.current = state('inProgress', '', 'new'); client.current.requests = [questionRequest()];
    const [action] = await provider.getActions(id);
    store.save = () => { throw new Error('Synthetic disk failure'); };
    await assert.rejects(provider.respondQuestion(id, 'Blue', { requestId: action.id, actionToken: action.presentation.token }), /Synthetic disk failure/);
    await provider.watch(id);
    assert.match(provider.getStatus(id).detail, /Sending paused: delivery history/);
    await assert.rejects(provider.respondQuestion(id, 'Blue'), /Synthetic disk failure/);
    assert.equal(client.replies.length, 0);
  } finally { await provider.close(); }
});

test('native structured question can be answered once with exact displayed question correlation', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'new'); client.current.requests = [questionRequest()];
    await provider.watch(id);
    const question = events.find(e => e.type === 'user_question');
    const answer = JSON.stringify({ [question.questions[0].question]: 'Blue' });
    const response = await provider.respondQuestion(id, answer);
    assert.equal(response.confirmed, true);
    assert.deepEqual(client.replies[0].response.answers, { color: { answers: ['Blue'] } });
    assert.equal(events.find(e => e.type === 'question_answer').answers[question.questions[0].question], 'Blue');
    await assert.rejects(provider.respondQuestion(id, answer), /No supported question/);
    assert.equal(client.replies.length, 1);
  } finally { await provider.close(); }
});

test('actions endpoint returns the same presentation token that response validation expects', async () => {
  const { provider, client } = setup();
  try {
    client.current = state('inProgress', '', 'new'); client.current.requests = [questionRequest()];
    const actions = await provider.getActions(id);
    const again = await provider.getActions(id);
    assert.equal(actions[0].presentation.token, again[0].presentation.token);
    await provider.respondQuestion(id, 'Green', { requestId: actions[0].id, actionToken: actions[0].presentation.token });
    assert.deepEqual(client.replies[0].response.answers, { color: { answers: ['Green'] } });
  } finally { await provider.close(); }
});

test('approval requires the exact displayed key and preserves separate native decisions', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'new');
    client.current.requests = [{ id: 11, method: 'item/commandExecution/requestApproval', params: {
      turnId: 'new', command: 'true', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    } }];
    await provider.watch(id);
    const approval = events.find(e => e.type === 'permission_request');
    assert.equal(approval.options.length, 4);
    await assert.rejects(provider.respondPermission(id, 'allow'), /approval choices/);
    assert.equal(client.replies.length, 0);
    await provider.respondPermission(id, approval.options.find(o => o.text === 'Allow once').key);
    assert.equal(client.replies[0].response.choiceId, 'accept');
    assert.equal(events.find(e => e.type === 'permission_result').decision, 'allowed');
  } finally { await provider.close(); }
});

test('a stale tap cannot approve the next request', async () => {
  const { provider, client, events } = setup();
  const approval = requestId => ({ id: requestId, method: 'item/commandExecution/requestApproval', params: {
    turnId: 'new', command: 'true', availableDecisions: ['accept', 'decline'],
  } });
  try {
    client.current = state('inProgress', '', 'new'); client.current.requests = [approval(1)];
    await provider.watch(id);
    const oldKey = events.find(e => e.type === 'permission_request').options[0].key;
    client.current.requests = [approval(2)]; client.emit('state', id, client.current);
    await assert.rejects(provider.respondPermission(id, oldKey), /approval choices/);
    assert.equal(client.replies.length, 0);
  } finally { await provider.close(); }
});

test('reconnecting catches the missing final once without replaying the prompt', async () => {
  const { provider, client, events } = setup();
  try {
    await provider.prompt(id, 'Once');
    client.current = state('inProgress', 'Part', 'new'); client.emit('state', id, client.current);
    client.emit('disconnected');
    client.current = state('completed', 'Partial then final', 'new');
    await provider.watch(id); await provider.watch(id);
    assert.equal(events.filter(e => e.type === 'result').length, 1);
    assert.equal(events.filter(e => e.type === 'text_delta' && !e.bridgeFinalHeader).map(e => e.text).join(''), 'Partial then final');
    assert.equal(client.starts.length, 1);
  } finally { await provider.close(); }
});

test('acknowledgement arriving before desktop broadcast still blocks duplicate submissions', async () => {
  const { provider, client } = setup();
  client.startTurn = async (thread, text) => { client.starts.push({ thread, text }); return { turn: { id: 'new' } }; };
  try {
    await provider.prompt(id, 'Once');
    assert.equal(provider.getStatus(id).state, 'busy');
    await assert.rejects(provider.prompt(id, 'Twice'), e => e.statusCode === 409);
    assert.equal(client.starts.length, 1);
  } finally { await provider.close(); }
});

test('loss of one task owner clears stale busy state even when IPC router stays connected', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'running');
    await provider.watch(id);
    client.emit('threadDisconnected', id);
    assert.equal(provider.getStatus(id).state, 'idle');
    assert.equal(events.at(-1).state, 'idle');
  } finally { await provider.close(); }
});

test('failed response without assistant text still exposes the desktop error', async () => {
  const { provider, client, events } = setup();
  try {
    await provider.prompt(id, 'Once');
    client.current = state('failed', '', 'new');
    client.current.turns[0].error = { message: 'Model temporarily unavailable' };
    client.emit('state', id, client.current);
    assert.equal(events.find(e => e.type === 'result').text, 'Model temporarily unavailable');
  } finally { await provider.close(); }
});

test('busy runtime with previous completed turn does not replay the previous response', async () => {
  const { provider, client, events } = setup();
  try {
    client.current.threadRuntimeStatus = { type: 'active' };
    await provider.watch(id);
    assert.equal(events.some(e => ['text_delta', 'result', 'user_prompt'].includes(e.type)), false);
    assert.equal(provider.getStatus(id).state, 'busy');
  } finally { await provider.close(); }
});

test('uncertain submission stays blocked after no-op cancellation and unrelated turn', async () => {
  const { provider, client, events } = setup();
  let submittedId;
  client.startTurn = async (thread, text, clientUserMessageId) => {
    submittedId = clientUserMessageId;
    client.starts.push({ thread, text });
    throw Object.assign(new Error('timeout'), { outcomeUnknown: true });
  };
  client.interrupt = async () => ({ ok: true, interruptedTurnId: null });
  try {
    await assert.rejects(provider.prompt(id, 'Once'), e => e.outcomeUnknown);
    assert.equal(provider.getStatus(id).state, 'idle');
    await assert.rejects(provider.interrupt(id), /Stop is unconfirmed/);
    assert.ok(events.some(e => e.message?.includes('Stop is unconfirmed')));
    client.current = state('completed', 'Other answer', 'unrelated');
    client.emit('state', id, client.current);
    await assert.rejects(provider.prompt(id, 'Twice'), e => e.statusCode === 409);
    assert.equal(client.starts.length, 1);
    client.current = state('completed', 'Original finished', 'confirmed');
    client.current.turns[0].params.clientUserMessageId = submittedId;
    client.emit('state', id, client.current);
    client.startTurn = async () => ({ turn: { id: 'next' } });
    await provider.prompt(id, 'After confirmed completion');
  } finally { await provider.close(); }
});

test('acknowledged prompt followed by storage failure remains blocked across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-provider-storage-'));
  const store = new DeliveryStore({ directory });
  const durableSave = store.save.bind(store);
  let saves = 0;
  store.save = () => { if (++saves > 1) throw new Error('Synthetic disk failure'); durableSave(); };
  const first = setup({ store });
  first.client.startTurn = async (thread, text) => { first.client.starts.push({ thread, text }); return { turn: { id: 'new' } }; };
  let second;
  try {
    await assert.rejects(first.provider.prompt(id, 'Only once'), error => error.outcomeUnknown === true);
    await assert.rejects(first.provider.prompt(id, 'Do not repeat'), /Synthetic disk failure/);
    assert.equal(first.client.starts.length, 1);
    await first.provider.close();
    second = setup({ store: new DeliveryStore({ directory }) });
    await assert.rejects(second.provider.prompt(id, 'Do not repeat after restart'), error => error.statusCode === 409);
    assert.equal(second.client.starts.length, 0);
  } finally {
    await first.provider.close();
    if (second) await second.provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('acknowledged action followed by storage failure cannot be approved twice after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-action-storage-'));
  const store = new DeliveryStore({ directory });
  const durableSave = store.save.bind(store);
  let saves = 0;
  const first = setup({ store });
  const pending = state('inProgress', '', 'new'); pending.requests = [questionRequest()];
  first.client.current = structuredClone(pending);
  first.client.respondAction = async (thread, requestId, response) => {
    first.client.replies.push({ requestId, response }); return { confirmed: true };
  };
  let second;
  try {
    const [action] = await first.provider.getActions(id);
    store.save = () => { if (++saves > 1) throw new Error('Synthetic disk failure'); durableSave(); };
    await assert.rejects(first.provider.respondQuestion(id, 'Blue', {
      requestId: action.id, actionToken: action.presentation.token,
    }), error => error.outcomeUnknown === true);
    assert.equal(first.client.replies.length, 1);
    await first.provider.close();
    second = setup({ store: new DeliveryStore({ directory }) });
    second.client.current = structuredClone(pending);
    await second.provider.watch(id);
    await assert.rejects(second.provider.respondQuestion(id, 'Blue'), /No supported question/);
    assert.equal(second.client.replies.length, 0);
    assert.equal(second.events.some(event => event.type === 'user_question'), false);
  } finally {
    await first.provider.close();
    if (second) await second.provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('commentary is one complete native activity row across patches, separate from final text and replay', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'progress');
    client.current.turns[0].items.push({ id: 'update', type: 'agentMessage', phase: 'commentary', text: 'Checking' });
    await provider.watch(id);
    client.current.turns[0].items.at(-1).text = 'Checking files.'; client.emit('state', id, client.current);
    await provider.watch(id);
    assert.equal(events.some(e => e.type === 'tool_end'), false);
    client.current.turns[0].items.push({ id: 'final-new', type: 'agentMessage', phase: 'final_answer', text: 'Finished.' });
    client.emit('state', id, client.current);
    const start = events.find(e => e.type === 'tool_start');
    const end = events.find(e => e.type === 'tool_end');
    assert.equal(start.toolId, end.toolId);
    assert.equal(end.name, '[0m00]');
    assert.equal(end.summary, 'Checking files.');
    assert.deepEqual(end.detail, { output: 'Checking files.' });
    assert.equal(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), '[0m00]\n\nFinished.');
    client.current.turns[0].status = 'completed'; client.current.threadRuntimeStatus = { type: 'idle' };
    client.emit('state', id, client.current); await provider.watch(id);
    assert.equal(events.filter(e => e.type === 'tool_end').length, 1);
    assert.equal(events.find(e => e.type === 'result').text, '\n\nFinished.');
  } finally { await provider.close(); }
});

test('native elapsed time survives reconnect and stops after completion, awaiting response, or disconnect', async () => {
  let time = 300000;
  const { provider, client, events } = setup({ now: () => time, statsIntervalMs: 10 });
  try {
    client.current = state('inProgress', '', 'timed'); client.current.turns[0].turnStartedAtMs = 100000;
    await provider.watch(id);
    assert.equal(events.filter(e => e.type === 'running_stats').at(-1).durationMs, 200000);
    time += 10000;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(events.filter(e => e.type === 'running_stats').at(-1).durationMs, 210000);
    client.emit('disconnected');
    let count = events.filter(e => e.type === 'running_stats').length;
    time += 10000; await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(events.filter(e => e.type === 'running_stats').length, count);
    await provider.watch(id);
    assert.equal(events.filter(e => e.type === 'running_stats').at(-1).durationMs, 220000);
    client.current.requests = [questionRequest()]; client.emit('state', id, client.current);
    count = events.filter(e => e.type === 'running_stats').length;
    time += 10000; await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(events.filter(e => e.type === 'running_stats').length, count);
    client.current.requests = []; client.current.turns[0].status = 'completed'; client.current.turns[0].durationMs = 225000;
    client.current.threadRuntimeStatus = { type: 'idle' }; client.emit('state', id, client.current);
    time += 10000; await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(events.filter(e => e.type === 'running_stats').length, count);
    assert.equal(events.find(e => e.type === 'result').durationMs, 225000);
  } finally { await provider.close(); }
});

test('public activity remains available while generic tool rows and private payloads stay out of the transcript', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'descriptive');
    client.current.turns[0].items.push({ id: 'activity', type: 'reasoning', summary: ['**Checking reply handling**'], content: ['HIDDEN_PRIVATE_CONTENT'] },
      { id: 'read', type: 'commandExecution', status: 'inProgress', command: 'HIDDEN_COMMAND', commandActions: [{ type: 'read', path: '/private/place/provider.mjs' }], output: 'HIDDEN_TOOL_OUTPUT' },
      { id: 'patch', type: 'fileChange', status: 'inProgress', changes: [{ path: '/private/place/interface.ts', kind: { type: 'update' }, diff: 'HIDDEN_DIFF' }] });
    await provider.watch(id);
    assert.equal(events.some(e => e.type === 'tool_start' || e.type === 'tool_end'), false);
    assert.ok(events.some(e => e.type === 'task_progress' && e.current.includes('Checking reply handling')));
    assert.doesNotMatch(JSON.stringify(events), /HIDDEN_|\/private\/place/);
    client.current.turns[0].items.at(-2).status = 'completed'; client.emit('state', id, client.current);
    assert.equal(events.some(e => e.toolId === 'read'), false);
  } finally { await provider.close(); }
});

test('production question labels use readable persisted numbering instead of random bracket codes', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'question'); client.current.requests = [questionRequest()];
    await provider.watch(id);
    const question = events.find(e => e.type === 'user_question').questions[0].question;
    assert.match(question, /^Question 1\n/);
    assert.doesNotMatch(question, /\[[a-f0-9]{12}:Q\d+\]/);
  } finally { await provider.close(); }
});

test('opening completed history never restreams old commentary', async () => {
  const { provider, client, events } = setup();
  try {
    client.current.turns[0].items.unshift({ id: 'old-update', type: 'agentMessage', phase: 'commentary', text: 'Old progress.' });
    await provider.watch(id); await provider.watch(id);
    const history = await provider.getHistory(id, 10);
    assert.equal(events.some(e => e.type === 'text_delta'), false);
    assert.ok(history.some(message => message.text === 'Old progress.'));
  } finally { await provider.close(); }
});

test('reconnect resumes missing commentary without showing raw tools and reopens final text', async () => {
  const { provider, client, events } = setup();
  try {
    client.current = state('inProgress', '', 'resume');
    client.current.turns[0].items.push({ id: 'update', type: 'agentMessage', phase: 'commentary', text: 'Checking' });
    await provider.watch(id);
    client.emit('disconnected');
    client.current.turns[0].items.at(-1).text = 'Checking files.';
    await provider.watch(id);
    assert.equal(events.filter(event => event.type === 'tool_end').map(event => event.summary).join(''), 'Checking');
    client.current.turns[0].items.push({ id: 'tool', type: 'commandExecution', status: 'inProgress' });
    client.current.turns[0].items[0].text = 'Part'; client.emit('state', id, client.current);
    client.emit('disconnected'); events.length = 0;
    client.current.turns[0].items[0].text = 'Partial'; await provider.watch(id);
    assert.ok(events.findIndex(event => event.state === 'text_start') < events.findIndex(event => event.type === 'text_delta' && event.text === 'ial'));
    assert.equal(events.some(event => event.type === 'tool_start' && event.toolId === 'tool'), false);
  } finally { await provider.close(); }
});

test('an asynchronous question does not hide the elapsed clock while the Mac keeps working', async () => {
  const { provider, client, events } = setup({ now: () => 300000 });
  try {
    client.current = state('inProgress', '', 'async-working'); client.current.turns[0].turnStartedAtMs = 100000;
    client.current.turns[0].items.push({ id: 'open-async', type: 'agentMessage', phase: 'commentary', text: 'Choose a color.', questions: [{ title: 'Blue or green?', options: [{ label: 'Blue' }, { label: 'Green' }] }] },
      { id: 'heading', type: 'reasoning', summary: ['**Checking the remaining files**'] });
    await provider.watch(id);
    assert.equal(provider.getStatus(id).state, 'awaiting');
    assert.equal(events.filter(e => e.type === 'running_stats').at(-1).durationMs, 200000);
    assert.ok(events.some(e => e.type === 'task_progress' && e.current.includes('Checking the remaining files')));
    assert.equal(events.some(e => e.type === 'text_delta' && e.text.includes('Choose a color')), false);
    client.current.turns[0].status = 'completed'; client.current.threadRuntimeStatus = { type: 'idle' }; client.emit('state', id, client.current);
    const count = events.filter(e => e.type === 'running_stats').length;
    await provider.watch(id);
    assert.equal(events.filter(e => e.type === 'running_stats').length, count);
  } finally { await provider.close(); }
});

test('elapsed labels stay inline for updates and precede the final with extra spacing', async () => {
  let time = 100000;
  const { provider, client, events } = setup({ now: () => time });
  try {
    client.current = state('inProgress', '', 'visible-time'); client.current.turns[0].turnStartedAtMs = 10000;
    client.current.turns[0].items.push({ id: 'first', type: 'agentMessage', phase: 'commentary', text: 'First update.' });
    await provider.watch(id);
    time = 120000;
    client.current.turns[0].items.at(-1).text += ' Extra detail.'; client.emit('state', id, client.current);
    assert.equal(events.filter(e => e.type === 'tool_end').length, 0);
    client.current.turns[0].items.push({ id: 'second', type: 'agentMessage', phase: 'commentary', text: 'Second update.' });
    client.emit('state', id, client.current);
    time = 135000; client.current.turns[0].items[0].text = 'Final reply.'; client.emit('state', id, client.current);
    const text = events.filter(e => e.type === 'text_delta').map(e => e.text).join('');
    assert.equal(text, '[2m05]\n\nFinal reply.');
    assert.deepEqual(events.filter(e => e.type === 'tool_end').map(e => [e.name, e.summary]), [['[1m30]', 'First update. Extra detail.'], ['[1m50]', 'Second update.']]);
    assert.doesNotMatch(text, /\bUpdate\b|\bAnswer\b/);
    time = 155000; client.current.turns[0].status = 'completed'; client.current.turns[0].durationMs = 145000; client.current.threadRuntimeStatus = { type: 'idle' };
    client.emit('state', id, client.current);
    const history = await provider.getHistory(id, 10);
    assert.ok(history.some(m => m.text === '[1m30] First update. Extra detail.'));
    assert.ok(history.some(m => m.text === '[1m50] Second update.'));
    assert.ok(history.some(m => m.text === '[2m05]\n\nFinal reply.'));
    assert.equal(events.filter(e => e.bridgeFinalHeader).length, 1);
  } finally { await provider.close(); }
});

test('old history uses known final duration and never invents elapsed timestamps for old updates', async () => {
  const { provider, client } = setup({ now: () => 999999999 });
  try {
    client.current.turns[0].durationMs = 85000;
    client.current.turns[0].items.unshift({ id: 'old-update', type: 'agentMessage', phase: 'commentary', text: 'Historical update.' });
    const history = await provider.getHistory(id, 10);
    assert.ok(history.some(m => m.text === 'Historical update.'));
    assert.ok(history.some(m => m.text === '[1m25]\n\nPrevious answer'));
  } finally { await provider.close(); }
});

test('native per-message timestamps recover exact elapsed labels when joining existing work', async () => {
  const { provider, client, events } = setup({ now: () => 900000 });
  try {
    client.current = state('inProgress', '', 'native-message-time');
    Object.assign(client.current.turns[0], { turnStartedAtMs: 100000, aeonAssistantMessageStartedAtMsById: { update: 781000 } });
    client.current.turns[0].items.push({ id: 'update', type: 'agentMessage', phase: 'commentary', text: 'Existing update.' }, { id: 'after', type: 'reasoning', summary: [] });
    await provider.watch(id);
    assert.ok(events.some(e => e.type === 'tool_end' && e.name === '[11m21]' && e.summary === 'Existing update.'));
    const history = await provider.getHistory(id, 10);
    assert.ok(history.some(m => m.text === '[11m21] Existing update.'));
  } finally { await provider.close(); }
});

test('final time label prefers its own native message timestamp over the turn-wide assistant timestamp', async () => {
  const { provider, client, events } = setup({ now: () => 200000 });
  try {
    client.current = state('inProgress', 'A reply.', 'final-item-time');
    Object.assign(client.current.turns[0], { turnStartedAtMs: 100000, finalAssistantStartedAtMs: 180000,
      aeonAssistantMessageStartedAtMsById: { 'answer-final-item-time': 140000 } });
    await provider.watch(id);
    assert.equal(events.find(e => e.bridgeFinalHeader).text, '[0m40]\n\n');
  } finally { await provider.close(); }
});

test('long public updates keep their full text in one native activity pair without ordinary-text duplicates', async () => {
  const { provider, client, events } = setup();
  try {
    const text = 'A useful detailed update. '.repeat(220) + '\nSecond paragraph.';
    client.current = state('inProgress', '', 'long-commentary');
    client.current.turns[0].items.push({ id: 'update', type: 'agentMessage', phase: 'commentary', text }, { id: 'reason', type: 'reasoning', content: ['PRIVATE'] });
    await provider.watch(id); await provider.watch(id);
    const starts = events.filter(e => e.type === 'tool_start');
    const ends = events.filter(e => e.type === 'tool_end');
    assert.equal(starts.length, 1); assert.equal(ends.length, 1);
    assert.equal(starts[0].toolId, ends[0].toolId);
    assert.equal(ends[0].summary, text); assert.equal(ends[0].detail.output, text);
    assert.equal(events.some(e => e.type === 'text_delta' && e.text.includes('useful')), false);
    assert.ok(events.some(e => e.state === 'think_start'));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  } finally { await provider.close(); }
});

test('a quiet last commentary paragraph is displayed and a later suffix is never duplicated', async () => {
  const { provider, client, events } = setup({ commentarySettleMs: 15 });
  try {
    client.current = state('inProgress', '', 'quiet-commentary');
    client.current.turns[0].items.push({ id: 'update', type: 'agentMessage', phase: 'commentary', text: 'First part.' });
    await provider.watch(id);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(events.filter(e => e.type === 'tool_end').map(e => e.summary), ['First part.']);
    client.current.turns[0].items.at(-1).text += ' Later detail.'; client.emit('state', id, client.current);
    await new Promise(resolve => setTimeout(resolve, 60));
    const ends = events.filter(e => e.type === 'tool_end');
    assert.deepEqual(ends.map(e => e.summary), ['First part.', ' Later detail.']);
    assert.equal(new Set(ends.map(e => e.toolId)).size, 2);
    for (const end of ends) assert.equal(events.filter(e => e.type === 'tool_start' && e.toolId === end.toolId).length, 1);
  } finally { await provider.close(); }
});

test('joining active work does not assign current time to older skipped commentary', async () => {
  const { provider, client } = setup({ now: () => 500000 });
  try {
    client.current = state('inProgress', '', 'joining'); client.current.turns[0].turnStartedAtMs = 100000;
    client.current.turns[0].items.push({ id: 'old', type: 'agentMessage', phase: 'commentary', text: 'An older update.' },
      { id: 'latest', type: 'agentMessage', phase: 'commentary', text: 'The current update.' });
    await provider.watch(id);
    const history = await provider.getHistory(id, 10);
    assert.ok(history.some(e => e.text === 'An older update.'));
    assert.ok(history.some(e => e.text === '[6m40] The current update.'));
  } finally { await provider.close(); }
});

test('display settings hide only assistant timestamps and public progress, preserving final and input', async () => {
  const formatting = { showTimestamps: false, showProgressUpdates: false, paragraphSpacing: 'original' };
  const { provider, client, events } = setup({ readTextFormatting: () => formatting });
  try {
    const prompt = '**Exact**\n\nUser input';
    await provider.prompt(id, prompt);
    assert.equal(client.starts[0].text, prompt);
    client.current.turns[0].params.input = [{ type: 'text', text: prompt }];
    client.current.turns[0].items.push({ id: 'update', type: 'agentMessage', phase: 'commentary', text: 'Working\n\ncarefully.' });
    client.emit('state', id, client.current);
    client.current.turns[0].items[0].text = '**Exact** final\n\nanswer.';
    client.current.turns[0].status = 'completed'; client.current.threadRuntimeStatus = { type: 'idle' };
    client.emit('state', id, client.current);
    assert.equal(events.some(event => event.type === 'tool_start' || event.type === 'tool_end'), false);
    assert.equal(events.some(event => event.type === 'task_progress' && event.current), false);
    assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), '**Exact** final\n\nanswer.');
    const history = await provider.getHistory(id, 20);
    assert.equal(history.some(message => message.text.includes('carefully.')), false);
    assert.ok(history.some(message => message.text === '**Exact** final\n\nanswer.'));
    assert.ok(history.some(message => message.role === 'user' && message.text === prompt));
  } finally { await provider.close(); }
});

test('formatting changes apply at turn boundaries without replaying a current response or changing delivery', async () => {
  let formatting = { ...DEFAULT_TEXT_FORMATTING };
  const { provider, client, events } = setup({ readTextFormatting: () => formatting });
  try {
    await provider.prompt(id, 'Start');
    client.current.turns[0].items[0].text = 'First.\n\n';
    client.emit('state', id, client.current);
    formatting = { ...formatting, showTimestamps: false, paragraphSpacing: 'compact' };
    client.current.turns[0].items[0].text += 'Second.';
    client.current.turns[0].status = 'completed'; client.current.threadRuntimeStatus = { type: 'idle' };
    client.emit('state', id, client.current);
    assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), '[0m00]\n\nFirst.\n\nSecond.');
    const history = await provider.getHistory(id, 20);
    assert.ok(history.some(message => message.text === 'First.\nSecond.'));
    assert.equal(events.filter(event => event.type === 'result').length, 1);
    events.length = 0;
    client.current = state('inProgress', '', 'next'); client.emit('state', id, client.current);
    for (const text of ['First.', 'First.\n\nSec', 'First.\n\nSecond.\nThird.']) {
      client.current.turns[0].items[0].text = text; client.emit('state', id, client.current);
    }
    client.current.turns[0].status = 'completed'; client.current.threadRuntimeStatus = { type: 'idle' };
    client.emit('state', id, client.current);
    await provider.watch(id);
    assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), 'First.\nSecond.\nThird.');
    assert.equal(events.filter(event => event.type === 'result').length, 1);
    assert.equal(events.find(event => event.type === 'result').text, 'First.\nSecond.\nThird.');
    assert.equal(client.starts.length, 1);
  } finally { await provider.close(); }
});

test('all display preferences leave questions, approval choices, correlation and replies unchanged', async () => {
  const baseline = setup();
  const customized = setup({ readTextFormatting: () => ({ showTimestamps: false, showProgressUpdates: false, paragraphSpacing: 'compact' }) });
  try {
    for (const instance of [baseline, customized]) {
      instance.client.current = state('inProgress', '', 'actions');
      instance.client.current.requests = [questionRequest()];
    }
    const original = await baseline.provider.getActions(id);
    const modified = await customized.provider.getActions(id);
    const withoutRandomToken = actions => actions.map(action => ({ ...action, presentation: { ...action.presentation, token: '<token>' } }));
    assert.deepEqual(withoutRandomToken(modified), withoutRandomToken(original));
    const action = modified[0];
    await customized.provider.respondQuestion(id, 'Blue', { requestId: action.id, actionToken: action.presentation.token });
    await baseline.provider.respondQuestion(id, 'Blue', { requestId: original[0].id, actionToken: original[0].presentation.token });
    assert.deepEqual(customized.client.replies, baseline.client.replies);
    for (const instance of [baseline, customized]) {
      instance.client.current.requests = [{ id: 11, method: 'item/commandExecution/requestApproval', params: {
        turnId: 'actions', command: 'echo first\n\necho second', availableDecisions: ['accept', 'decline'],
      } }];
      instance.client.emit('state', id, instance.client.current);
    }
    const [approval] = await customized.provider.getActions(id);
    const [originalApproval] = await baseline.provider.getActions(id);
    // Opaque tokens and choice keys are independently generated per presentation.
    assert.equal(approval.fingerprint, originalApproval.fingerprint);
    assert.deepEqual(approval.choices, originalApproval.choices);
    assert.equal(approval.description, originalApproval.description);
    assert.equal(approval.title, originalApproval.title);
  } finally { await baseline.provider.close(); await customized.provider.close(); }
});

test('a late commentary suffix after a flushed paragraph gap keeps every word once', async () => {
  const { provider, client, events } = setup({ readTextFormatting: () => ({ ...DEFAULT_TEXT_FORMATTING, paragraphSpacing: 'compact' }) });
  try {
    client.current = state('inProgress', '', 'commentary');
    const update = { id: 'update', type: 'agentMessage', phase: 'commentary', text: 'First.\n\n' };
    client.current.turns[0].items.push(update, { id: 'reason', type: 'reasoning' });
    await provider.watch(id);
    update.text += 'Second.'; client.emit('state', id, client.current);
    update.text += ' Third.'; client.emit('state', id, client.current);
    const shown = events.filter(event => event.type === 'tool_end').map(event => event.summary).join('');
    assert.equal(shown, 'First.\n\nSecond. Third.');
    assert.equal(client.starts.length, 0);
    assert.equal(client.replies.length, 0);
  } finally { await provider.close(); }
});
