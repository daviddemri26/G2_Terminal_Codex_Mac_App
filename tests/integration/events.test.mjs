import test from 'node:test';
import assert from 'node:assert/strict';
import { pushMessage, getMessages } from '../../.build/runtime/dist/routes/events.js';

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
