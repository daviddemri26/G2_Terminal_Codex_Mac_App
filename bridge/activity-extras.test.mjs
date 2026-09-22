import test from 'node:test';
import assert from 'node:assert/strict';
import { activityEntriesForTurn } from './activity-extras.mjs';

const turn = (items, status = 'inProgress') => ({ turnId: 'synthetic-turn', status, items });
const message = id => ({ id, type: 'agentMessage', phase: 'commentary', text: 'Public commentary handled elsewhere.' });
const command = (id, commandActions = [], status = 'completed') => ({ id, type: 'commandExecution', commandActions, status });
const subagent = (id, kind) => ({ id, type: 'subAgentActivity', kind, agentThreadId: 'synthetic-child', agentPath: '/root/app_icon' });
const text = entries => entries.map(entry => entry.text);

function forbidden(object, fields) {
  for (const field of fields) Object.defineProperty(object, field, { get() { throw new Error(`Private field read: ${field}`); } });
  return object;
}

test('explicit subagent lifecycle events use public path names and stable identities', () => {
  const state = turn(['started', 'interacted', 'interrupted', 'completed'].map((kind, i) => subagent(`event-${i}`, kind)));
  const entries = activityEntriesForTurn(state);
  assert.deepEqual(text(entries), ['App icon started working', 'App icon updated', 'App icon interrupted', 'App icon finished']);
  assert.ok(entries.every(entry => entry.kind === 'subagent'));
  assert.deepEqual(entries.map(entry => entry.itemId), ['event-0', 'event-1', 'event-2', 'event-3']);
  assert.equal(new Set(entries.map(entry => entry.key)).size, 4);
  assert.deepEqual(activityEntriesForTurn(structuredClone(state)), entries);
  assert.notEqual(activityEntriesForTurn({ ...state, turnId: 'another-turn' })[0].key, entries[0].key);
});

test('malformed and unknown input fails closed without inventing names or statuses', () => {
  for (const state of [null, undefined, [], {}, { items: {} }, { items: 'private' }]) assert.deepEqual(activityEntriesForTurn(state), []);
  const items = [null, false, [], 'private', { type: 'futureType', id: 'future', text: 'HIDDEN' },
    subagent('bad-status', 'failed'), subagent('inherited-status', 'toString'),
    { ...subagent('bad-path', 'started'), agentPath: {} },
    { ...subagent('empty-path', 'started'), agentPath: '/root/' },
    { ...subagent('controls', 'started'), agentPath: '/root/bad\u0000name' },
    { ...subagent('missing-child', 'started'), agentThreadId: null },
    { ...subagent('missing-id', 'started'), id: null },
    { type: 'reasoning', id: 'bad-summary', summary: [{ text: 'HIDDEN' }] },
  ];
  assert.deepEqual(activityEntriesForTurn(turn(items, 'completed')), []);
});

test('summary headings use only the existing public-heading helper and retain keys as text grows', () => {
  const item = forbidden({ id: 'heading', type: 'reasoning', summary: ['**Checking the files**'] }, ['content', 'arguments', 'output']);
  const [entry] = activityEntriesForTurn(turn([item]));
  assert.equal(entry.text, 'Checking the files'); assert.equal(entry.kind, 'heading');
  const [updated] = activityEntriesForTurn(turn([{ ...item, summary: ['**Checking the files and tests**'] }]));
  assert.equal(entry.key, updated.key); assert.equal(updated.text, 'Checking the files and tests');
  assert.deepEqual(activityEntriesForTurn(turn([{ id: 'empty', type: 'reasoning', summary: [] }])), []);
});

test('completed tools collapse into ordered action categories before the next public boundary', () => {
  const entries = activityEntriesForTurn(turn([
    command('read-1', [{ type: 'read' }]), command('read-2', [{ type: 'read' }]),
    command('run'), message('commentary'),
    { id: 'patch', type: 'fileChange', status: 'completed', changes: [{ kind: { type: 'update' } }] },
    command('read-3', [{ type: 'read' }]), { id: 'heading', type: 'reasoning', summary: ['**Checking changes**'] },
    command('list', [{ type: 'listFiles' }, { type: 'search' }, { type: 'read' }]),
    { id: 'web', type: 'webSearch', status: 'completed' }, subagent('agent', 'started'),
  ]));
  assert.deepEqual(text(entries), ['Read files, ran commands', 'Edited files, read files', 'Checking changes',
    'Listed files, searched files, read files, searched the web', 'App icon started working']);
  assert.deepEqual(entries.map(entry => entry.itemId), ['run', 'read-3', 'heading', 'web', 'agent']);
  assert.deepEqual(entries.map(entry => entry.kind), ['actions', 'actions', 'heading', 'actions', 'subagent']);
});

test('live trailing tool groups wait for a boundary or terminal turn instead of reporting every tool', () => {
  const items = [command('read', [{ type: 'read' }])];
  assert.deepEqual(activityEntriesForTurn(turn(items)), []);
  assert.deepEqual(activityEntriesForTurn(turn([...items, command('run')])), []);
  const closed = activityEntriesForTurn(turn([...items, command('run'), message('boundary')]));
  assert.deepEqual(text(closed), ['Read files, ran commands']);
  for (const status of ['completed', 'failed', 'interrupted']) {
    assert.deepEqual(activityEntriesForTurn(turn([...items, command('run')], status)), closed);
  }
  assert.deepEqual(activityEntriesForTurn(turn(items, 'futureStatus')), []);
});

test('unfinished, failed, unknown, and empty file tools do not become successful action summaries', () => {
  const items = [command('running', [], 'inProgress'), command('failed', [], 'failed'),
    { id: 'unknown', type: 'futureTool', status: 'completed' },
    { id: 'mcp', type: 'mcpToolCall', status: 'completed' },
    { id: 'dynamic', type: 'dynamicToolCall', status: 'completed' },
    { id: 'empty-patch', type: 'fileChange', status: 'completed', changes: [] },
    { id: 'bad-patch', type: 'fileChange', status: 'completed', changes: [null, { kind: 'future' }] },
  ];
  assert.deepEqual(activityEntriesForTurn(turn(items, 'completed')), []);
  assert.deepEqual(text(activityEntriesForTurn(turn([command('malformed-annotations', [null, {}, []])], 'completed'))), ['Ran commands']);
});

test('keys and summaries remain deterministic across repeated snapshots and duplicate entries', () => {
  const agent = subagent('agent', 'started');
  const items = [agent, agent, command('read', [{ type: 'read' }]), message('boundary')];
  const state = turn(items);
  const before = structuredClone(state), first = activityEntriesForTurn(state);
  assert.deepEqual(activityEntriesForTurn(state), first);
  assert.deepEqual(state, before);
  assert.deepEqual(text(first), ['App icon started working', 'Read files']);
  const more = activityEntriesForTurn(turn([...items, command('next'), message('next-boundary')]));
  assert.deepEqual(more.slice(0, first.length), first);
  assert.equal(new Set(more.map(entry => entry.key)).size, more.length);
});

test('no raw private fields, file names, prompts, child messages, or tool arguments are accessed', () => {
  const action = forbidden({ type: 'read' }, ['path', 'name', 'command', 'query']);
  const read = forbidden(command('read', [action]), ['command', 'aggregatedOutput', 'arguments', 'output']);
  const change = forbidden({ kind: { type: 'update' } }, ['path', 'diff']);
  const patch = forbidden({ id: 'patch', type: 'fileChange', status: 'completed', changes: [change] }, ['arguments', 'output']);
  const heading = forbidden({ id: 'heading', type: 'reasoning', summary: ['**Public heading**'] }, ['content', 'text']);
  const agent = forbidden(subagent('agent', 'completed'), ['prompt', 'message', 'thread', 'output']);
  const unknown = forbidden({ id: 'unknown', type: 'dynamicToolCall', status: 'completed' }, ['tool', 'arguments', 'output', 'summary']);
  const commentary = forbidden({ id: 'commentary', type: 'agentMessage' }, ['text', 'questions']);
  const entries = activityEntriesForTurn(turn([read, patch, unknown, commentary, heading, agent]));
  assert.deepEqual(text(entries), ['Read files, edited files', 'Public heading', 'App icon finished']);
});


test('a closed group waits for concurrent unfinished tools before its stable summary is exposed', () => {
  const items = [command('read', [{ type: 'read' }]), command('run', [], 'inProgress'), message('boundary')];
  assert.deepEqual(activityEntriesForTurn(turn(items)), []);
  const settled = activityEntriesForTurn(turn([items[0], { ...items[1], status: 'completed' }, items[2]]));
  assert.deepEqual(text(settled), ['Read files, ran commands']);
  assert.deepEqual(activityEntriesForTurn(turn([items[0], { ...items[1], status: 'completed' }, items[2]])), settled);
  assert.deepEqual(text(activityEntriesForTurn(turn(items, 'interrupted'))), ['Read files']);
  assert.deepEqual(text(activityEntriesForTurn(turn([items[0], { ...items[1], status: 'failed' }, items[2]]))), ['Read files']);
});
