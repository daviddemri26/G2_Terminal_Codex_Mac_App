import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMenu, decodeLocalChoice, MAX_LOCAL_DRAFT_LENGTH } from './local-interaction.mjs';

const interrupt = (overrides = {}) => createLocalMenu({ stage: 'interrupt', presentationNumber: 10,
  turnId: 'synthetic-turn-1', ...overrides });
const draft = (overrides = {}) => createLocalMenu({ stage: 'draft', presentationNumber: 11,
  turnId: 'synthetic-turn-1', draftText: 'Please also check the French labels.', ...overrides });
const reply = (menu, label) => ({ answer: JSON.stringify({ [menu.presentation.questions[0].displayed]: label }) });
const hasCode = code => error => error.code === code;

test('interrupt menu presents only the three local response choices', () => {
  const menu = interrupt();
  assert.equal(menu.presentation.event.type, 'user_question');
  assert.equal(menu.presentation.event.toolUseId, menu.id);
  assert.match(menu.presentation.questions[0].displayed, /^Question 10\n/);
  assert.match(menu.presentation.questions[0].displayed, /Codex Mac App is still working/);
  assert.deepEqual(menu.action.choices.map(({ id, label }) => [id, label]), [
    ['add', 'Add prompt'], ['stop', 'Stop response'], ['continue', 'Keep working'],
  ]);
  assert.equal(menu.action.localOnly, true);
  assert.equal(menu.consumed, false);
  assert.equal(Object.hasOwn(menu, 'draftText'), false);
  assert.ok(Object.isFrozen(menu));
  assert.ok(Object.isFrozen(menu.action.choices));
});

test('every offered choice decodes without invoking a desktop action', () => {
  for (const make of [interrupt, draft, () => draft({ mode: 'send' })]) {
    const menu = make();
    for (const choice of menu.action.choices) {
      const result = decodeLocalChoice(menu, reply(menu, choice.label));
      assert.equal(result.choiceId, choice.id);
      assert.equal(result.menu.consumed, true);
      assert.equal(result.menu.turnId, menu.turnId);
      assert.equal(result.menu.action.localOnly, true);
      assert.deepEqual(Object.keys(result).sort(), ['choiceId', 'menu']);
      assert.equal(menu.consumed, false, 'pure decoder must not change the input');
    }
  }
});

test('captured draft is displayed and returned exactly, without trimming or truncation', () => {
  const text = '  Première ligne, intacte.\n\nSecond line with “quotes” and ☕.  ';
  const menu = draft({ draftText: text });
  assert.equal(menu.draftText, text);
  assert.ok(menu.presentation.questions[0].displayed.endsWith(`Draft:\n${text}`));
  assert.match(menu.presentation.questions[0].displayed, /draft has not been sent/);
  assert.deepEqual(menu.action.choices.map(({ id, label }) => [id, label]), [['steer', 'Steer'], ['queue', 'Queue'], ['cancel', 'Cancel']]);
  for (const label of ['Steer', 'Cancel']) assert.equal(decodeLocalChoice(menu, reply(menu, label)).menu.draftText, text);
});

test('menu consumed before awaiting rejects duplicate taps', () => {
  let current = interrupt();
  const input = reply(current, 'Stop response');
  const result = decodeLocalChoice(current, input);
  current = result.menu;
  assert.throws(() => decodeLocalChoice(current, input), hasCode('CLIENT_STALE_ACTION'));
  assert.ok(Object.isFrozen(current));
});

test('fresh menus have new identities and reject stale numbered question replies', () => {
  const old = interrupt();
  const current = interrupt({ presentationNumber: 12 });
  assert.notEqual(current.id, old.id);
  assert.notEqual(current.fingerprint, old.fingerprint);
  assert.notEqual(current.presentation.token, old.presentation.token);
  assert.throws(() => decodeLocalChoice(current, reply(old, 'Stop response')), hasCode('CLIENT_UNCORRELATED_REPLY'));
  assert.throws(() => decodeLocalChoice(current, { ...reply(current, 'Stop response'), requestId: old.id }), hasCode('CLIENT_STALE_ACTION'));
  assert.throws(() => decodeLocalChoice(current, { ...reply(current, 'Stop response'), actionToken: old.presentation.token }), hasCode('CLIENT_STALE_ACTION'));
});

test('old draft cannot authorize a new draft or another turn', () => {
  const old = draft();
  const current = draft({ presentationNumber: 13, turnId: 'synthetic-turn-2', draftText: 'A different message.' });
  assert.throws(() => decodeLocalChoice(current, reply(old, 'Steer')), hasCode('CLIENT_UNCORRELATED_REPLY'));
  assert.equal(current.turnId, 'synthetic-turn-2');
  assert.equal(current.draftText, 'A different message.');
});

test('bare text, bare choices, approvals and unknown choices never authorize local actions', () => {
  for (const menu of [interrupt(), draft(), draft({ mode: 'send' })]) {
    for (const answer of ['Steer', 'Queue', 'Stop response', 'Add prompt', 'allow', 'deny', 'skip', '1']) {
      assert.throws(() => decodeLocalChoice(menu, { answer }), hasCode('CLIENT_UNCORRELATED_REPLY'));
    }
    for (const decision of ['allow', 'deny', 'steer', 'stop']) assert.throws(() => decodeLocalChoice(menu, { decision }));
    assert.throws(() => decodeLocalChoice(menu, reply(menu, 'Unsupported action')), hasCode('CLIENT_INVALID_REPLY'));
    assert.throws(() => decodeLocalChoice(menu, reply(menu, 'Send this different draft')), hasCode('CLIENT_INVALID_REPLY'));
    assert.equal(menu.consumed, false);
  }
});

test('wrong identity is rejected even for an otherwise valid current selection', () => {
  const menu = draft();
  for (const metadata of [{ requestId: 'other-menu' }, { actionToken: 'old-token' }]) {
    assert.throws(() => decodeLocalChoice(menu, { ...reply(menu, 'Steer'), ...metadata }), hasCode('CLIENT_STALE_ACTION'));
  }
  assert.throws(() => decodeLocalChoice({ ...menu, fingerprint: 'changed' }, reply(menu, 'Steer')), hasCode('CLIENT_STALE_ACTION'));
  assert.throws(() => decodeLocalChoice({ ...menu, action: { ...menu.action, fingerprint: 'changed' } }, reply(menu, 'Steer')), hasCode('CLIENT_STALE_ACTION'));
});

test('matching explicit correlation remains compatible with richer clients', () => {
  const menu = draft();
  assert.equal(decodeLocalChoice(menu, { answer: 'Steer', actionToken: menu.presentation.token }).choiceId, 'steer');
  assert.equal(decodeLocalChoice(menu, { answer: `[${menu.presentation.token}] Cancel` }).choiceId, 'cancel');
});

test('empty and overlong drafts are rejected instead of changed or partly displayed', () => {
  for (const text of ['', ' \n\t', null, 42, undefined]) assert.throws(() => draft({ draftText: text }));
  const limit = 'a'.repeat(MAX_LOCAL_DRAFT_LENGTH);
  const menu = draft({ draftText: limit });
  assert.equal(menu.draftText, limit);
  assert.ok(menu.presentation.questions[0].displayed.endsWith(limit));
  assert.throws(() => draft({ draftText: `${limit}b` }), hasCode('CLIENT_INVALID_REPLY'));
});

test('stage, saved question number and active turn identity are mandatory', () => {
  for (const stage of ['queue', '', undefined]) assert.throws(() => interrupt({ stage }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  for (const presentationNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.throws(() => interrupt({ presentationNumber }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  }
  for (const turnId of ['', ' ', undefined, 5]) assert.throws(() => interrupt({ turnId }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  assert.throws(() => interrupt({ draftText: 'unexpected' }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  assert.throws(() => decodeLocalChoice(null, {}), hasCode('CLIENT_STALE_ACTION'));
});


test('completed response preview offers explicit Send prompt instead of Steer', () => {
  const menu = draft({ mode: 'send' });
  assert.equal(menu.mode, 'send');
  assert.equal(draft().mode, 'steer');
  assert.deepEqual(menu.action.choices.map(({ id, label }) => [id, label]), [['send', 'Send prompt'], ['queue', 'Queue'], ['cancel', 'Cancel']]);
  assert.match(menu.presentation.questions[0].displayed, /previous response has finished/);
  assert.match(menu.presentation.questions[0].displayed, /draft has not been sent/);
  assert.doesNotMatch(menu.presentation.questions[0].displayed, /still working/);
  assert.equal(decodeLocalChoice(menu, reply(menu, 'Send prompt')).choiceId, 'send');
  assert.throws(() => decodeLocalChoice(menu, reply(menu, 'Steer')), hasCode('CLIENT_INVALID_REPLY'));
  assert.throws(() => decodeLocalChoice(menu, { answer: 'Send prompt' }), hasCode('CLIENT_UNCORRELATED_REPLY'));
});

test('input mode validation rejects unsupported states and replaced preview replies', () => {
  for (const mode of ['', 'queue', null, 3]) assert.throws(() => draft({ mode }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  assert.throws(() => interrupt({ mode: 'send' }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  const old = draft();
  const current = draft({ mode: 'send', presentationNumber: 20 });
  assert.throws(() => decodeLocalChoice(current, reply(old, 'Steer')), hasCode('CLIENT_UNCORRELATED_REPLY'));
  assert.throws(() => decodeLocalChoice({ ...current, mode: 'queue' }, reply(current, 'Send prompt')), hasCode('CLIENT_STALE_ACTION'));
});


const queue = (overrides = {}) => createLocalMenu({ stage: 'queue-list', presentationNumber: 30,
  turnId: 'synthetic-turn-1', queueEntries: [
    { id: 'first', text: 'First queued prompt', phase: 'queued' },
    { id: 'second', text: 'Second queued prompt', phase: 'queued' },
  ], ...overrides });
const labels = menu => menu.action.choices.map(choice => choice.label);

test('Queue is a correlated local choice for both busy and idle drafts', () => {
  for (const mode of ['steer', 'send']) {
    const menu = draft({ mode });
    assert.equal(decodeLocalChoice(menu, reply(menu, 'Queue')).choiceId, 'queue');
    assert.equal(menu.action.localOnly, true);
    assert.throws(() => decodeLocalChoice(menu, { answer: 'Queue' }), hasCode('CLIENT_UNCORRELATED_REPLY'));
  }
});

test('interrupt menu offers View queue only when there are entries', () => {
  const menu = interrupt({ queueEntries: queue().queueEntries });
  assert.equal(labels(interrupt()).includes('View queue'), false);
  assert.equal(labels(menu).includes('View queue'), true);
  assert.equal(decodeLocalChoice(menu, reply(menu, 'View queue')).choiceId, 'view-queue');
});

test('queue list preserves order with bounded previews and stable item IDs', () => {
  const text = '☕ Long prompt with newlines.\n'.repeat(30);
  const menu = queue({ queueEntries: [{ id: 'long', text, phase: 'queued' },
    { id: 'short', text: 'Second exact entry', phase: 'queued' }] });
  assert.equal(menu.action.title, 'Queued prompts (2)');
  assert.deepEqual(menu.queueIds, ['long', 'short']);
  assert.deepEqual(menu.action.choices.slice(0, 2).map(choice => choice.id), ['item:long', 'item:short']);
  assert.ok(menu.action.choices.slice(0, 2).every(choice => choice.label.length <= 60));
  assert.ok(menu.action.description.split('\n\n').every(part => part.split('\n')[1].length <= 120));
  assert.ok(menu.action.description.indexOf('#1') < menu.action.description.indexOf('#2'));
  assert.deepEqual(labels(menu).slice(2), ['Pause queue', 'Clear queue', 'Back']);
  for (const choice of menu.action.choices) assert.equal(decodeLocalChoice(menu, reply(menu, choice.label)).choiceId, choice.id);
});

test('pause resume clear controls reflect the whole current queue and uncertain sends', () => {
  const queued = [{ id: 'a', text: 'A', phase: 'queued' }];
  assert.deepEqual(labels(queue({ queueEntries: [], queuePaused: true })), ['Back']);
  assert.deepEqual(labels(queue({ queueEntries: queued, queuePaused: true })).slice(1), ['Resume queue', 'Clear queue', 'Back']);
  assert.deepEqual(labels(queue({ queueEntries: [{ ...queued[0], phase: 'paused' }] })).slice(1), ['Resume queue', 'Clear queue', 'Back']);
  for (const phase of ['sending', 'unknown']) {
    const menu = queue({ queueEntries: [...queued, { id: 'b', text: 'B', phase }], queuePaused: true });
    assert.deepEqual(labels(menu).slice(2), ['Back']);
    for (const label of ['Resume queue', 'Clear queue', 'Pause queue']) assert.throws(() => decodeLocalChoice(menu, reply(menu, label)));
  }
});

test('queue item shows exact body and only waiting entries can be removed', () => {
  const text = '  Preserve exact body, comma.\n\nCafé ☕.  ';
  for (const phase of ['queued', 'paused', 'sending', 'unknown']) {
    const menu = queue({ stage: 'queue-item', selectedId: 'one', queueEntries: [{ id: 'one', text, phase }] });
    assert.equal(menu.selectedId, 'one');
    assert.ok(menu.action.description.endsWith(`Prompt:\n${text}`));
    assert.deepEqual(labels(menu), ['queued', 'paused'].includes(phase) ? ['Remove', 'Back'] : ['Back']);
    for (const choice of menu.action.choices) assert.equal(decodeLocalChoice(menu, reply(menu, choice.label)).choiceId, choice.id);
  }
});

test('queue snapshots are cloned and frozen without freezing caller-owned entries', () => {
  const source = [{ id: 'one', text: 'Original', phase: 'queued', privateUnusedField: 'omitted' }];
  const menu = queue({ queueEntries: source });
  source[0].text = 'Changed'; source.push({ id: 'two', text: 'Later', phase: 'queued' });
  assert.equal(menu.queueEntries[0].text, 'Original');
  assert.deepEqual(menu.queueIds, ['one']);
  assert.equal(Object.hasOwn(menu.queueEntries[0], 'privateUnusedField'), false);
  assert.ok(Object.isFrozen(menu.queueEntries[0]));
  assert.equal(Object.isFrozen(source[0]), false);
});

test('stale queue snapshots and modified IDs phases selection or choices cannot authorize actions', () => {
  const old = queue();
  const current = queue({ presentationNumber: 31, queueEntries: [...old.queueEntries].reverse() });
  assert.throws(() => decodeLocalChoice(current, reply(old, 'Clear queue')), hasCode('CLIENT_UNCORRELATED_REPLY'));
  const modified = [
    { ...old, queueIds: ['second', 'first'] },
    { ...old, queueEntries: [{ ...old.queueEntries[0], phase: 'sending' }, old.queueEntries[1]] },
    { ...old, selectedId: 'first' },
    { ...old, queuePaused: true },
    { ...old, action: { ...old.action, choices: [...old.action.choices, { id: 'unsafe', label: 'Unsafe' }] } },
  ];
  for (const menu of modified) assert.throws(() => decodeLocalChoice(menu, reply(old, 'Clear queue')), hasCode('CLIENT_STALE_ACTION'));
  const consumed = decodeLocalChoice(old, reply(old, 'Clear queue')).menu;
  assert.throws(() => decodeLocalChoice(consumed, reply(old, 'Clear queue')), hasCode('CLIENT_STALE_ACTION'));
});

test('invalid queue entries and selection are rejected before any presentation', () => {
  for (const queueEntries of [null, {}, Array.from({ length: 11 }, (_, i) => ({ id: `id${i}`, text: 'x', phase: 'queued' })),
    [{ id: 'a', text: 'x', phase: 'invalid' }], [{ id: 'a', text: '', phase: 'queued' }],
    [{ id: 'a', text: 'x', phase: 'queued' }, { id: 'a', text: 'y', phase: 'queued' }]]) {
    assert.throws(() => queue({ queueEntries }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  }
  assert.throws(() => queue({ queuePaused: 'yes' }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  assert.throws(() => queue({ stage: 'queue-item' }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  assert.throws(() => queue({ stage: 'queue-item', selectedId: 'missing' }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  assert.throws(() => queue({ selectedId: 'first' }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  assert.throws(() => queue({ mode: 'queue' }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
  assert.throws(() => queue({ draftText: 'unexpected' }), hasCode('CLIENT_UNSUPPORTED_ACTION'));
});
