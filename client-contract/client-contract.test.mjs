import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActionPresentation, decodeActionReply, progressMessage, clearProgressMessage } from '../bridge/client-contract.mjs';

const question = (overrides = {}) => ({ id: 'req-1', kind: 'question', fingerprint: 'fp-1', supported: true,
  questions: [{ id: 'q1', question: 'Where should it go?', header: 'Location', options: [] }], ...overrides });
const approval = (overrides = {}) => ({ id: 42, kind: 'command-approval', fingerprint: 'fp-2', supported: true,
  title: 'Allow this command?', description: 'Run the validation command.', details: { command: 'test', cwd: '/project' },
  choices: [{ id: 'accept', label: 'Allow once' }, { id: 'acceptForSession', label: 'Allow for this session' }, { id: 'decline', label: 'Deny' }], ...overrides });
const encoded = (presentation, values) => JSON.stringify(Object.fromEntries(presentation.questions.map((question, index) => [question.displayed, values[index]])));
const code = expected => error => error.code === expected;

test('stock JSON keyed by displayed question correlates and preserves text and commas', () => {
  const action = question(); const presentation = buildActionPresentation(action);
  const answer = 'Paris, France — je préfère ici';
  assert.deepEqual(decodeActionReply(action, presentation, { answer: encoded(presentation, [answer]) }), {
    kind: 'question', expectedFingerprint: 'fp-1', answers: { q1: { answers: [answer] } },
  });
  assert.equal(presentation.event.type, 'user_question');
  assert.equal(presentation.event.toolUseId, 'req-1');
  assert.equal(presentation.event.questions[0].header, 'Location');
});

test('uncorrelated text, skip and original-question JSON are refused', () => {
  const action = question(); const presentation = buildActionPresentation(action);
  for (const answer of ['Paris', 'skip', JSON.stringify({ 'Where should it go?': 'Paris' }), '{}']) {
    assert.throws(() => decodeActionReply(action, presentation, { answer }), code('CLIENT_UNCORRELATED_REPLY'));
  }
});

test('explicit action token permits voice free text, including commas', () => {
  const action = question(); const presentation = buildActionPresentation(action);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: 'one, two', actionToken: presentation.token }).answers.q1.answers, ['one, two']);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: `[${presentation.token}] one, two` }).answers.q1.answers, ['one, two']);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: 'skip', actionToken: presentation.token }).answers, {});
});

test('fresh presentation does not accept a prior presentation answer', () => {
  const action = question(); const old = buildActionPresentation(action); const fresh = buildActionPresentation(action);
  assert.notEqual(old.token, fresh.token);
  assert.throws(() => decodeActionReply(action, fresh, { answer: encoded(old, ['old reply']) }), code('CLIENT_UNCORRELATED_REPLY'));
});

test('id, kind and fingerprint changes refuse the saved presentation', () => {
  const action = question(); const presentation = buildActionPresentation(action);
  for (const changed of [{ ...action, id: 'req-2' }, { ...action, kind: 'async-question' }, { ...action, fingerprint: 'new' }]) {
    assert.throws(() => decodeActionReply(changed, presentation, { answer: encoded(presentation, ['x']) }), code('CLIENT_STALE_ACTION'));
  }
});

test('explicit mismatched IDs/tokens fail even when answer text matches', () => {
  const action = question(); const presentation = buildActionPresentation(action);
  for (const input of [{ requestId: 1 }, { requestId: 'other' }, { actionToken: 'old' }]) {
    assert.throws(() => decodeActionReply(action, presentation, { answer: encoded(presentation, ['x']), ...input }), code('CLIENT_STALE_ACTION'));
  }
});

test('question ID matching is allowed only after explicit correlation', () => {
  const action = question(); const presentation = buildActionPresentation(action);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: JSON.stringify({ q1: { answers: ['here'] } }), actionToken: presentation.token }).answers.q1.answers, ['here']);
  assert.throws(() => decodeActionReply(action, presentation, { answer: JSON.stringify({ q1: 'here' }) }), code('CLIENT_UNCORRELATED_REPLY'));
});

test('multiquestion form requires complete keyed answers and never broadcasts prose', () => {
  const action = question({ questions: [{ id: 'a', question: 'First?' }, { id: 'b', question: 'Second?' }] });
  const presentation = buildActionPresentation(action);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: encoded(presentation, ['one', 'two']) }).answers,
    { a: { answers: ['one'] }, b: { answers: ['two'] } });
  assert.throws(() => decodeActionReply(action, presentation, { answer: 'one, two', actionToken: presentation.token }), code('CLIENT_INVALID_REPLY'));
  assert.throws(() => decodeActionReply(action, presentation, { answer: JSON.stringify({ [presentation.questions[0].displayed]: 'one' }) }), code('CLIENT_INVALID_REPLY'));
});

test('duplicate question labels are distinct when keyed by tokenized question index', () => {
  const action = question({ questions: [{ id: 'a', question: 'Same?', header: 'Same' }, { id: 'b', question: 'Same?', header: 'Same' }] });
  const presentation = buildActionPresentation(action);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: encoded(presentation, ['one', 'two']) }).answers,
    { a: { answers: ['one'] }, b: { answers: ['two'] } });
  assert.throws(() => decodeActionReply(action, presentation, { answer: JSON.stringify({ Same: 'one' }), actionToken: presentation.token }), code('CLIENT_UNCORRELATED_REPLY'));
});

test('multiselect arrays are preserved; single-select arrays and duplicate choices fail', () => {
  const action = question({ questions: [{ id: 'q1', question: 'Choose?', multiSelect: true, options: [{ label: 'A, B' }, { label: 'C' }] }] });
  const presentation = buildActionPresentation(action);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: encoded(presentation, [['A, B', 'C']]) }).answers.q1.answers, ['A, B', 'C']);
  assert.throws(() => decodeActionReply(action, presentation, { answer: encoded(presentation, [['C', 'C']]) }), code('CLIENT_INVALID_REPLY'));
  const single = question(); const singlePresentation = buildActionPresentation(single);
  assert.throws(() => decodeActionReply(single, singlePresentation, { answer: encoded(singlePresentation, [['a', 'b']]) }), code('CLIENT_INVALID_REPLY'));
});

test('malformed JSON, nonstrings, duplicate alias answers and prototype keys fail', () => {
  const action = question(); const presentation = buildActionPresentation(action);
  const invalid = ['{broken', JSON.stringify({ [presentation.questions[0].displayed]: 1 }),
    JSON.stringify({ [presentation.questions[0].displayed]: 'x', q1: 'y' }), '{"__proto__":"x"}'];
  for (const answer of invalid) assert.throws(() => decodeActionReply(action, presentation, { answer, actionToken: presentation.token }));
});

test('permission options echo a per-presentation token and preserve distinct variants', () => {
  const action = approval(); const presentation = buildActionPresentation(action);
  assert.equal(presentation.event.type, 'permission_request');
  assert.match(presentation.event.detail, /"cwd": "\/project"/);
  for (let i = 0; i < presentation.event.options.length; i++) {
    assert.deepEqual(decodeActionReply(action, presentation, { decision: presentation.event.options[i].key }),
      { kind: action.kind, expectedFingerprint: action.fingerprint, choiceId: action.choices[i].id });
  }
});

test('legacy approval words and old correlated choices never select a new action', () => {
  const action = approval(); const old = buildActionPresentation(action); const fresh = buildActionPresentation(action);
  for (const decision of ['allow', 'allowAlways', 'deny', 'accept', old.event.options[0].key]) {
    assert.throws(() => decodeActionReply(action, fresh, { decision }), code('CLIENT_UNCORRELATED_REPLY'));
  }
  assert.equal(decodeActionReply(action, fresh, { decision: 'accept', actionToken: fresh.token }).choiceId, 'accept');
});

test('unsupported, secret, empty and duplicate IDs are not advertised as supported', () => {
  const invalid = [question({ supported: false }), question({ questions: [] }),
    question({ questions: [{ id: 'x', question: 'Password?', isSecret: true }] }),
    question({ questions: [{ id: 'x', question: 'One?' }, { id: 'x', question: 'Two?' }] }),
    question({ questions: [{ id: '__proto__', question: 'Value?' }] }),
    approval({ choices: [{ id: 'accept', label: 'Yes' }, { id: 'accept', label: 'Also yes' }] }),
    approval({ choices: [{ id: 'once', label: 'Allow' }, { id: 'permanent', label: 'Allow' }] })];
  for (const action of invalid) assert.throws(() => buildActionPresentation(action), code('CLIENT_UNSUPPORTED_ACTION'));
});

test('option and plan choices are explicit and cannot be approved by arbitrary prose', () => {
  for (const kind of ['option-picker', 'plan-implementation']) {
    const action = question({ kind, title: 'Implement this plan?', choices: [{ id: 'implement', label: 'Yes, implement this plan' }, { id: 'cancel', label: 'Cancel' }] });
    const presentation = buildActionPresentation(action);
    assert.equal(decodeActionReply(action, presentation, { answer: encoded(presentation, ['Yes, implement this plan']) }).choiceId, 'implement');
    assert.throws(() => decodeActionReply(action, presentation, { answer: encoded(presentation, ['yes']) }), code('CLIENT_INVALID_REPLY'));
  }
});

test('flat typed form submits exact typed content only after explicit submit choice', () => {
  const action = question({ kind: 'elicitation', title: 'Details', schema: { type: 'object', properties: {
    name: { type: 'string' }, count: { type: 'integer' }, enabled: { type: 'boolean' }, note: { type: 'string' },
  }, required: ['name', 'count', 'enabled'] }, choices: [{ id: 'accept', label: 'Submit' }, { id: 'decline', label: 'Decline' }] });
  const presentation = buildActionPresentation(action);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: encoded(presentation, ['Submit', 'David', '2', 'true', '']) }),
    { kind: 'elicitation', expectedFingerprint: 'fp-1', choiceId: 'accept', content: { name: 'David', count: 2, enabled: true } });
  assert.throws(() => decodeActionReply(action, presentation, { answer: encoded(presentation, ['Submit', 'David', '2.5', 'true', '']) }), code('CLIENT_INVALID_REPLY'));
  assert.deepEqual(decodeActionReply(action, presentation, { answer: JSON.stringify({ [presentation.questions[0].displayed]: 'Decline' }) }).content, null);
});

test('nested or sensitive elicitation forms only offer decline/cancel', () => {
  for (const schema of [{ type: 'object', properties: { nested: { type: 'object', properties: {} } } },
    { type: 'object', properties: { password: { type: 'string', format: 'password' } } }]) {
    const action = question({ kind: 'elicitation', schema, choices: [{ id: 'accept', label: 'Submit' }, { id: 'cancel', label: 'Cancel' }] });
    const presentation = buildActionPresentation(action);
    assert.deepEqual(presentation.choices.map(choice => choice.id), ['cancel']);
    assert.equal(presentation.questions.length, 1);
  }
});

test('progress is temporary single-slot state and clears without transcript text', () => {
  assert.deepEqual(progressMessage('Checking the connection…'), { type: 'task_progress', completed: 0, total: 1, current: 'Checking the connection…' });
  assert.deepEqual(clearProgressMessage(), { type: 'task_progress', completed: 1, total: 1, current: '' });
});

test('approval detail includes the exact rule or permission amendment for review', () => {
  const action = approval({ choices: [{ id: 'save-rule', label: 'Save command rule', value: { acceptWithExecpolicyAmendment: { proposed_execpolicy_amendment: ['git', 'status'] } } }] });
  const presentation = buildActionPresentation(action);
  assert.match(presentation.event.detail, /proposed_execpolicy_amendment/);
  assert.match(presentation.event.detail, /"status"/);
});

test('plan and elicitation approval preserve the exact content being approved', () => {
  const plan = question({ kind: 'plan-implementation', title: 'Implement this plan?', plan: '1. Change this exact setting.\n2. Verify the result.',
    choices: [{ id: 'implement', label: 'Implement this plan' }] });
  assert.ok(buildActionPresentation(plan).event.questions[0].question.includes(plan.plan));
  const form = question({ kind: 'elicitation', title: 'Request from a connected tool', description: 'Send the chosen fields to the selected service.',
    details: { serverName: 'Example service', toolName: 'submit_fields' }, schema: { type: 'object', properties: {} },
    choices: [{ id: 'accept', label: 'Submit' }, { id: 'cancel', label: 'Cancel' }] });
  const shown = buildActionPresentation(form).event.questions[0].question;
  assert.ok(shown.includes(form.description));
  assert.ok(shown.includes('submit_fields'));
});

test('a reused native request ID alone cannot authorize a newer approval or question', () => {
  const old = approval({ id: 7, fingerprint: 'old-content' });
  const oldPresentation = buildActionPresentation(old);
  const current = approval({ id: 7, fingerprint: 'new-content', description: 'Different operation.' });
  const currentPresentation = buildActionPresentation(current);
  assert.throws(() => decodeActionReply(current, currentPresentation, { requestId: 7, decision: 'accept' }), code('CLIENT_UNCORRELATED_REPLY'));
  assert.throws(() => decodeActionReply(current, currentPresentation, { requestId: 7, decision: oldPresentation.event.options[0].key }), code('CLIENT_UNCORRELATED_REPLY'));
  assert.throws(() => decodeActionReply(current, currentPresentation, { requestId: 7, actionToken: oldPresentation.token, decision: 'accept' }), code('CLIENT_STALE_ACTION'));
  assert.equal(decodeActionReply(current, currentPresentation, { requestId: 7, actionToken: currentPresentation.token, decision: 'accept' }).choiceId, 'accept');
  const currentQuestion = question({ id: 7 }); const presentation = buildActionPresentation(currentQuestion);
  for (const answer of ['yes', 'skip', JSON.stringify({ q1: 'yes' })]) {
    assert.throws(() => decodeActionReply(currentQuestion, presentation, { requestId: 7, answer }), code('CLIENT_UNCORRELATED_REPLY'));
  }
});

test('a saved presentation number replaces the visible random suffix without changing the answer', () => {
  const action = question();
  const presentation = buildActionPresentation(action, { presentationNumber: 12 });
  assert.equal(presentation.event.questions[0].question, 'Question 12\nWhere should it go?');
  assert.equal(presentation.presentationNumber, 12);
  assert.equal(presentation.event.questions[0].question.includes(presentation.token), false);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: encoded(presentation, ['Paris, France']) }).answers,
    { q1: { answers: ['Paris, France'] } });
  assert.throws(() => decodeActionReply(action, presentation, { answer: JSON.stringify({ 'Where should it go?': 'Paris' }) }), code('CLIENT_UNCORRELATED_REPLY'));
});

test('numbered multiquestion forms distinguish identical natural question text', () => {
  const action = question({ questions: [{ id: 'a', question: 'Same?' }, { id: 'b', question: 'Same?' }] });
  const presentation = buildActionPresentation(action, { presentationNumber: 34 });
  assert.deepEqual(presentation.event.questions.map(row => row.question), ['Question 34.1\nSame?', 'Question 34.2\nSame?']);
  assert.deepEqual(decodeActionReply(action, presentation, { answer: encoded(presentation, ['one', 'two']) }).answers,
    { a: { answers: ['one'] }, b: { answers: ['two'] } });
});

test('a stale numbered reply cannot answer a reused natural question or reused native ID', () => {
  const old = question({ id: 7, fingerprint: 'old' });
  const current = question({ id: 7, fingerprint: 'new' });
  const previous = buildActionPresentation(old, { presentationNumber: 40 });
  const shown = buildActionPresentation(current, { presentationNumber: 41 });
  assert.throws(() => decodeActionReply(current, shown, { requestId: 7, answer: encoded(previous, ['stale']) }), code('CLIENT_UNCORRELATED_REPLY'));
  assert.deepEqual(decodeActionReply(current, shown, { answer: encoded(shown, ['current']) }).answers.q1.answers, ['current']);
});

test('invalid presentation numbers fail closed while permission choices keep hidden token correlation', () => {
  for (const presentationNumber of [0, -1, 1.5, '12', null, true, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildActionPresentation(question(), { presentationNumber }), code('CLIENT_UNSUPPORTED_ACTION'));
  }
  const action = approval();
  const presentation = buildActionPresentation(action, { presentationNumber: 55 });
  assert.deepEqual(presentation.event.options.map(option => option.text), action.choices.map(choice => choice.label));
  assert.ok(presentation.event.options[0].key.includes(presentation.token));
  assert.equal(decodeActionReply(action, presentation, { decision: presentation.event.options[0].key }).choiceId, 'accept');
});
