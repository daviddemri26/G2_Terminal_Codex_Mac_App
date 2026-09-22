import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import eventsRouter, { pushMessage, getMessages, broadcast, setSessionWatchHandler, clientCount } from '../../.build/runtime/dist/routes/events.js';

test('completed replay keeps full answer and progress clearing without intermediate answer fragments', () => {
  const id = 'replay-final';
  pushMessage(id, { type: 'user_prompt', text: 'Question' });
  pushMessage(id, { type: 'status', state: 'busy' });
  pushMessage(id, { type: 'task_progress', current: 'Checking', completed: 0, total: 1 });
  pushMessage(id, { type: 'text_delta', text: 'Final ' });
  const cursor = pushMessage(id, { type: 'text_delta', text: 'answer' });
  pushMessage(id, { type: 'status', state: 'think_end' });
  pushMessage(id, { type: 'status', state: 'text_end' });
  pushMessage(id, { type: 'task_progress', current: '', completed: 1, total: 1 });
  pushMessage(id, { type: 'result', text: 'Final answer', success: true });
  pushMessage(id, { type: 'status', state: 'idle' });
  assert.deepEqual(getMessages(id, 0).map(e => e.type), ['user_prompt', 'status', 'status', 'task_progress', 'result', 'status']);
  assert.deepEqual(getMessages(id, cursor).map(e => e.state ?? e.type), ['think_end', 'text_end', 'task_progress', 'result', 'idle']);
  assert.equal(getMessages(id, 0).find(e => e.type === 'result').text, 'Final answer');
});

test('long running turns keep a bounded replay buffer, latest progress, and current prompt', () => {
  const id = 'long-turn';
  pushMessage(id, { type: 'user_prompt', text: 'Keep this prompt' });
  for (let n = 0; n < 1000; n++) {
    pushMessage(id, { type: 'task_progress', current: 'Progress ' + n, completed: 0, total: 1 });
    pushMessage(id, { type: 'text_delta', text: '.' });
  }
  const messages = getMessages(id, 0);
  assert.ok(messages.length <= 500);
  assert.equal(messages[0].text, 'Keep this prompt');
  assert.deepEqual(messages.filter(e => e.type === 'task_progress').map(e => e.current), ['Progress 999']);
  pushMessage(id, { type: 'result', text: 'Complete long answer' });
  assert.deepEqual(getMessages(id, 0).map(e => e.type), ['user_prompt', 'result']);
});

test('completed replay preserves the question and its single selected answer', () => {
  const id = 'question-replay';
  pushMessage(id, { type: 'user_prompt', text: 'Ask me a question' });
  pushMessage(id, { type: 'user_question', questions: [{ question: 'Tea or coffee?' }] });
  pushMessage(id, { type: 'question_answer', answers: { 'Tea or coffee?': 'Coffee' } });
  pushMessage(id, { type: 'result', text: 'You prefer coffee.' });
  assert.deepEqual(getMessages(id, 0).map(event => event.type), ['user_prompt', 'user_question', 'question_answer', 'result']);
  assert.equal(getMessages(id, 0).filter(event => event.type === 'question_answer').length, 1);
});

test('elapsed-time heartbeats retain only the latest value and disappear after completion', () => {
  const id = 'timer-replay';
  pushMessage(id, { type: 'user_prompt', text: 'Work' });
  pushMessage(id, { type: 'text_delta', text: 'Update\nReading files.\n\n', bridgePublicUpdate: true });
  for (let n = 0; n < 1000; n++) pushMessage(id, { type: 'running_stats', durationMs: n * 10000 });
  const pending = getMessages(id, 0);
  assert.equal(pending.length, 3);
  assert.equal(pending.at(-1).durationMs, 9990000);
  pushMessage(id, { type: 'result', text: 'Finished.' });
  assert.deepEqual(getMessages(id, 0).map(event => event.type), ['user_prompt', 'text_delta', 'result']);
});

test('replay retains frozen update timestamps and one final time label before the complete answer', () => {
  const id = 'visible-timestamp-replay';
  pushMessage(id, { type: 'user_prompt', text: 'Work' });
  pushMessage(id, { type: 'text_delta', text: '[12s] Working.\n\n', bridgePublicUpdate: true });
  pushMessage(id, { type: 'text_delta', text: '[1:04]\n\n', bridgeFinalHeader: true });
  pushMessage(id, { type: 'text_delta', text: 'Finished.' });
  pushMessage(id, { type: 'result', text: 'Finished.' });
  const messages = getMessages(id, 0);
  assert.equal(messages.filter(e => e.bridgeFinalHeader).length, 1);
  assert.equal(messages.filter(e => e.type === 'text_delta').map(e => e.text).join(''), '[12s] Working.\n\n[1:04]\n\n');
  assert.equal(messages.at(-1).text, 'Finished.');
});

test('native public-commentary pairs survive completed replay while generic tool chatter does not', () => {
  const id = 'native-commentary-replay';
  pushMessage(id, { type: 'user_prompt', text: 'Work' });
  pushMessage(id, { type: 'tool_start', toolId: 'public-1', name: '[15s]', bridgePublicUpdate: true });
  pushMessage(id, { type: 'tool_end', toolId: 'public-1', name: '[15s]', summary: 'Complete public update.', detail: { output: 'Complete public update.' }, bridgePublicUpdate: true });
  pushMessage(id, { type: 'tool_end', toolId: 'raw-tool', name: 'Running a command', summary: 'Done' });
  pushMessage(id, { type: 'text_delta', text: '[40s]\n\n', bridgeFinalHeader: true });
  pushMessage(id, { type: 'result', text: 'The final answer.' });
  const messages = getMessages(id, 0);
  assert.deepEqual(messages.map(e => e.type), ['user_prompt', 'tool_start', 'tool_end', 'text_delta', 'result']);
  assert.equal(messages[2].summary, 'Complete public update.');
  assert.equal(messages.some(e => e.toolId === 'raw-tool'), false);
});


test('multiple public activity families survive replay before one complete final answer', () => {
  const id = 'activity-families-replay';
  const rows = [
    ['heading', 'Checking the requested changes.'],
    ['subagent', 'Helper agent finished'],
    ['group', 'Read files, searched files'],
    ['diff', '4 files changed · +48 −0'],
  ];
  pushMessage(id, { type: 'user_prompt', text: 'Review this example.' });
  pushMessage(id, { type: 'status', state: 'busy' });
  for (const [kind, summary] of rows) {
    const toolId = `activity-${kind}`;
    pushMessage(id, { type: 'tool_start', toolId, name: '[12s]', bridgePublicUpdate: true });
    pushMessage(id, { type: 'tool_end', toolId, name: '[12s]', summary,
      detail: { output: summary }, bridgePublicUpdate: true });
  }
  pushMessage(id, { type: 'text_delta', text: '[15s]\n\n', bridgeFinalHeader: true });
  pushMessage(id, { type: 'text_delta', text: 'Partial final' });
  pushMessage(id, { type: 'status', state: 'think_end' });
  pushMessage(id, { type: 'status', state: 'text_end' });
  pushMessage(id, { type: 'result', text: 'The complete final answer.', success: true });
  pushMessage(id, { type: 'status', state: 'idle' });

  const messages = getMessages(id, 0);
  const finalIndex = messages.findIndex(event => event.type === 'result');
  assert.equal(messages.filter(event => event.type === 'result').length, 1);
  assert.equal(messages[finalIndex].text, 'The complete final answer.');
  assert.equal(messages.filter(event => event.bridgeFinalHeader).length, 1);
  assert.equal(messages.some(event => event.type === 'text_delta' && !event.bridgeFinalHeader), false);
  assert.deepEqual(messages.filter(event => event.type === 'tool_end').map(event => event.summary), rows.map(([, summary]) => summary));
  for (const [kind] of rows) {
    const pair = messages.map((event, index) => ({ event, index })).filter(({ event }) => event.toolId === `activity-${kind}`);
    assert.deepEqual(pair.map(({ event }) => event.type), ['tool_start', 'tool_end']);
    assert.ok(pair.every(({ event, index }) => event.bridgePublicUpdate === true && index < finalIndex));
  }
  assert.equal(messages.at(-1).state, 'idle');
});


test('local reset replaces the whole transient presentation without removing native questions or content', () => {
  const id = 'local-menu-reset';
  pushMessage(id, { type: 'user_prompt', text: 'Keep working on this response.' });
  pushMessage(id, { type: 'user_question', toolUseId: 'native-question', questions: [{ question: 'Native choice?' }] });
  pushMessage(id, { type: 'text_delta', text: 'Public progress', bridgePublicUpdate: true });
  pushMessage(id, { type: 'status', state: 'busy', bridgeLocalInteraction: true, bridgeLocalReset: true });
  const retired = pushMessage(id, { type: 'user_question', toolUseId: 'old-local-menu', questions: [{ question: 'Old local menu?' }], bridgeLocalInteraction: true });
  pushMessage(id, { type: 'question_answer', answers: { 'Old local menu?': 'Add prompt' }, bridgeLocalInteraction: true });
  pushMessage(id, { type: 'notification', message: 'Retired local instruction', bridgeLocalInteraction: true });
  pushMessage(id, { type: 'status', state: 'idle', bridgeLocalInteraction: true, bridgeLocalReset: true });
  pushMessage(id, { type: 'user_question', toolUseId: 'new-local-menu', questions: [{ question: 'New local menu?' }], bridgeLocalInteraction: true });
  const messages = getMessages(id, 0);
  assert.deepEqual(messages.filter(event => event.type === 'user_question').map(event => event.toolUseId), ['native-question', 'new-local-menu']);
  assert.equal(messages.some(event => event.id === retired || event.message === 'Retired local instruction' || event.type === 'question_answer'), false);
  assert.equal(messages.find(event => event.bridgePublicUpdate).text, 'Public progress');
  assert.deepEqual(messages.filter(event => event.bridgeLocalInteraction).map(event => event.state ?? event.type), ['idle', 'user_question']);
  pushMessage(id, { type: 'status', state: 'busy', bridgeLocalReset: true });
  assert.equal(getMessages(id, 0).some(event => event.bridgeLocalInteraction), false);
  assert.equal(getMessages(id, 0).some(event => event.toolUseId === 'native-question'), true);
  assert.equal(getMessages(id, retired).some(event => event.bridgeLocalInteraction), false);
});

test('compose idle retains the actual prompt and recent content across more than 500 events', () => {
  const id = 'compose-long-running-turn';
  pushMessage(id, { type: 'user_prompt', text: 'The actual current prompt' });
  pushMessage(id, { type: 'status', state: 'busy' });
  pushMessage(id, { type: 'status', state: 'idle', bridgeLocalInteraction: true, bridgeLocalReset: true });
  for (let n = 0; n < 650; n++) pushMessage(id, { type: 'text_delta', text: `response fragment ${n}` });
  const pending = getMessages(id, 0);
  assert.ok(pending.length <= 500);
  assert.equal(pending[0].text, 'The actual current prompt');
  assert.equal(pending.at(-1).text, 'response fragment 649');
  pushMessage(id, { type: 'result', text: 'The full native answer.' });
  pushMessage(id, { type: 'status', state: 'idle', bridgeLocalReset: true });
  assert.deepEqual(getMessages(id, 0).map(event => event.type), ['user_prompt', 'result', 'status']);
  assert.equal(getMessages(id, 0)[1].text, 'The full native answer.');
});

test('compose idle keeps native activity content while hundreds of elapsed updates coalesce', () => {
  const id = 'compose-timer-content';
  pushMessage(id, { type: 'user_prompt', text: 'Keep this task' });
  pushMessage(id, { type: 'tool_start', toolId: 'public-note', name: '[2s]', bridgePublicUpdate: true });
  pushMessage(id, { type: 'tool_end', toolId: 'public-note', name: '[2s]', summary: 'Public activity remains visible.', bridgePublicUpdate: true });
  pushMessage(id, { type: 'status', state: 'idle', bridgeLocalInteraction: true, bridgeLocalReset: true });
  for (let n = 0; n < 650; n++) pushMessage(id, { type: 'running_stats', durationMs: n * 1000 });
  pushMessage(id, { type: 'status', state: 'busy', bridgeLocalReset: true });
  const messages = getMessages(id, 0);
  assert.equal(messages.filter(event => event.type === 'running_stats').length, 1);
  assert.deepEqual(messages.filter(event => event.toolId === 'public-note').map(event => event.type), ['tool_start', 'tool_end']);
  assert.equal(messages.find(event => event.type === 'tool_end').summary, 'Public activity remains visible.');
  assert.equal(messages[0].text, 'Keep this task');
});

test('a local busy or local prompt never starts an actual turn for result pruning', () => {
  for (const type of ['status', 'user_prompt']) {
    const id = `local-only-${type}`;
    pushMessage(id, { type, state: 'busy', text: 'Local preview only', bridgeLocalInteraction: true });
    pushMessage(id, { type: 'text_delta', text: 'Existing native content' });
    pushMessage(id, { type: 'result', text: 'Existing completed answer' });
    pushMessage(id, { type: 'status', state: 'idle', bridgeLocalReset: true });
    assert.equal(getMessages(id, 0).some(event => event.text === 'Existing native content'), true);
    assert.equal(getMessages(id, 0).some(event => event.bridgeLocalInteraction), false);
  }
});

test('temporary local progress cannot replace native progress or elapsed statistics', () => {
  const id = 'separate-local-progress';
  pushMessage(id, { type: 'user_prompt', text: 'Task' });
  pushMessage(id, { type: 'task_progress', current: 'Native work', completed: 0, total: 1 });
  pushMessage(id, { type: 'running_stats', durationMs: 42000 });
  pushMessage(id, { type: 'task_progress', current: 'Compose', completed: 0, total: 1, bridgeLocalInteraction: true });
  pushMessage(id, { type: 'running_stats', durationMs: 0, bridgeLocalInteraction: true });
  pushMessage(id, { type: 'status', state: 'busy', bridgeLocalReset: true });
  const messages = getMessages(id, 0);
  assert.deepEqual(messages.filter(event => event.type === 'task_progress').map(event => event.current), ['Native work']);
  assert.deepEqual(messages.filter(event => event.type === 'running_stats').map(event => event.durationMs), [42000]);
});

async function captureReplay(sessionId, options = {}) {
  const route = eventsRouter.stack.find(layer => layer.route?.path === '/events').route.stack[0].handle;
  const req = Object.assign(new EventEmitter(), { query: { sessionId, ...options.query },
    headers: options.headers ?? {}, originalUrl: '/api/events?sessionId=' + sessionId });
  const chunks = [];
  const res = { setHeader() {}, flushHeaders() {}, write(chunk) { chunks.push(chunk); return true; } };
  try { await route(req, res); }
  finally { req.emit('close'); }
  return chunks.flatMap(chunk => chunk.split('\n')).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}

test('SSE full and cursor replay never resurrect a local menu retired by reset', async () => {
  const id = 'local-menu-sse-replay';
  const cursor = pushMessage(id, { type: 'user_prompt', text: 'Real prompt' });
  pushMessage(id, { type: 'user_question', toolUseId: 'retired-sse-menu', questions: [{ question: 'Retired?' }], bridgeLocalInteraction: true });
  pushMessage(id, { type: 'status', state: 'idle', bridgeLocalInteraction: true, bridgeLocalReset: true });
  pushMessage(id, { type: 'user_question', toolUseId: 'current-sse-menu', questions: [{ question: 'Current?' }], bridgeLocalInteraction: true });
  assert.deepEqual((await captureReplay(id, { query: { needReplay: 'true' } })).filter(event => event.type === 'user_question').map(event => event.toolUseId), ['current-sse-menu']);
  pushMessage(id, { type: 'status', state: 'busy', bridgeLocalReset: true });
  pushMessage(id, { type: 'text_delta', text: 'Real progress', bridgePublicUpdate: true });
  for (const options of [{ query: { needReplay: 'true' } }, { headers: { 'last-event-id': String(cursor) } }]) {
    const replay = await captureReplay(id, options);
    assert.equal(replay.some(event => event.bridgeLocalInteraction || event.type === 'user_question'), false);
    assert.equal(replay.some(event => event.text === 'Real progress'), true);
  }
});


test('authoritative action reset retires native questions approvals and waiting status without changing public history', () => {
  const id = 'resolved-native-controls';
  pushMessage(id, { type: 'user_prompt', text: 'Native question context' });
  pushMessage(id, { type: 'user_question', toolUseId: 'resolved-question', questions: [{ question: 'Old question?' }] });
  pushMessage(id, { type: 'permission_request', toolUseId: 'resolved-approval', options: [{ text: 'Allow', key: 'old-key' }] });
  pushMessage(id, { type: 'status', state: 'awaiting' });
  pushMessage(id, { type: 'text_delta', text: 'Public commentary', bridgePublicUpdate: true });
  pushMessage(id, { type: 'user_question', toolUseId: 'local-menu', questions: [{ question: 'Local choice?' }], bridgeLocalInteraction: true });
  pushMessage(id, { type: 'question_answer', answers: {}, bridgeActionReset: true });
  pushMessage(id, { type: 'status', state: 'idle' });
  const replay = getMessages(id, 0);
  assert.deepEqual(replay.filter(event => event.type === 'user_question').map(event => event.toolUseId), ['local-menu']);
  assert.equal(replay.some(event => event.type === 'permission_request' || event.state === 'awaiting'), false);
  assert.equal(replay.some(event => event.text === 'Public commentary'), true);
  assert.equal(replay.some(event => event.text === 'Native question context'), true);
  assert.deepEqual(replay.find(event => event.type === 'question_answer').answers, {});
});

const emitSynthetic = (id, message) => broadcast(id, message, pushMessage(id, message));
function openReplay(sessionId, options = {}) {
  const route = eventsRouter.stack.find(layer => layer.route?.path === '/events').route.stack[0].handle;
  const req = Object.assign(new EventEmitter(), { query: { sessionId, ...options.query },
    headers: options.headers ?? {}, originalUrl: '/api/events?sessionId=' + sessionId });
  const chunks = [];
  const res = { setHeader() {}, flushHeaders() {}, write(chunk) { chunks.push(chunk); return true; } };
  const done = route(req, res);
  return { done, close: () => req.emit('close'),
    frames: () => chunks.flatMap(chunk => chunk.split('\n')).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) };
}

test('SSE waits for authoritative refresh before replay and never briefly displays a resolved cached question', async () => {
  const id = 'refresh-before-question-replay';
  pushMessage(id, { type: 'user_question', toolUseId: 'answered-on-mac', questions: [{ question: 'Resolved?' }] });
  pushMessage(id, { type: 'status', state: 'awaiting' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setSessionWatchHandler(async selected => {
    assert.equal(selected, id);
    await gate;
    emitSynthetic(id, { type: 'question_answer', answers: {}, bridgeActionReset: true });
    emitSynthetic(id, { type: 'status', state: 'text_end' });
    emitSynthetic(id, { type: 'status', state: 'idle' });
  });
  const connection = openReplay(id, { query: { needReplay: 'true' } });
  try {
    assert.deepEqual(connection.frames(), []);
    assert.equal(clientCount(), 1, 'synchronizing clients still count for maintenance guards');
    release(); await connection.done;
    assert.equal(connection.frames().some(event => event.type === 'user_question' || event.state === 'awaiting'), false);
    assert.equal(connection.frames().filter(event => event.bridgeActionReset).length, 1, 'fresh broadcast must not also replay twice');
    assert.equal(connection.frames().at(-1).state, 'idle');
  } finally { release(); connection.close(); setSessionWatchHandler(undefined); }
});

test('fresh current controls reach a client without a replay flag', async () => {
  const id = 'fresh-controls-no-replay';
  pushMessage(id, { type: 'user_question', toolUseId: 'outdated', questions: [{ question: 'Old?' }] });
  setSessionWatchHandler(async () => {
    emitSynthetic(id, { type: 'question_answer', answers: {}, bridgeActionReset: true });
    emitSynthetic(id, { type: 'user_question', toolUseId: 'current', questions: [{ question: 'Current?' }] });
    emitSynthetic(id, { type: 'status', state: 'awaiting' });
  });
  try {
    const frames = await captureReplay(id);
    assert.deepEqual(frames.filter(event => event.type === 'user_question').map(event => event.toolUseId), ['current']);
    assert.equal(frames.at(-1).state, 'awaiting');
  } finally { setSessionWatchHandler(undefined); }
});

test('a stale cursor from another process cannot skip newly synchronized clear controls', async () => {
  const id = 'fresh-controls-stale-cursor';
  pushMessage(id, { type: 'text_delta', text: 'Old transcript' });
  setSessionWatchHandler(async () => {
    emitSynthetic(id, { type: 'question_answer', answers: {}, bridgeActionReset: true });
    emitSynthetic(id, { type: 'status', state: 'think_end' });
    emitSynthetic(id, { type: 'status', state: 'text_end' });
    emitSynthetic(id, { type: 'status', state: 'idle' });
  });
  try {
    const frames = await captureReplay(id, { headers: { 'last-event-id': '3' } });
    assert.equal(frames.filter(event => event.bridgeActionReset).length, 1);
    assert.equal(frames.at(-1).state, 'idle');
  } finally { setSessionWatchHandler(undefined); }
});

test('refresh failure excludes unverified controls and settles only the reconnecting client', async () => {
  const id = 'refresh-failure-stale-controls';
  pushMessage(id, { type: 'user_prompt', text: 'Preserved real prompt' });
  pushMessage(id, { type: 'user_question', toolUseId: 'unverified', questions: [{ question: 'Old?' }] });
  pushMessage(id, { type: 'permission_request', toolUseId: 'unverified-approval' });
  pushMessage(id, { type: 'status', state: 'awaiting' });
  pushMessage(id, { type: 'status', state: 'think_start' });
  pushMessage(id, { type: 'user_question', toolUseId: 'unverified-local-menu', bridgeLocalInteraction: true });
  setSessionWatchHandler(async () => { throw new Error('Synthetic owner unavailable'); });
  try {
    const frames = await captureReplay(id, { query: { needReplay: 'true' } });
    assert.equal(frames.some(event => ['user_question', 'permission_request'].includes(event.type) || event.bridgeLocalInteraction), false);
    assert.equal(frames.some(event => ['awaiting', 'busy', 'think_start', 'text_start'].includes(event.state)), false);
    assert.equal(frames.some(event => event.text === 'Preserved real prompt'), true);
    assert.match(frames.find(event => event.type === 'notification').message, /Unable to refresh/);
    assert.deepEqual(frames.find(event => event.type === 'question_answer').answers, {}, 'unverified client controls close without fabricating a user answer');
    assert.equal(frames.at(-1).state, 'idle');
    assert.equal(getMessages(id, 0).some(event => event.type === 'notification'), false, 'presentation failure must not mutate the native lifecycle buffer');
  } finally { setSessionWatchHandler(undefined); }
});

test('disconnecting during refresh prevents later replay and leaves no connected client', async () => {
  const id = 'disconnect-during-refresh';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setSessionWatchHandler(async () => { await gate; emitSynthetic(id, { type: 'status', state: 'idle' }); });
  const connection = openReplay(id, { query: { needReplay: 'true' } });
  try {
    connection.close(); release(); await connection.done;
    assert.deepEqual(connection.frames(), []);
    assert.equal(clientCount(), 0);
  } finally { release(); setSessionWatchHandler(undefined); }
});
