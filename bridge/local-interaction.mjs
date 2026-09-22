import { createHash, randomUUID } from 'node:crypto';
import { buildActionPresentation, ClientContractError, decodeActionReply } from './client-contract.mjs';

export const MAX_LOCAL_DRAFT_LENGTH = 16000;
export const MAX_LOCAL_QUEUE_ENTRIES = 10;
const stages = new Set(['interrupt', 'draft', 'queue-list', 'queue-item']);
const phases = new Set(['queued', 'paused', 'sending', 'unknown']);
const phaseLabel = { queued: 'Queued', paused: 'Paused', sending: 'Sending', unknown: 'Delivery unconfirmed' };
const fail = (message, code = 'CLIENT_INVALID_REPLY') => { throw new ClientContractError(message, code); };
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const shortened = (text, limit) => {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  let out = '';
  for (const character of line) {
    if (out.length + character.length > limit - 1) break;
    out += character;
  }
  return out + '…';
};
function snapshotQueue(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_LOCAL_QUEUE_ENTRIES) {
    fail('The local queue must contain at most 10 prompts.', 'CLIENT_UNSUPPORTED_ACTION');
  }
  const ids = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(entry.id) ||
        ids.has(entry.id) || typeof entry.text !== 'string' || !entry.text.trim() ||
        entry.text.length > MAX_LOCAL_DRAFT_LENGTH || !phases.has(entry.phase)) {
      fail('The local queue changed or cannot be displayed safely.', 'CLIENT_UNSUPPORTED_ACTION');
    }
    ids.add(entry.id);
    return { id: entry.id, text: entry.text, phase: entry.phase };
  });
}
const fingerprintOf = menu => createHash('sha256').update(JSON.stringify([
  menu.id, menu.stage, menu.mode, menu.turnId, menu.draftText ?? null,
  menu.queueEntries, menu.queueIds, menu.queuePaused, menu.selectedId ?? null,
  menu.action.title, menu.action.description, menu.action.choices,
])).digest('hex');

/** Local presentation only; never forward these actions to desktop IPC.
 * Reserve a fresh durable presentationNumber for every new snapshot/menu.
 * The provider must revalidate the current turn and queue before mutation.
 */
export function createLocalMenu({ stage, presentationNumber, turnId, draftText, mode = 'steer',
  queueEntries = [], queuePaused = false, selectedId } = {}) {
  if (!stages.has(stage)) fail('This local menu is not supported.', 'CLIENT_UNSUPPORTED_ACTION');
  if (!['steer', 'send'].includes(mode) || (stage === 'interrupt' && mode !== 'steer')) {
    fail('This local input mode is not supported.', 'CLIENT_UNSUPPORTED_ACTION');
  }
  if (!Number.isSafeInteger(presentationNumber) || presentationNumber < 1) {
    fail('Reserve a new question number before showing this menu.', 'CLIENT_UNSUPPORTED_ACTION');
  }
  if (typeof turnId !== 'string' || !turnId.trim()) {
    fail('This menu needs the current response identity.', 'CLIENT_UNSUPPORTED_ACTION');
  }
  if (typeof queuePaused !== 'boolean') fail('The queue pause state is invalid.', 'CLIENT_UNSUPPORTED_ACTION');
  const entries = snapshotQueue(queueEntries);
  const paused = queuePaused || entries.some(entry => entry.phase === 'paused');
  const unsafe = entries.some(entry => ['sending', 'unknown'].includes(entry.phase));
  if (stage === 'draft') {
    if (typeof draftText !== 'string' || !draftText.trim()) fail('Dictate a message before reviewing it.');
    if (draftText.length > MAX_LOCAL_DRAFT_LENGTH) fail('This draft is too long. Use at most 16000 characters; nothing has been sent.');
  } else if (draftText !== undefined) fail('Only a draft menu can contain a draft.', 'CLIENT_UNSUPPORTED_ACTION');
  const selected = entries.find(entry => entry.id === selectedId);
  if ((stage === 'queue-item' && !selected) || (stage !== 'queue-item' && selectedId !== undefined)) {
    fail('Select a current queued prompt before opening it.', 'CLIENT_UNSUPPORTED_ACTION');
  }
  let title, description, choices;
  if (stage === 'interrupt') {
    title = 'Response controls'; description = 'The Codex Mac App is still working. Choose what to do.';
    choices = [
      { id: 'add', label: 'Add prompt', description: 'Prepare a message while the Mac keeps working.' },
      ...(entries.length ? [{ id: 'view-queue', label: 'View queue', description: 'Review the queued prompts in order.' }] : []),
      { id: 'stop', label: 'Stop response', description: 'Stop the current response on the Mac.' },
      { id: 'continue', label: 'Keep working', description: 'Close this menu without changing the task.' },
    ];
  } else if (stage === 'draft') {
    title = 'Review your draft';
    description = (mode === 'send'
      ? 'The previous response has finished. This draft has not been sent. Choose Send prompt to start a follow-up, Queue to add it to the waiting list, or Cancel to discard it.'
      : 'The Codex Mac App is still working. This draft has not been sent. Choose Steer to add it to the current response, Queue to send it after earlier work, or Cancel to discard it.')
      + `\n\nDraft:\n${draftText}`;
    choices = [
      mode === 'send'
        ? { id: 'send', label: 'Send prompt', description: 'Send this exact draft as a new follow-up.' }
        : { id: 'steer', label: 'Steer', description: 'Send this exact draft to the current response.' },
      { id: 'queue', label: 'Queue', description: 'Add this exact draft after the earlier queued prompts.' },
      { id: 'cancel', label: 'Cancel', description: 'Discard this draft without sending it.' },
    ];
  } else if (stage === 'queue-list') {
    title = `Queued prompts (${entries.length})`;
    description = entries.length ? entries.map((entry, index) =>
      `#${index + 1} · ${phaseLabel[entry.phase]}\n${shortened(entry.text, 120)}`).join('\n\n') : 'No prompts are queued.';
    choices = entries.map((entry, index) => {
      const prefix = `#${index + 1}: `;
      return { id: `item:${entry.id}`, label: prefix + shortened(entry.text, 60 - prefix.length), description: phaseLabel[entry.phase] };
    });
    if (entries.length && paused && !unsafe) choices.push({ id: 'resume', label: 'Resume queue', description: 'Allow waiting prompts to continue in order.' });
    if (entries.length && !paused && entries.every(entry => entry.phase === 'queued')) choices.push({ id: 'pause', label: 'Pause queue', description: 'Keep waiting prompts without sending the next one.' });
    if (entries.length && !unsafe) choices.push({ id: 'clear', label: 'Clear queue', description: 'Remove all waiting prompts.' });
    choices.push({ id: 'back', label: 'Back', description: 'Close this view without changing the queue.' });
  } else {
    title = `Queued prompt #${entries.findIndex(entry => entry.id === selectedId) + 1}`;
    description = `${phaseLabel[selected.phase]}\n\nPrompt:\n${selected.text}`;
    choices = [
      ...(['queued', 'paused'].includes(selected.phase) ? [{ id: 'remove', label: 'Remove', description: 'Remove this waiting prompt without sending it.' }] : []),
      { id: 'back', label: 'Back', description: 'Return to the queue.' },
    ];
  }
  const id = `local-interaction:${randomUUID()}`;
  const action = { id, kind: 'option-picker', supported: true, localOnly: true, title, description, choices };
  const menu = { stage, mode, turnId, ...(stage === 'draft' ? { draftText } : {}),
    queueEntries: entries, queueIds: entries.map(entry => entry.id), queuePaused: paused,
    ...(stage === 'queue-item' ? { selectedId } : {}), id, action, consumed: false };
  const fingerprint = fingerprintOf(menu);
  action.fingerprint = fingerprint;
  return freeze({ ...menu, fingerprint, presentation: buildActionPresentation(action, { presentationNumber }) });
}

/** Pure decoder. Store its consumed menu synchronously before awaiting anything.
 * The provider owns queue/turn freshness, delivery, and duplicate-send protection.
 */
export function decodeLocalChoice(menu, input = {}) {
  if (!menu || menu.consumed !== false || menu.action?.localOnly !== true ||
      menu.id !== menu.action.id || menu.fingerprint !== menu.action.fingerprint ||
      !stages.has(menu.stage) || !['steer', 'send'].includes(menu.mode) ||
      (menu.stage === 'interrupt' && menu.mode !== 'steer') || !Array.isArray(menu.action.choices) ||
      menu.fingerprint !== fingerprintOf(menu)) {
    fail('This menu has closed or changed. Open the current controls.', 'CLIENT_STALE_ACTION');
  }
  const { choiceId } = decodeActionReply(menu.action, menu.presentation, input);
  if (!menu.action.choices.some(choice => choice.id === choiceId)) fail('Select one of the displayed choices.');
  return freeze({ choiceId, menu: { ...menu, consumed: true } });
}
