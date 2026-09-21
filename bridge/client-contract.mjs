import { randomBytes } from 'node:crypto';

// Stock Even Terminal carries no request ID in question/permission POST bodies.
// Bind the answer to the visible request using echoed option keys or question
// text. Bare allow/deny and uncorrelated free text must never approve a request.
export class ClientContractError extends Error {
  constructor(message, code = 'CLIENT_INVALID_REPLY') {
    super(message);
    this.name = 'ClientContractError';
    this.code = code;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const badKeys = new Set(['__proto__', 'constructor', 'prototype']);
const questionKinds = new Set(['question', 'async-question', 'option-picker', 'plan-implementation']);
const permissionKinds = new Set(['command-approval', 'file-approval', 'permissions-approval']);
const fail = (message, code) => { throw new ClientContractError(message, code); };
const text = value => typeof value === 'string' ? value : '';

function checkAction(action) {
  if (!action || !['string', 'number'].includes(typeof action.id) || !text(action.kind) || !text(action.fingerprint)) {
    fail('The request has no stable desktop identity.', 'CLIENT_UNSUPPORTED_ACTION');
  }
  if (action.supported === false) fail(action.reason || 'Complete this request in Codex or Remote.', 'CLIENT_UNSUPPORTED_ACTION');
}

function uniqueChoices(action) {
  const choices = action.choices ?? [];
  if (!choices.length || choices.some(choice => !['string', 'number'].includes(typeof choice.id) || !text(choice.label)) ||
      new Set(choices.map(choice => JSON.stringify(choice.id))).size !== choices.length ||
      new Set(choices.map(choice => choice.label)).size !== choices.length) {
    fail('The desktop request has no unambiguous choices. Open Codex or Remote.', 'CLIENT_UNSUPPORTED_ACTION');
  }
  return choices;
}

function normalizeQuestions(questions, token, presentationNumber) {
  if (!Array.isArray(questions) || !questions.length) fail('The request has no questions.', 'CLIENT_UNSUPPORTED_ACTION');
  const seen = new Set();
  return questions.map((question, index) => {
    if (question.isSecret) fail('Enter sensitive information in Codex or Remote.', 'CLIENT_UNSUPPORTED_ACTION');
    const id = String(question.id ?? '');
    if (!id || badKeys.has(id) || seen.has(id)) fail('Question identifiers are ambiguous. Open Codex or Remote.', 'CLIENT_UNSUPPORTED_ACTION');
    seen.add(id);
    const original = text(question.question) || text(question.header);
    if (!original) fail('The request contains an empty question.', 'CLIENT_UNSUPPORTED_ACTION');
    const options = (question.options ?? []).map(option => ({
      label: text(option.label), description: text(option.description), preview: text(option.preview),
    }));
    if (options.some(option => !option.label) || new Set(options.map(option => option.label)).size !== options.length) {
      fail('Question options are ambiguous. Open Codex or Remote.', 'CLIENT_UNSUPPORTED_ACTION');
    }
    return {
      id, original, header: text(question.header), multiSelect: question.multiSelect === true,
      options, displayed: presentationNumber === undefined
        ? `${original} [${token}:Q${index + 1}]`
        : `Question ${presentationNumber}${questions.length > 1 ? `.${index + 1}` : ''}\n${original}`,
    };
  });
}

function detailText(action) {
  const parts = [text(action.description)];
  if (action.details) parts.push(JSON.stringify(action.details, null, 2));
  if (action.permissions) parts.push(JSON.stringify(action.permissions, null, 2));
  for (const choice of action.choices ?? []) {
    if (choice.value && typeof choice.value === 'object') parts.push(`${choice.label}\n${JSON.stringify(choice.value, null, 2)}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Retain the complete returned presentation until the desktop acknowledges it. */
export function buildActionPresentation(action, { presentationNumber } = {}) {
  checkAction(action);
  if (presentationNumber !== undefined && (!Number.isSafeInteger(presentationNumber) || presentationNumber < 1)) {
    fail('A saved question number is required before showing this request.', 'CLIENT_UNSUPPORTED_ACTION');
  }
  const token = randomBytes(6).toString('hex');
  const presentation = { token, id: action.id, kind: action.kind, fingerprint: action.fingerprint,
    ...(presentationNumber === undefined ? {} : { presentationNumber }) };

  if (permissionKinds.has(action.kind)) {
    presentation.choices = uniqueChoices(action).map((choice, index) => ({ id: choice.id, label: choice.label, key: `action:${token}:${index}` }));
    presentation.event = {
      type: 'permission_request', toolName: text(action.title) || 'Approval required',
      description: text(action.description) || text(action.title) || 'Review this request.',
      detail: detailText(action), toolUseId: String(action.id),
      options: presentation.choices.map(choice => ({ text: choice.label, key: choice.key })),
    };
    return presentation;
  }

  if (questionKinds.has(action.kind)) {
    let questions = action.questions;
    if (action.kind === 'plan-implementation' || action.kind === 'option-picker') {
      const choices = uniqueChoices(action);
      presentation.choices = choices.map(choice => ({ id: choice.id, label: choice.label }));
      if (new Set(choices.map(choice => choice.label)).size !== choices.length) {
        fail('Choice labels are ambiguous. Open Codex or Remote.', 'CLIENT_UNSUPPORTED_ACTION');
      }
      const reviewContent = [text(action.title) || 'Choose an option', text(action.description), text(action.plan)].filter(Boolean).join('\n\n');
      questions = [{ id: 'selection', question: reviewContent,
        options: choices.map(choice => ({ label: choice.label, description: text(choice.description) })), multiSelect: false }];
    }
    presentation.questions = normalizeQuestions(questions, token, presentationNumber);
  } else if (action.kind === 'elicitation') {
    // Secret fields, nested objects, arrays and sign-in flows require the native
    // desktop form. The backend can still offer correlated decline/cancel.
    const schema = action.schema;
    const fields = schema?.type === 'object' && plain(schema.properties) ? Object.entries(schema.properties) : [];
    const flatForm = schema && schema.type === 'object' && fields.every(([key, value]) =>
      !badKeys.has(key) && value && ['string', 'number', 'integer', 'boolean', 'null'].includes(value.type) &&
      !value.writeOnly && value.format !== 'password' && !value.isSecret &&
      !['$ref', 'oneOf', 'anyOf', 'allOf', 'not'].some(name => own(value, name)));
    const choices = uniqueChoices(action).filter(choice => choice.id !== 'accept' || flatForm);
    if (!choices.length) fail('Complete this form in Codex or Remote.', 'CLIENT_UNSUPPORTED_ACTION');
    presentation.choices = choices.map(choice => ({ id: choice.id, label: choice.label }));
    presentation.formFields = flatForm ? fields.map(([id, schema]) => ({ id, schema, required: (action.schema.required ?? []).includes(id) })) : [];
    const questions = [{ id: '__form_action', question: [text(action.title) || 'Request from a connected tool', detailText(action), action.reason].filter(Boolean).join('\n\n'),
      options: choices.map(choice => ({ label: choice.label })), multiSelect: false }];
    for (const field of presentation.formFields) {
      const typeHint = field.schema.enum ? '' : field.schema.type === 'string' ? '' : ` (${field.schema.type})`;
      questions.push({ id: field.id, question: `${field.schema.title || field.id}${typeHint}${field.required ? '' : ' (optional; leave blank to omit)'}${field.schema.description ? `\n${field.schema.description}` : ''}`,
        options: (field.schema.enum ?? (field.schema.type === 'boolean' ? [true, false] : [])).map(value => ({ label: String(value) })), multiSelect: false });
    }
    presentation.questions = normalizeQuestions(questions, token, presentationNumber);
  } else {
    fail('Complete this request in Codex or Remote.', 'CLIENT_UNSUPPORTED_ACTION');
  }

  presentation.event = {
    type: 'user_question', toolUseId: String(action.id),
    questions: presentation.questions.map(question => ({ question: question.displayed, header: question.header,
      multiSelect: question.multiSelect, options: question.options })),
  };
  return presentation;
}

function assertCurrent(action, presentation, input) {
  checkAction(action);
  if (!presentation || presentation.id !== action.id || presentation.kind !== action.kind || presentation.fingerprint !== action.fingerprint) {
    fail('This request changed or expired. Refresh the request before answering.', 'CLIENT_STALE_ACTION');
  }
  if (input.requestId !== undefined && input.requestId !== action.id) fail('This answer belongs to another request.', 'CLIENT_STALE_ACTION');
  if (input.actionToken !== undefined && input.actionToken !== presentation.token) fail('This answer belongs to another request.', 'CLIENT_STALE_ACTION');
  // Numeric request IDs can be reused after the desktop restarts. An ID is an
  // additional consistency check, never proof of which presentation was seen.
  return input.actionToken !== undefined;
}

function stringValues(value, multiSelect) {
  if (plain(value)) {
    if (Object.keys(value).length === 1 && own(value, 'answers')) value = value.answers;
    else if (Object.keys(value).length === 1 && own(value, 'answer')) value = value.answer;
    else fail('The answer format is not supported. Refresh the request and answer again.');
  }
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || !values.every(entry => typeof entry === 'string') || (!multiSelect && values.length > 1)) {
    fail('Choose one answer for each question, or use the displayed multiple-choice control.');
  }
  if (new Set(values).size !== values.length) fail('The answer contains duplicate selections.');
  return values;
}

function parseAnswers(presentation, raw, explicitCorrelation) {
  let parsed = raw;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { parsed = JSON.parse(trimmed); }
      catch { if (trimmed.startsWith('{')) fail('The structured answer is invalid JSON.'); }
    }
  }
  // Exact displayed question keys are the vendor's correlation mechanism.
  if (plain(parsed)) {
    if (Object.keys(parsed).length === 1 && plain(parsed.answers)) parsed = parsed.answers;
    const result = Object.create(null);
    const questions = presentation.questions;
    let correlated = explicitCorrelation;
    for (const [key, value] of Object.entries(parsed)) {
      if (badKeys.has(key)) fail('The answer contains an invalid question key.');
      let matches = questions.filter(question => question.displayed === key);
      if (matches.length === 1) correlated = true;
      else if (explicitCorrelation) matches = questions.filter(question => [question.id, question.original, question.header].includes(key));
      if (matches.length !== 1) fail('The answer does not match the displayed request.', 'CLIENT_UNCORRELATED_REPLY');
      const question = matches[0];
      if (own(result, question.id)) fail('The same question was answered twice.');
      result[question.id] = stringValues(value, question.multiSelect);
    }
    if (!correlated) fail('Refresh the request before answering. Its identity is missing.', 'CLIENT_UNCORRELATED_REPLY');
    return result;
  }
  if (typeof parsed !== 'string') fail('Answer the displayed question using text or the choices.');
  let answer = parsed;
  const marker = `[${presentation.token}]`;
  const hasMarker = answer.startsWith(marker);
  if (hasMarker) answer = answer.slice(marker.length).trimStart();
  if (!explicitCorrelation && !hasMarker) fail('This answer has no request identity. Use the displayed choices or reopen the question.', 'CLIENT_UNCORRELATED_REPLY');
  if (answer === 'skip') return Object.create(null);
  if (presentation.questions.length !== 1) fail('Answer each question separately using the displayed form.');
  // Commas belong to the answer. Never split or broadcast a free-text reply.
  return { [presentation.questions[0].id]: [answer] };
}

function choiceFromAnswer(presentation, answers, questionId) {
  const values = answers[questionId];
  if (!values || values.length !== 1) fail('Select one of the displayed choices.');
  const matches = presentation.choices.filter(choice => choice.label === values[0]);
  if (matches.length !== 1) fail('Select one of the displayed choices.');
  return matches[0].id;
}

function formValue(field, values) {
  if (!values || values.length === 0 || values[0] === '') {
    if (field.required) fail(`An answer is required for ${field.schema.title || field.id}.`);
    return undefined;
  }
  const value = values[0];
  const type = field.schema.type;
  if (type === 'string') return value;
  if (type === 'boolean' && ['true', 'false'].includes(value)) return value === 'true';
  if (type === 'null' && value === 'null') return null;
  if (['number', 'integer'].includes(type) && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number) && (type !== 'integer' || Number.isInteger(number))) return number;
  }
  fail(`Enter a valid ${type} for ${field.schema.title || field.id}.`);
}

/** The caller must compare the action with fresh IPC state before mutation. */
export function decodeActionReply(action, presentation, input = {}) {
  const explicit = assertCurrent(action, presentation, input);
  const result = { kind: action.kind, expectedFingerprint: action.fingerprint };
  if (presentation.event.type === 'permission_request') {
    const decision = input.decision;
    let matches = presentation.choices.filter(choice => choice.key === decision);
    if (!matches.length && explicit) matches = presentation.choices.filter(choice => choice.id === decision);
    if (matches.length !== 1) fail('Use the approval choices shown for this request. Bare approval commands cannot be matched safely.', 'CLIENT_UNCORRELATED_REPLY');
    return { ...result, choiceId: matches[0].id };
  }
  const answers = parseAnswers(presentation, input.answer, explicit);
  if (action.kind === 'plan-implementation' || action.kind === 'option-picker') {
    return { ...result, choiceId: choiceFromAnswer(presentation, answers, 'selection') };
  }
  if (action.kind === 'elicitation') {
    const choiceId = choiceFromAnswer(presentation, answers, '__form_action');
    if (choiceId !== 'accept') return { ...result, choiceId, content: null };
    const content = {};
    for (const field of presentation.formFields) {
      const value = formValue(field, answers[field.id]);
      if (value !== undefined) content[field.id] = value;
    }
    return { ...result, choiceId, content };
  }
  if (Object.keys(answers).length && presentation.questions.some(question => !own(answers, question.id))) {
    fail('Answer every displayed question, or skip the complete request.');
  }
  return { ...result, answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])) };
}

/** Temporary commentary is a single status slot, never transcript text. */
export function progressMessage(current) {
  return { type: 'task_progress', completed: 0, total: 1, current: text(current) };
}

/** The stock client's visual clearing behavior still needs a hardware check. */
export function clearProgressMessage() {
  return { type: 'task_progress', completed: 1, total: 1, current: '' };
}
