import test from 'node:test';
import assert from 'node:assert/strict';
import { activityForTurn, publicActivityHeading, publicCommentary, publicToolLabel, turnElapsedMs, formatElapsed, messageTimeLabel } from './activity.mjs';

test('Mac public summary headings match observed bold-string shape and skip comments', () => {
  assert.equal(publicActivityHeading({ type: 'reasoning', summary: ['**Adding answer deduplication state**'] }), 'Adding answer deduplication state');
  assert.equal(publicActivityHeading({ type: 'reasoning', summary: ['Initial public heading', '**Checking reply replay handling**\n<!-- hidden marker -->'] }), 'Checking reply replay handling');
  assert.equal(publicActivityHeading({ type: 'reasoning', summary: ['**Reading [provider.mjs](https://example.test/?token=hidden)**'] }), 'Reading provider.mjs');
  assert.equal(publicActivityHeading({ type: 'reasoning', summary: ['<!-- unfinished hidden marker'] }), null);
});

test('summary helper never accesses raw reasoning content and fails closed on other schemas', () => {
  const item = { type: 'reasoning', summary: ['**Checking the reply**'], get content() { throw new Error('Private reasoning must not be read'); } };
  assert.equal(publicActivityHeading(item), 'Checking the reply');
  assert.equal(publicActivityHeading({ type: 'reasoning', summary: [{ text: 'Unknown schema' }] }), null);
  assert.equal(publicActivityHeading({ type: 'agentMessage', summary: ['Not a native public heading'] }), null);
  assert.equal(publicActivityHeading({ type: 'reasoning', summary: [] }), null);
});

test('commentary excludes final answers and structured questions', () => {
  assert.equal(publicCommentary({ type: 'agentMessage', phase: 'commentary', text: 'I am checking the delivery status.' }), 'I am checking the delivery status.');
  assert.equal(publicCommentary({ type: 'agentMessage', phase: 'final_answer', text: 'Final answer' }), null);
  assert.equal(publicCommentary({ type: 'agentMessage', phase: 'commentary', text: 'Pick one', questions: [{}] }), null);
});

test('message time labels use bracketed minutes and padded seconds without inventing unknown times', () => {
  assert.equal(messageTimeLabel(155999), '[2m35]');
  assert.equal(messageTimeLabel(0), '[0m00]');
  assert.equal(messageTimeLabel(9000), '[0m09]');
  assert.equal(messageTimeLabel(3723000), '[62m03]');
  for (const missing of [null, undefined, -1, NaN, Infinity, '1000']) assert.equal(messageTimeLabel(missing), '');
});

test('latest public heading replaces older commentary while full commentary remains separately available', () => {
  const activity = activityForTurn({ turnId: 'turn', status: 'inProgress', turnStartedAtMs: 1000, items: [
    { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'I will verify the display on the glasses.' },
    { id: 'heading', type: 'reasoning', summary: ['**Checking reply replay handling**'] },
    { id: 'command', type: 'commandExecution', status: 'inProgress', commandActions: [] },
  ] }, { now: 63000 });
  assert.equal(activity.title, 'Checking reply replay handling');
  assert.equal(activity.titleSource, 'summary'); assert.equal(activity.itemId, 'heading');
  assert.equal(activity.commentary, 'I will verify the display on the glasses.');
  assert.equal(activity.commentaryItemId, 'commentary'); assert.equal(activity.elapsedLabel, '1:02');
});

test('public command metadata provides filenames without reading raw commands or output', () => {
  const item = { type: 'commandExecution', commandActions: [
    { type: 'read', path: '/private/project/provider.mjs' }, { type: 'read', path: '/private/project/activity.mjs' },
  ], get command() { throw new Error('Raw command accessed'); }, get aggregatedOutput() { throw new Error('Output accessed'); } };
  assert.equal(publicToolLabel(item), 'Reading provider.mjs + 1 file');
  assert.equal(publicToolLabel({ type: 'commandExecution', commandActions: [{ type: 'search', query: 'secret', path: '/private' }] }), 'Searching files');
  assert.equal(publicToolLabel({ type: 'commandExecution', commandActions: [{ type: 'unknown', command: 'echo secret' }] }), 'Running a command');
});

test('file change labels expose names and operation only, never file contents or full paths', () => {
  const item = { type: 'fileChange', changes: [{ path: '/private/project/activity.mjs', kind: { type: 'add' }, get diff() { throw new Error('Diff accessed'); } }] };
  assert.equal(publicToolLabel(item), 'Creating activity.mjs');
  assert.equal(publicToolLabel({ type: 'fileChange', changes: [{ path: 'C:\\project\\old.js', kind: { type: 'delete' } }] }), 'Removing old.js');
});

test('tool labels use protocol names, never arguments or arbitrary summaries', () => {
  const item = { type: 'dynamicToolCall', tool: 'mcp__codex_app__read_thread', get arguments() { throw new Error('Arguments accessed'); }, get summary() { throw new Error('Unverified summary accessed'); } };
  assert.equal(publicToolLabel(item), 'Reading task updates');
  assert.equal(publicToolLabel({ type: 'mcpToolCall', tool: 'find_documents' }), 'Using find documents');
  assert.equal(publicToolLabel({ type: 'mcpToolCall', tool: 'https://secret.test/?token=private' }), 'Using a connected tool');
});

test('native timestamps survive reconnect and terminal elapsed time freezes', () => {
  const turn = { status: 'inProgress', turnStartedAtMs: '10000', firstTurnWorkItemStartedAtMs: 12000, finalAssistantStartedAtMs: 15000 };
  assert.equal(turnElapsedMs(turn, { now: 42000, fallbackStartedAtMs: 40000 }), 32000);
  assert.equal(turnElapsedMs({ ...turn, status: 'completed', durationMs: 33000 }, { now: 999999 }), 33000);
  assert.equal(turnElapsedMs({ ...turn, status: 'failed', durationMs: 0 }, { now: 999999 }), 0);
  assert.equal(turnElapsedMs({ status: 'completed' }, { now: 999999 }), null);
  assert.equal(turnElapsedMs({ status: 'inProgress' }, { now: 42000 }), null);
  assert.equal(turnElapsedMs({ status: 'inProgress', turnStartedAtMs: 50000 }, { now: 42000 }), 0);
});

test('completed turns have no stale interim title or commentary', () => {
  const result = activityForTurn({ status: 'completed', durationMs: 11210, items: [
    { type: 'reasoning', summary: ['**Earlier activity**'] }, { type: 'agentMessage', phase: 'commentary', text: 'Earlier update' },
  ] });
  assert.equal(result.active, false); assert.equal(result.title, null); assert.equal(result.commentary, null);
  assert.equal(result.elapsedLabel, '0:11');
});

test('clock formatting remains compact across minutes and hours', () => {
  assert.equal(formatElapsed(0), '0:00'); assert.equal(formatElapsed(61001), '1:01');
  assert.equal(formatElapsed(3723000), '1:02:03'); assert.equal(formatElapsed(null), '');
  assert.equal(formatElapsed(-1), ''); assert.equal(formatElapsed(Infinity), '');
});
