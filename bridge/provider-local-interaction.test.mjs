import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopProvider } from './provider.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { DEFAULT_TEXT_FORMATTING } from './text-formatting.mjs';

const id = '22222222-2222-4222-8222-222222222222';
const initialTurnId = 'synthetic-working-turn';
function snapshot(status = 'inProgress', text = '', turnId = initialTurnId) {
  return { threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle' }, requests: [],
    turns: [{ turnId, status, params: { input: [{ type: 'text', text: 'Original synthetic request' }] },
      items: [{ id: 'final-' + turnId, type: 'agentMessage', phase: 'final_answer', text }] }] };
}
class Fake extends EventEmitter {
  current = snapshot();
  starts = [];
  steers = [];
  interruptions = [];
  nativeReplies = [];
  async follow(thread) { this.emit('state', thread, this.current); return { state: this.current }; }
  async refresh(thread) { this.emit('state', thread, this.current); return { state: this.current }; }
  getState() { return this.current; }
  async startTurn(thread, text, clientUserMessageId, expectedTurnId) {
    this.starts.push({ thread, text, clientUserMessageId, expectedTurnId });
    this.current = snapshot('inProgress', '', 'synthetic-follow-up');
    this.current.turns[0].params.clientUserMessageId = clientUserMessageId;
    this.current.turns[0].params.input = [{ type: 'text', text }];
    this.emit('state', thread, this.current);
    return { turn: { id: 'synthetic-follow-up' } };
  }
  async steerTurn(thread, text, clientUserMessageId, expectedTurnId) {
    this.steers.push({ thread, text, clientUserMessageId, expectedTurnId });
    this.current.turns.at(-1).items.push({ id: clientUserMessageId, type: 'steeringUserMessage',
      status: 'accepted', clientUserMessageId, input: [{ type: 'text', text }] });
    this.emit('state', thread, this.current);
    return { turnId: this.current.turns.at(-1).turnId };
  }
  async interrupt(thread, expectedTurnId) {
    this.interruptions.push({ thread, expectedTurnId });
    this.current.turns.at(-1).status = 'interrupted';
    this.current.threadRuntimeStatus = { type: 'idle' };
    this.emit('state', thread, this.current);
    return { ok: true };
  }
  async respondAction(thread, requestId, response) {
    this.nativeReplies.push({ thread, requestId, response });
    return { confirmed: true };
  }
  unfollow() {}
  async close() {}
}
function setup(options = {}) {
  const client = new Fake(), events = [];
  const store = options.store ?? new DeliveryStore();
  const provider = createDesktopProvider((thread, message) => events.push({ thread, ...message }), {
    client, store, skipBuildGuard: true,
    catalog: async () => [{ id, title: 'Synthetic task', cwd: '/synthetic', updated_at: 1 }],
    readTextFormatting: () => ({ ...DEFAULT_TEXT_FORMATTING }),
    refreshIntervalMs: 60000, statsIntervalMs: 60000, commentarySettleMs: 2,
    ...options,
  });
  return { client, events, provider, store };
}
const reply = (action, label) => JSON.stringify({ [action.presentation.questions[0].displayed]: label });
async function currentAction(provider) {
  const [action] = await provider.getActions(id);
  assert.ok(action?.presentation, 'a correlated action should be displayed');
  return action;
}
async function choose(provider, label, action) {
  return provider.respondQuestion(id, reply(action ?? await currentAction(provider), label));
}
async function compose(provider) {
  const opened = await provider.interrupt(id);
  assert.equal(opened.interrupted, false);
  await choose(provider, 'Add prompt');
}
function noMutation(client) {
  assert.deepEqual(client.starts, []);
  assert.deepEqual(client.steers, []);
  assert.deepEqual(client.interruptions, []);
  assert.deepEqual(client.nativeReplies, []);
}
async function eventually(condition) {
  const deadline = Date.now() + 500;
  while (!condition() && Date.now() < deadline) await delay(5);
  assert.ok(condition(), 'expected state did not arrive within the bounded test wait');
}

// These use synthetic IPC state and protocol events only, never a live Mac task.
test('opening the local menu and Keep working do not interrupt or send a native response', async () => {
  const { provider, client } = setup();
  try {
    const result = await provider.interrupt(id);
    assert.equal(result.menuOpened, true);
    assert.equal(result.interrupted, false);
    const menu = await currentAction(provider);
    assert.equal(menu.local, true);
    assert.deepEqual(menu.choices.map(choice => choice.label), ['Add prompt', 'Stop response', 'Keep working']);
    noMutation(client);
    await choose(provider, 'Keep working', menu);
    noMutation(client);
    assert.equal(provider.getStatus(id).state, 'busy');
    assert.equal(provider.getStatus(id).localInput, false);
  } finally { await provider.close(); }
});

test('only an exact Stop response selection interrupts the observed turn once', async () => {
  const { provider, client } = setup();
  try {
    await provider.interrupt(id);
    const menu = await currentAction(provider), answer = reply(menu, 'Stop response');
    await provider.respondQuestion(id, answer);
    await assert.rejects(provider.respondQuestion(id, answer));
    assert.deepEqual(client.interruptions, [{ thread: id, expectedTurnId: initialTurnId }]);
    assert.equal(client.starts.length + client.steers.length + client.nativeReplies.length, 0);
  } finally { await provider.close(); }
});

test('Add prompt exposes local idle input while engine state and maintenance remain protected', async () => {
  const { provider, client, events } = setup();
  try {
    await compose(provider);
    assert.equal(provider.getStatus(id).state, 'idle');
    assert.equal(provider.getStatus(id).engineState, 'busy');
    assert.equal(provider.getStatus(id).localInput, true);
    assert.equal(await provider.getSessionStatus(id), 'idle');
    assert.equal((await provider.listSessions())[0].status, 'idle');
    const active = provider.getSubscribedSessions()[0];
    assert.equal(active.status, 'busy');
    assert.equal(active.submissionPending, true);
    assert.equal(client.current.turns[0].status, 'inProgress');
    await provider.watch(id);
    assert.equal(provider.getStatus(id).state, 'idle');
    const statuses = events.filter(event => event.type === 'status' && ['busy', 'idle', 'awaiting'].includes(event.state));
    assert.equal(statuses.at(-1).state, 'idle', 'watch must preserve the input-ready display');
    noMutation(client);
  } finally { await provider.close(); }
});

test('captured draft is exact and needs one correlated Steer selection', async () => {
  const { provider, client } = setup();
  try {
    await compose(provider);
    const text = '  Add the café example, please.\n\nKeep these spaces.  ';
    const result = await provider.prompt(id, text);
    assert.equal(result.draft, true);
    assert.equal(result.sent, false);
    noMutation(client);
    const menu = await currentAction(provider), answer = reply(menu, 'Steer');
    assert.ok(menu.presentation.questions[0].displayed.endsWith(text));
    await provider.respondQuestion(id, answer);
    await assert.rejects(provider.respondQuestion(id, answer));
    assert.equal(client.steers.length, 1);
    assert.equal(client.steers[0].text, text);
    assert.equal(client.steers[0].expectedTurnId, initialTurnId);
    assert.equal(client.starts.length + client.interruptions.length + client.nativeReplies.length, 0);
    assert.equal(provider.getSubscribedSessions()[0].submissionPending, false);
  } finally { await provider.close(); }
});

test('Cancel discards a draft and future delayed prompt input still requires review', async () => {
  const { provider, client } = setup();
  try {
    await compose(provider);
    await provider.prompt(id, 'Discard this draft');
    await choose(provider, 'Cancel');
    noMutation(client);
    assert.equal(provider.getStatus(id).state, 'busy');
    const late = await provider.prompt(id, 'Delayed client dictation');
    assert.equal(late.draft, true);
    assert.equal(late.sent, false);
    noMutation(client);
    await choose(provider, 'Cancel');
  } finally { await provider.close(); }
});

test('a native question retires a local menu and rejects its delayed destructive choice', async () => {
  const { provider, client, events } = setup();
  try {
    await provider.interrupt(id);
    const old = await currentAction(provider);
    client.current.requests = [{ id: 71, method: 'item/tool/requestUserInput', params: {
      turnId: initialTurnId, questions: [{ id: 'color', header: 'Color', question: 'Which color?',
        options: [{ label: 'Blue' }, { label: 'Green' }] }],
    } }];
    client.emit('state', id, client.current);
    assert.equal(provider.getStatus(id).localInput, false);
    assert.equal(provider.getStatus(id).state, 'awaiting');
    assert.ok(events.some(event => event.type === 'user_question' && event.toolUseId !== old.id));
    await assert.rejects(choose(provider, 'Stop response', old));
    noMutation(client);
    assert.equal((await currentAction(provider)).id, 71);
  } finally { await provider.close(); }
});

test('concurrent dictation captures preserve exactly one draft and send neither automatically', async () => {
  const { provider, client } = setup();
  try {
    await compose(provider);
    const results = await Promise.allSettled([
      provider.prompt(id, 'First captured message'), provider.prompt(id, 'Second captured message'),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const menu = await currentAction(provider);
    assert.match(menu.presentation.questions[0].displayed, /First captured message/);
    assert.doesNotMatch(menu.presentation.questions[0].displayed, /Second captured message/);
    noMutation(client);
    await choose(provider, 'Steer', menu);
    assert.deepEqual(client.steers.map(value => value.text), ['First captured message']);
  } finally { await provider.close(); }
});

test('timeout closes local input and a delayed dictation remains a preview, not a send', async () => {
  let clock = 1000;
  const { provider, client } = setup({ now: () => clock, interactionTimeoutMs: 20 });
  try {
    await compose(provider);
    clock += 21;
    await eventually(() => !provider.getStatus(id).localInput);
    assert.equal(provider.getStatus(id).state, 'busy');
    noMutation(client);
    const result = await provider.prompt(id, 'Late after timeout');
    assert.equal(result.draft, true);
    assert.equal(result.sent, false);
    noMutation(client);
    await choose(provider, 'Cancel');
  } finally { await provider.close(); }
});

test('a restart retains the prompt review guard without persisting draft text', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-local-input-test-'));
  let first, second;
  try {
    first = setup({ store: new DeliveryStore({ directory }) });
    await compose(first.provider);
    await first.provider.prompt(id, 'DRAFT_PRIVATE_TEST_TEXT');
    const previous = await currentAction(first.provider);
    await first.provider.close();
    second = setup({ store: new DeliveryStore({ directory }) });
    const result = await second.provider.prompt(id, 'Delayed input after restart');
    assert.equal(result.draft, true);
    noMutation(second.client);
    await assert.rejects(choose(second.provider, 'Steer', previous));
    noMutation(second.client);
    assert.doesNotMatch(readFileSync(join(directory, 'delivery.json'), 'utf8'), /DRAFT_PRIVATE_TEST_TEXT|Delayed input/);
    await choose(second.provider, 'Cancel');
  } finally {
    if (first) await first.provider.close();
    if (second) await second.provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('commentary and final received during draft review resume once after Cancel', async () => {
  const { provider, client, events } = setup();
  try {
    await compose(provider);
    await provider.prompt(id, 'A draft to discard');
    const menu = await currentAction(provider);
    events.length = 0;
    client.current.turns[0].items.push({ id: 'buffered-commentary', type: 'agentMessage', phase: 'commentary', text: 'Public progress while dictating.' });
    client.emit('state', id, client.current);
    client.current.turns[0].items[0].text = 'The exact final answer.';
    client.current.turns[0].status = 'completed';
    client.current.threadRuntimeStatus = { type: 'idle' };
    client.emit('state', id, client.current);
    assert.equal(events.filter(event => event.type === 'tool_end' || event.type === 'result').length, 0);
    await choose(provider, 'Cancel', menu);
    await provider.watch(id);
    client.emit('state', id, client.current);
    assert.equal(events.filter(event => event.type === 'tool_end' && event.summary === 'Public progress while dictating.').length, 1);
    assert.deepEqual(events.filter(event => event.type === 'result').map(event => event.text), ['The exact final answer.']);
    const resultIndex = events.findIndex(event => event.type === 'result');
    const realIdleIndex = events.findIndex(event => event.type === 'status' && event.state === 'idle' && !event.bridgeLocalInteraction);
    assert.ok(realIdleIndex > resultIndex, 'real terminal idle must follow the buffered result, never close the client first');
    assert.equal(events.filter(event => event.type === 'text_delta' && !event.bridgeFinalHeader).map(event => event.text).join(''), 'The exact final answer.');
    assert.equal(provider.getStatus(id).state, 'idle');
    noMutation(client);
  } finally { await provider.close(); }
});

test('a completed same turn draft offers Send prompt and starts only after explicit confirmation', async () => {
  const { provider, client } = setup();
  try {
    await compose(provider);
    client.current.turns[0].status = 'completed';
    client.current.threadRuntimeStatus = { type: 'idle' };
    client.current.turns[0].items[0].text = 'Finished while input was open.';
    client.emit('state', id, client.current);
    const result = await provider.prompt(id, 'Follow up after completion');
    assert.equal(result.draft, true);
    const menu = await currentAction(provider);
    assert.deepEqual(menu.choices.map(choice => choice.label), ['Send prompt', 'Queue', 'Cancel']);
    noMutation(client);
    await choose(provider, 'Send prompt', menu);
    assert.equal(client.starts.length, 1);
    assert.equal(client.starts[0].text, 'Follow up after completion');
    assert.equal(client.starts[0].expectedTurnId, initialTurnId);
    assert.equal(client.steers.length + client.interruptions.length + client.nativeReplies.length, 0);
  } finally { await provider.close(); }
});

test('a replaced turn retires its draft and stale confirmation never targets the replacement', async () => {
  const { provider, client } = setup();
  try {
    await compose(provider);
    await provider.prompt(id, 'Intended only for original turn');
    const old = await currentAction(provider);
    client.current = snapshot('inProgress', '', 'replacement-turn');
    client.emit('state', id, client.current);
    assert.equal(provider.getStatus(id).localInput, false);
    await assert.rejects(choose(provider, 'Steer', old));
    noMutation(client);
    assert.equal((await provider.prompt(id, 'Delayed capture after replacement')).draft, true);
    noMutation(client);
    await choose(provider, 'Cancel');
  } finally { await provider.close(); }
});


test('cancelling local input cannot become a stop when refresh replaces the turn or reveals a question', async () => {
  for (const collision of ['replacement', 'question']) {
    const { provider, client } = setup();
    try {
      await compose(provider);
      const originalRefresh = client.refresh.bind(client);
      client.refresh = async thread => {
        if (collision === 'replacement') client.current = snapshot('inProgress', '', 'new-turn-during-cancel');
        else client.current.requests = [{ id: 73, method: 'item/tool/requestUserInput', params: {
          turnId: initialTurnId, questions: [{ id: 'confirm', header: 'Confirm', question: 'Proceed?',
            options: [{ label: 'Yes' }, { label: 'No' }] }],
        } }];
        return originalRefresh(thread);
      };
      const result = await provider.interrupt(id);
      assert.equal(result.cancelledLocalInput, true);
      noMutation(client);
      assert.equal(provider.getStatus(id).localInput, false);
      assert.equal(provider.getStatus(id).state, collision === 'question' ? 'awaiting' : 'busy');
    } finally { await provider.close(); }
  }
});

test('a question that briefly closes the draft during final preflight prevents steering after it disappears', async () => {
  const { provider, client } = setup();
  try {
    await compose(provider);
    await provider.prompt(id, 'Do not send after a collision');
    const menu = await currentAction(provider);
    const originalRefresh = client.refresh.bind(client);
    let refreshes = 0;
    client.refresh = async thread => {
      if (++refreshes === 2) {
        client.current.requests = [{ id: 74, method: 'item/tool/requestUserInput', params: {
          turnId: initialTurnId, questions: [{ id: 'confirm', header: 'Confirm', question: 'Proceed?',
            options: [{ label: 'Yes' }, { label: 'No' }] }],
        } }];
        client.emit('state', thread, client.current);
        client.current.requests = [];
        client.emit('state', thread, client.current);
      }
      return originalRefresh(thread);
    };
    await assert.rejects(choose(provider, 'Steer', menu));
    noMutation(client);
    assert.equal(refreshes, 2);
    assert.equal(provider.getStatus(id).localInput, false);
  } finally { await provider.close(); }
});


test('ordinary idle follow-up bypasses old review guards after an earlier Add prompt', async () => {
  const { provider, client, events } = setup();
  try {
    await compose(provider);
    await provider.prompt(id, 'Earlier active draft');
    await choose(provider, 'Cancel');
    client.current.turns[0].status = 'completed';
    client.current.threadRuntimeStatus = { type: 'idle' };
    client.emit('state', id, client.current);
    events.length = 0;
    const result = await provider.prompt(id, 'Send normally after completion');
    assert.notEqual(result.draft, true);
    assert.deepEqual(client.starts.map(entry => entry.text), ['Send normally after completion']);
    assert.equal(client.steers.length, 0);
    assert.equal(events.some(event => event.type === 'user_question'), false);
  } finally { await provider.close(); }
});

test('persisted legacy review guard does not add a dialogue to an idle follow-up after restart', async () => {
  const store = new DeliveryStore(); store.guardPromptInput(id);
  const { provider, client, events } = setup({ store });
  try {
    client.current = snapshot('completed', 'Already finished.');
    const result = await provider.prompt(id, 'Normal follow-up');
    assert.notEqual(result.draft, true);
    assert.equal(client.starts.length, 1);
    assert.equal(events.some(event => event.type === 'user_question'), false);
  } finally { await provider.close(); }
});

test('an idle direct send never becomes an unconfirmed steer if the Mac starts working during refresh', async () => {
  const { provider, client } = setup();
  try {
    client.current = snapshot('completed', 'Finished.');
    const original = client.refresh.bind(client); let reads = 0;
    client.refresh = async thread => {
      if (++reads === 2) client.current = snapshot('inProgress', '', 'started-on-mac');
      return original(thread);
    };
    await assert.rejects(provider.prompt(id, 'Only send as a follow-up'), /task changed|state changed/i);
    noMutation(client);
  } finally { await provider.close(); }
});
