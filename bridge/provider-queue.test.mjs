import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopProvider } from './provider.mjs';
import { DeliveryStore } from './delivery-store.mjs';
import { PromptQueue } from './prompt-queue.mjs';
import { DEFAULT_TEXT_FORMATTING } from './text-formatting.mjs';

const THREAD = '33333333-3333-4333-8333-333333333333';
const ORIGINAL_TURN = 'synthetic-original-turn';
const turn = (turnId, status = 'inProgress', text = 'Original request', clientUserMessageId) => ({
  turnId, status, params: { input: [{ type: 'text', text }], ...(clientUserMessageId ? { clientUserMessageId } : {}) },
  items: [{ id: `final:${turnId}`, type: 'agentMessage', phase: 'final_answer', text: status === 'completed' ? 'Completed.' : '' }],
});
class FakeQueueClient extends EventEmitter {
  current = { threadRuntimeStatus: { type: 'active' }, requests: [], turns: [turn(ORIGINAL_TURN)] };
  starts = [];
  steers = [];
  interruptions = [];
  startFailure = null;
  async follow(thread) { this.emit('state', thread, this.current); return { state: this.current }; }
  async refresh(thread) { this.emit('state', thread, this.current); return { state: this.current }; }
  getState() { return this.current; }
  async startTurn(thread, text, clientUserMessageId, expectedTurnId, options) {
    assert.equal(expectedTurnId, this.current.turns.at(-1).turnId, 'a queue start must target the freshly observed completed turn');
    assert.ok(this.current.turns.at(-1).status === 'completed' || (options?.allowStopped && ['failed', 'interrupted'].includes(this.current.turns.at(-1).status)));
    assert.equal(this.current.requests.length, 0);
    this.starts.push({ thread, text, clientUserMessageId, expectedTurnId, options });
    if (this.startFailure) throw this.startFailure;
    const started = turn(`synthetic-queued-turn-${this.starts.length}`, 'inProgress', text, clientUserMessageId);
    this.current.turns.push(started);
    this.current.threadRuntimeStatus = { type: 'active' };
    if (this.emitAcceptance !== false) this.emit('state', thread, this.current);
    if (this.afterAcceptanceFailure) throw this.afterAcceptanceFailure;
    return { turn: { id: started.turnId, status: 'inProgress' } };
  }
  async steerTurn(...args) { this.steers.push(args); throw new Error('A queued message must never steer an active turn'); }
  async interrupt(thread, expectedTurnId) {
    this.interruptions.push({ thread, expectedTurnId });
    this.complete('interrupted');
    return { ok: true, interruptedTurnId: expectedTurnId };
  }
  complete(status = 'completed') {
    const latest = this.current.turns.at(-1);
    latest.status = status;
    latest.items.at(-1).text = status === 'completed' ? 'Completed.' : '';
    this.current.threadRuntimeStatus = { type: 'idle' };
    this.emit('state', THREAD, this.current);
  }
  accept(messageId, text, status = 'inProgress') {
    const accepted = turn(`synthetic-accepted-${messageId}`, status, text, messageId);
    this.current.turns.push(accepted);
    this.current.threadRuntimeStatus = { type: status === 'inProgress' ? 'active' : 'idle' };
    this.emit('state', THREAD, this.current);
    return accepted;
  }
  unfollow() {}
  async close() {}
}
function setup(options = {}) {
  const client = options.client ?? new FakeQueueClient();
  const store = options.store ?? new DeliveryStore();
  const queueStore = options.queueStore ?? new PromptQueue();
  const events = [];
  const provider = createDesktopProvider((thread, event) => events.push({ thread, ...event }), {
    client, store, queueStore, skipBuildGuard: true,
    catalog: async () => [{ id: THREAD, title: 'Synthetic queue task', cwd: '/synthetic', updated_at: 1 }],
    readTextFormatting: () => ({ ...DEFAULT_TEXT_FORMATTING }),
    refreshIntervalMs: 60000, statsIntervalMs: 60000, commentarySettleMs: 2,
    queueIntervalMs: 5, queueQuietMs: 20,
    ...options,
  });
  return { client, store, queueStore, events, provider };
}
async function action(provider) {
  const [current] = await provider.getActions(THREAD);
  assert.ok(current?.presentation, 'a correlated local menu should be available');
  return current;
}
async function choose(provider, label, current) {
  current ??= await action(provider);
  return provider.respondQuestion(THREAD, JSON.stringify({ [current.presentation.questions[0].displayed]: label }));
}
async function compose(provider) {
  await provider.interrupt(THREAD);
  await choose(provider, 'Add prompt');
}
async function enqueue(set, text) {
  if (!set.store.requiresPromptReview(THREAD)) await compose(set.provider);
  const captured = await set.provider.prompt(THREAD, text);
  assert.equal(captured.sent, false);
  await choose(set.provider, 'Queue');
  const entry = set.queueStore.list(THREAD).find(item => item.text === text);
  assert.ok(entry, 'Queue must persist the exact draft');
  return entry;
}
async function eventually(predicate, message = 'expected queue transition did not arrive') {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}
const noStarts = set => {
  assert.equal(set.client.starts.length, 0);
  assert.equal(set.client.steers.length, 0);
};

// All tasks, text and IPC below are synthetic. No live desktop connection exists.
test('Queue persists the exact draft, restores the current view and never immediately steers', async () => {
  const set = setup();
  try {
    const text = '  First café follow-up.\n\nPreserve these spaces.  ';
    const entry = await enqueue(set, text);
    assert.equal(entry.text, text);
    assert.equal(entry.afterTurnId, ORIGINAL_TURN);
    assert.equal(entry.phase, 'queued');
    assert.equal(set.provider.getStatus(THREAD).localInput, false);
    assert.ok(set.events.some(event => event.type === 'notification' && /queued/i.test(event.message)));
    await delay(50);
    noStarts(set);
    assert.equal(set.provider.getSubscribedSessions().find(item => item.threadId === THREAD).submissionPending, true,
      'maintenance must not discard pending queued work');
  } finally { await set.provider.close(); }
});

test('two queued messages run FIFO only after separate native completions with stable delivery IDs', async () => {
  const set = setup();
  try {
    const first = await enqueue(set, 'First queued request');
    const second = await enqueue(set, 'Second queued request');
    noStarts(set);
    set.client.complete();
    await eventually(() => set.client.starts.length === 1);
    assert.deepEqual(set.client.starts[0], { thread: THREAD, text: first.text,
      clientUserMessageId: first.id, expectedTurnId: ORIGINAL_TURN, options: { queueOnly: true, allowStopped: false, afterTurnId: ORIGINAL_TURN } });
    const firstTurnId = set.client.current.turns.at(-1).turnId;
    await eventually(() => set.queueStore.list(THREAD).length === 1);
    assert.equal(set.queueStore.list(THREAD)[0].id, second.id);
    assert.equal(set.queueStore.list(THREAD)[0].afterTurnId, firstTurnId);
    await delay(50);
    assert.equal(set.client.starts.length, 1, 'the second entry must not steer or race the running first entry');
    set.client.complete();
    await eventually(() => set.client.starts.length === 2);
    assert.equal(set.client.starts[1].text, second.text);
    assert.equal(set.client.starts[1].clientUserMessageId, second.id);
    assert.equal(set.client.starts[1].expectedTurnId, firstTurnId);
    assert.equal(set.client.starts[1].options.afterTurnId, firstTurnId);
    await eventually(() => set.queueStore.list(THREAD).length === 0);
    assert.equal(set.client.steers.length, 0);
  } finally { await set.provider.close(); }
});

test('removing a queued entry through its correlated menu prevents any later start', async () => {
  const set = setup();
  try {
    const entry = await enqueue(set, 'This queued request will be removed');
    await set.provider.interrupt(THREAD);
    await choose(set.provider, 'View queue');
    const list = await action(set.provider);
    const choice = list.choices.find(item => item.id === `item:${entry.id}`);
    assert.ok(choice, 'the queued entry must have its own identity-bound menu choice');
    await choose(set.provider, choice.label, list);
    await choose(set.provider, 'Remove');
    assert.equal(set.queueStore.list(THREAD).length, 0);
    if (set.provider.getStatus(THREAD).localInput) await set.provider.interrupt(THREAD);
    set.client.complete();
    await delay(75);
    noStarts(set);
  } finally { await set.provider.close(); }
});

test('explicit Stop response pauses pending entries before stopping the native turn', async () => {
  const set = setup();
  try {
    await enqueue(set, 'Must remain paused after Stop');
    await set.provider.interrupt(THREAD);
    await choose(set.provider, 'Stop response');
    assert.equal(set.client.interruptions.length, 1);
    assert.ok(set.queueStore.list(THREAD).every(entry => entry.phase === 'paused'));
    set.client.accept('unrelated-message', 'An unrelated completed turn', 'completed');
    await delay(75);
    noStarts(set);
  } finally { await set.provider.close(); }
});

for (const terminalStatus of ['failed', 'interrupted']) {
  test(`a native ${terminalStatus} response pauses the queue instead of automatically continuing`, async () => {
    const set = setup();
    try {
      await enqueue(set, `Must not run after ${terminalStatus}`);
      set.client.complete(terminalStatus);
      await eventually(() => set.queueStore.list(THREAD)[0]?.phase === 'paused');
      await delay(40);
      noStarts(set);
    } finally { await set.provider.close(); }
  });
}

test('pending native controls prevent a completed task from draining its queue', async () => {
  const set = setup();
  try {
    await enqueue(set, 'Wait for the native approval');
    set.client.current.requests = [{ id: 'synthetic-approval', method: 'item/commandExecution/requestApproval',
      params: { turnId: ORIGINAL_TURN } }];
    set.client.complete();
    await delay(60);
    noStarts(set);
    assert.equal(set.queueStore.list(THREAD).length, 1);
    set.client.current.requests = [];
    set.client.emit('state', THREAD, set.client.current);
    await eventually(() => set.client.starts.length === 1);
    assert.equal(set.client.steers.length, 0);
  } finally { await set.provider.close(); }
});

test('an unknown queued send survives restart without retry and only its exact accepted ID releases the head', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-provider-queue-test-'));
  let first, second;
  try {
    first = setup({ store: new DeliveryStore({ directory }), queueStore: new PromptQueue({ directory }) });
    const head = await enqueue(first, 'Uncertain first request');
    const tail = await enqueue(first, 'Later queued request');
    first.client.startFailure = Object.assign(new Error('Synthetic lost acknowledgement'), { code: 'IPC_TIMEOUT', outcomeUnknown: true });
    first.client.complete();
    await eventually(() => first.queueStore.list(THREAD)[0]?.phase === 'unknown');
    assert.equal(first.client.starts.length, 1);
    assert.equal(first.client.starts[0].clientUserMessageId, head.id);
    const recoveredClient = new FakeQueueClient();
    recoveredClient.current = structuredClone(first.client.current);
    await first.provider.close();
    second = setup({ client: recoveredClient, store: new DeliveryStore({ directory }), queueStore: new PromptQueue({ directory }) });
    await delay(80);
    noStarts(second);
    assert.equal(second.queueStore.list(THREAD)[0].id, head.id);
    assert.equal(second.provider.getSubscribedSessions().find(item => item.threadId === THREAD)?.submissionPending, true);
    recoveredClient.accept('different-id-with-the-same-text', head.text, 'completed');
    await delay(40);
    noStarts(second);
    assert.equal(second.queueStore.list(THREAD)[0].id, head.id, 'matching text cannot prove this queued message was delivered');
    const accepted = recoveredClient.accept(head.id, head.text);
    await eventually(() => second.queueStore.list(THREAD).length === 1);
    assert.equal(second.queueStore.list(THREAD)[0].id, tail.id);
    assert.equal(second.queueStore.list(THREAD)[0].afterTurnId, accepted.turnId);
    await delay(40);
    noStarts(second);
  } finally {
    if (first) await first.provider.close();
    if (second) await second.provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('Queue on an already completed task durably enqueues before the scheduled start', async () => {
  const set = setup({ queueQuietMs: 40 });
  try {
    await compose(set.provider);
    set.client.complete();
    const captured = await set.provider.prompt(THREAD, 'Queue this idle follow-up');
    assert.equal(captured.sent, false);
    const menu = await action(set.provider);
    assert.deepEqual(menu.choices.map(choice => choice.label), ['Send prompt', 'Queue', 'Cancel']);
    await choose(set.provider, 'Queue', menu);
    noStarts(set);
    const entry = set.queueStore.list(THREAD)[0];
    assert.equal(entry.text, 'Queue this idle follow-up');
    await eventually(() => set.client.starts.length === 1);
    assert.equal(set.client.starts[0].clientUserMessageId, entry.id);
    assert.deepEqual(set.client.starts[0].options, { queueOnly: true, allowStopped: false, afterTurnId: ORIGINAL_TURN });
  } finally { await set.provider.close(); }
});

test('missing dependency history never authorizes automatic queue delivery', async () => {
  const set = setup();
  try {
    const entry = await enqueue(set, 'Do not send against unrelated history');
    set.client.current.turns = [turn('unrelated-completed-turn', 'completed')];
    set.client.current.threadRuntimeStatus = { type: 'idle' };
    set.client.emit('state', THREAD, set.client.current);
    await delay(75);
    noStarts(set);
    assert.equal(set.queueStore.list(THREAD)[0].id, entry.id);
  } finally { await set.provider.close(); }
});


test('explicit Resume queue permits one start after the selected stopped response', async () => {
  const set = setup();
  try {
    const entry = await enqueue(set, 'Explicitly resumed request');
    set.client.complete('interrupted');
    await eventually(() => set.queueStore.list(THREAD)[0]?.phase === 'paused');
    await choose(set.provider, 'Resume queue');
    noStarts(set);
    await eventually(() => set.client.starts.length === 1);
    assert.equal(set.client.starts[0].clientUserMessageId, entry.id);
    assert.deepEqual(set.client.starts[0].options, { queueOnly: true, allowStopped: true, afterTurnId: ORIGINAL_TURN });
    assert.equal(set.client.starts[0].expectedTurnId, ORIGINAL_TURN);
    await eventually(() => set.queueStore.list(THREAD).length === 0);
  } finally { await set.provider.close(); }
});

test('queue storage errors latch sending off even when represented by HTTP 409', async () => {
  const set = setup();
  try {
    await compose(set.provider);
    await set.provider.prompt(THREAD, 'A queue write that cannot be confirmed');
    set.queueStore.save = () => { throw Object.assign(new Error('Synthetic queue storage failure'),
      { code: 'QUEUE_STORAGE_ERROR', statusCode: 409, outcomeUnknown: true }); };
    await assert.rejects(choose(set.provider, 'Queue'), /Synthetic queue storage failure/);
    await assert.rejects(set.provider.prompt(THREAD, 'A retry must not silently start'), /Synthetic queue storage failure/);
    noStarts(set);
  } finally { await set.provider.close(); }
});

test('an acknowledged native start followed by queue persistence failure is never resent after recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-queue-ack-storage-test-'));
  let first, second;
  try {
    first = setup({ store: new DeliveryStore({ directory }), queueStore: new PromptQueue({ directory }) });
    const entry = await enqueue(first, 'Acknowledged exactly once');
    first.client.emitAcceptance = false;
    first.queueStore.complete = () => { throw Object.assign(new Error('Synthetic completion storage failure'),
      { code: 'QUEUE_STORAGE_ERROR', statusCode: 409 }); };
    first.client.complete();
    await eventually(() => first.events.some(event => event.type === 'error' && /Synthetic completion storage failure/.test(event.message)));
    assert.equal(first.client.starts.length, 1);
    assert.equal(first.store.prompt(THREAD)?.phase, 'acknowledged');
    assert.equal(first.queueStore.list(THREAD)[0].phase, 'sending');
    await assert.rejects(first.provider.prompt(THREAD, 'Do not bypass the storage failure'), /Synthetic completion storage failure/);
    const recoveredClient = new FakeQueueClient();
    recoveredClient.current = structuredClone(first.client.current);
    await first.provider.close();
    second = setup({ client: recoveredClient, store: new DeliveryStore({ directory }), queueStore: new PromptQueue({ directory }) });
    await eventually(() => second.queueStore.list(THREAD).length === 0);
    assert.equal(second.store.prompt(THREAD), null);
    assert.equal(first.client.starts[0].clientUserMessageId, entry.id);
    noStarts(second);
  } finally {
    if (first) await first.provider.close();
    if (second) await second.provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a stopped dependency revealed by final refresh prevents queue delivery', async () => {
  const set = setup();
  try {
    const entry = await enqueue(set, 'Do not cross a refreshed failed response');
    set.client.current.turns[0] = turn(ORIGINAL_TURN, 'completed');
    set.client.current.turns.push(turn('intermediate-turn', 'completed'), turn('latest-completed-turn', 'completed'));
    set.client.current.threadRuntimeStatus = { type: 'idle' };
    set.client.emit('state', THREAD, set.client.current);
    const ordinaryRefresh = set.client.refresh.bind(set.client);
    set.client.refresh = async thread => {
      set.client.current.turns.find(item => item.turnId === 'intermediate-turn').status = 'failed';
      return ordinaryRefresh(thread);
    };
    await delay(80);
    noStarts(set);
    assert.equal(set.queueStore.list(THREAD)[0].id, entry.id);
  } finally { await set.provider.close(); }
});

test('exact accepted queue identity suppresses a later uncertain transport warning', async () => {
  const set = setup();
  try {
    await enqueue(set, 'Accepted despite the later transport failure');
    set.client.afterAcceptanceFailure = Object.assign(new Error('Synthetic error after acceptance'),
      { code: 'IPC_TIMEOUT', outcomeUnknown: true });
    set.client.complete();
    await eventually(() => set.queueStore.list(THREAD).length === 0);
    await delay(25);
    assert.equal(set.client.starts.length, 1);
    assert.equal(set.store.prompt(THREAD), null);
    assert.equal(set.events.some(event => event.type === 'error' && /unconfirmed/i.test(event.message)), false);
  } finally { await set.provider.close(); }
});
