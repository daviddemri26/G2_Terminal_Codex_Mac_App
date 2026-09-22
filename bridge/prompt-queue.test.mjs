import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptQueue, MAX_QUEUE_TEXT_LENGTH, MAX_QUEUE_PER_THREAD, MAX_QUEUE_ENTRIES, MAX_QUEUE_FILE_BYTES } from './prompt-queue.mjs';

const uuid = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const thread = uuid(1), otherThread = uuid(2);
const item = number => uuid(1000 + number);
const error409 = error => error.statusCode === 409;
function onDisk(run) {
  const directory = mkdtempSync(join(tmpdir(), 'g2-private-prompt-queue-'));
  try { return run(directory, join(directory, 'prompt-queue.json')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
function record(overrides = {}) {
  return { id: item(1), threadId: thread, text: 'Private synthetic draft', afterTurnId: 'source-turn',
    createdAt: 100, phase: 'queued', reason: null, resumed: false, ...overrides };
}
const persist = (path, entries, extra = {}) => writeFileSync(path, JSON.stringify({ version: 1, entries, ...extra }), { mode: 0o600 });

test('absent queue starts empty without writing a file or creating its directory', () => onDisk(directory => {
  const nested = join(directory, 'not-created');
  const queue = new PromptQueue({ directory: nested });
  assert.deepEqual(queue.list(), []);
  assert.deepEqual(queue.threadIds(), []);
  assert.equal(existsSync(nested), false);
}));

test('private persistence preserves exact text, identities, FIFO and clock across restart', () => onDisk((directory, path) => {
  const queue = new PromptQueue({ directory, now: () => 12345 });
  const text = '  Français, ☕ and “quotes”.\n\nKeep every space.  ';
  queue.enqueue(thread, text, 'source-a', item(1));
  queue.enqueue(otherThread, 'Other task', 'source-b', item(2));
  queue.enqueue(thread, 'Second draft', 'source-a', item(3));
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory), ['prompt-queue.json']);
  const reopened = new PromptQueue({ directory });
  assert.deepEqual(reopened.list(thread).map(entry => entry.id), [item(1), item(3)]);
  assert.equal(reopened.list(thread)[0].text, text);
  assert.equal(reopened.list(thread)[0].createdAt, 12345);
  assert.equal(reopened.list(thread)[0].resumed, false);
  assert.deepEqual(reopened.threadIds(), [thread, otherThread]);
  assert.deepEqual(reopened.list(), queue.list());
}));

test('returned lists and entries cannot mutate stored drafts or delivery state', () => {
  const queue = new PromptQueue();
  const entry = queue.enqueue(thread, 'Exact draft', 'source', item(1));
  entry.text = 'Changed';
  const listed = queue.list(thread); listed[0].phase = 'sending'; listed.push(record());
  const ids = queue.threadIds(); ids.length = 0;
  assert.equal(queue.list(thread)[0].text, 'Exact draft');
  assert.equal(queue.list(thread)[0].phase, 'queued');
  assert.equal(queue.list(thread).length, 1);
  assert.deepEqual(queue.threadIds(), [thread]);
});

test('same identity and exact payload is idempotent even after phase changes', () => {
  const queue = new PromptQueue();
  const first = queue.enqueue(thread, 'Exact draft', 'source', item(1));
  queue.update(item(1), { phase: 'sending' });
  queue.save = () => { throw new Error('Idempotent enqueue must not save'); };
  const second = queue.enqueue(thread, first.text, 'source', item(1));
  assert.equal(second.phase, 'sending');
  assert.equal(queue.list(thread).length, 1);
  for (const values of [[thread, 'Different', 'source'], [otherThread, first.text, 'source'], [thread, first.text, 'other']]) {
    assert.throws(() => queue.enqueue(...values, item(1)), error409);
  }
});

test('draft limits count UTF-16 units and never trim or truncate', () => {
  const queue = new PromptQueue();
  const maximum = '😀'.repeat(MAX_QUEUE_TEXT_LENGTH / 2);
  assert.equal(queue.enqueue(thread, maximum, 'source').text, maximum);
  for (const text of [maximum + 'x', '', ' \n\t ', null, 3]) assert.throws(() => queue.enqueue(thread, text, 'source'), error409);
  assert.equal(queue.list(thread).length, 1);
});

test('per-task and global queue caps fail before changing existing FIFO', () => {
  const queue = new PromptQueue();
  for (let t = 0; t < MAX_QUEUE_ENTRIES / MAX_QUEUE_PER_THREAD; t++) {
    for (let n = 0; n < MAX_QUEUE_PER_THREAD; n++) queue.enqueue(uuid(t + 1), `Draft ${n}`, 'source', item(t * MAX_QUEUE_PER_THREAD + n));
  }
  const before = queue.list();
  assert.equal(before.length, MAX_QUEUE_ENTRIES);
  assert.throws(() => queue.enqueue(uuid(50), 'One too many', 'source'), error409);
  assert.throws(() => queue.enqueue(thread, 'Eleventh for this task', 'source'), error409);
  assert.deepEqual(queue.list(), before);
  const perTask = new PromptQueue();
  for (let n = 0; n < MAX_QUEUE_PER_THREAD; n++) perTask.enqueue(thread, 'Draft', 'source');
  assert.throws(() => perTask.enqueue(thread, 'Eleventh', 'source'), /at most 10/);
});

test('encoded total file size cap also applies to multibyte drafts in memory', () => {
  const queue = new PromptQueue();
  const text = '漢'.repeat(MAX_QUEUE_TEXT_LENGTH);
  let rejected = false;
  for (let n = 0; n < MAX_QUEUE_ENTRIES; n++) {
    const before = queue.list();
    try { queue.enqueue(uuid(Math.floor(n / 10) + 1), text, 'source', item(n)); }
    catch (error) { assert.equal(error.statusCode, 409); assert.deepEqual(queue.list(), before); rejected = true; break; }
  }
  assert.equal(rejected, true);
  assert.ok(Buffer.byteLength(JSON.stringify(queue.data)) <= MAX_QUEUE_FILE_BYTES);
});

test('invalid identities, dependencies, clock and metadata are rejected', () => {
  const queue = new PromptQueue();
  for (const id of ['', 'thread', 4, null]) assert.throws(() => queue.enqueue(id, 'Draft', 'source'), error409);
  for (const id of ['', 'item', 4, null]) assert.throws(() => queue.enqueue(thread, 'Draft', 'source', id), error409);
  for (const turnId of ['', ' ', 'x'.repeat(257), 'bad\nturn', null]) assert.throws(() => queue.enqueue(thread, 'Draft', turnId), error409);
  assert.throws(() => new PromptQueue({ now: () => NaN }).enqueue(thread, 'Draft', 'source'), error409);
  queue.enqueue(thread, 'Draft', 'source', item(1));
  for (const changes of [{ text: 'Changed' }, { id: item(2) }, { resumed: true }, { phase: 'finished' }, { reason: 'guessed' }, { afterTurnId: '' }, null]) {
    assert.throws(() => queue.update(item(1), changes), error409);
  }
});

test('pause and explicit resume preserve unresolved deliveries and reset only paused dependencies', () => {
  const queue = new PromptQueue();
  for (let n = 1; n <= 4; n++) queue.enqueue(thread, `Draft ${n}`, 'source', item(n));
  queue.update(item(2), { phase: 'sending' });
  queue.update(item(3), { phase: 'unknown', reason: 'delivery-unknown' });
  queue.pauseThread(thread, 'interrupted');
  assert.deepEqual(queue.list(thread).map(entry => entry.phase), ['paused', 'sending', 'unknown', 'paused']);
  queue.resumeThread(thread, 'explicit-resume-turn', { allowStopped: true });
  const entries = queue.list(thread);
  assert.deepEqual(entries.map(entry => entry.phase), ['queued', 'sending', 'unknown', 'queued']);
  assert.deepEqual(entries.map(entry => entry.afterTurnId), ['explicit-resume-turn', 'source', 'source', 'explicit-resume-turn']);
  assert.deepEqual(entries.map(entry => entry.resumed), [true, false, false, true]);
  assert.equal(entries[0].reason, null);
  assert.throws(() => queue.update(item(3), { phase: 'queued', reason: null }), error409);
  assert.throws(() => queue.update(item(3), { phase: 'paused', reason: 'user' }), error409);
  assert.equal(queue.update(item(2), { phase: 'queued', reason: null }).phase, 'queued');
});

test('sending and unknown entries survive restart unchanged and no constructor dispatch occurs', () => onDisk((directory, path) => {
  const queue = new PromptQueue({ directory });
  queue.enqueue(thread, 'Possibly sent', 'source', item(1));
  queue.enqueue(thread, 'Awaiting reply', 'source', item(2));
  queue.update(item(1), { phase: 'sending' });
  queue.update(item(2), { phase: 'unknown', reason: 'delivery-unknown' });
  const before = readFileSync(path, 'utf8');
  const reopened = new PromptQueue({ directory });
  assert.deepEqual(reopened.list(thread).map(entry => entry.phase), ['sending', 'unknown']);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(typeof reopened.send, 'undefined');
}));

test('discard refuses an entire task when any delivery is uncertain', () => {
  const queue = new PromptQueue();
  queue.enqueue(thread, 'First', 'source', item(1));
  queue.enqueue(thread, 'Second', 'source', item(2));
  queue.enqueue(otherThread, 'Other', 'source', item(3));
  for (const phase of ['sending', 'unknown']) {
    queue.update(item(2), { phase, reason: phase === 'unknown' ? 'delivery-unknown' : null });
    const before = queue.list();
    assert.throws(() => queue.discardThread(thread), error409);
    assert.deepEqual(queue.list(), before);
  }
  assert.equal(queue.discardThread(otherThread).length, 1);
  assert.equal(queue.list(thread).length, 2);
  assert.deepEqual(queue.discardThread(otherThread), []);
});

test('remove is durable and idempotent only for queued or paused drafts', () => onDisk(directory => {
  const queue = new PromptQueue({ directory });
  queue.enqueue(thread, 'Queued', 'source', item(1));
  queue.enqueue(thread, 'Paused', 'source', item(2));
  queue.update(item(2), { phase: 'paused', reason: 'user' });
  assert.equal(queue.remove(item(1)).text, 'Queued');
  assert.equal(queue.remove(item(2)).text, 'Paused');
  assert.equal(queue.remove(item(1)), null);
  assert.equal(queue.update(item(1), { phase: 'queued' }), null);
  assert.deepEqual(new PromptQueue({ directory }).list(), []);
}));

test('sending and unknown entries require exact delivery reconciliation rather than remove', () => onDisk(directory => {
  const queue = new PromptQueue({ directory });
  queue.enqueue(thread, 'Potentially accepted', 'source', item(1));
  for (const phase of ['sending', 'unknown']) {
    queue.update(item(1), { phase, reason: phase === 'unknown' ? 'delivery-unknown' : null });
    const before = queue.list();
    assert.throws(() => queue.remove(item(1)), /Confirm its delivery/);
    assert.deepEqual(queue.list(), before);
    assert.deepEqual(new PromptQueue({ directory }).list(), before);
  }
  assert.equal(queue.complete(item(1), 'confirmed-native-turn').text, 'Potentially accepted');
  assert.deepEqual(new PromptQueue({ directory }).list(), []);
}));

test('complete atomically removes and rebases only later queued or paused entries in the same task', () => onDisk(directory => {
  const queue = new PromptQueue({ directory });
  queue.enqueue(thread, 'Earlier', 'earlier', item(1));
  queue.enqueue(thread, 'Delivered', 'source', item(2));
  queue.enqueue(otherThread, 'Other', 'source', item(3));
  queue.enqueue(thread, 'Next paused', 'source', item(4));
  queue.enqueue(thread, 'Later sending', 'source', item(5));
  queue.enqueue(thread, 'Later unknown', 'source', item(6));
  queue.enqueue(thread, 'Next queued', 'source', item(7));
  queue.pauseThread(thread, 'user'); queue.resumeThread(thread, 'resumed-source', { allowStopped: true });
  queue.update(item(2), { phase: 'sending' });
  queue.update(item(4), { phase: 'paused', reason: 'user' });
  queue.update(item(5), { phase: 'sending' });
  queue.update(item(6), { phase: 'unknown', reason: 'delivery-unknown' });
  let saves = 0; const durable = queue.save.bind(queue); queue.save = () => { saves++; durable(); };
  assert.equal(queue.complete(item(2), 'accepted-follow-up').id, item(2));
  assert.equal(saves, 1);
  const entries = new PromptQueue({ directory }).list();
  const get = id => entries.find(entry => entry.id === item(id));
  assert.equal(get(1).afterTurnId, 'resumed-source');
  assert.equal(get(3).afterTurnId, 'source');
  for (const n of [4, 7]) { assert.equal(get(n).afterTurnId, 'accepted-follow-up'); assert.equal(get(n).resumed, false); }
  assert.equal(get(4).phase, 'paused');
  for (const n of [5, 6]) assert.equal(get(n).afterTurnId, 'resumed-source');
  assert.equal(queue.complete(item(2), 'another-turn'), null);
  assert.equal(saves, 1);
}));

test('every failed mutation restores its previous in-memory state', () => {
  const changes = [
    queue => queue.enqueue(thread, 'Second', 'source', item(2)),
    queue => queue.update(item(1), { phase: 'sending' }),
    queue => queue.remove(item(1)),
    queue => queue.pauseThread(thread, 'failed'),
    queue => queue.resumeThread(thread, 'resume'),
    queue => queue.discardThread(thread),
    queue => queue.complete(item(1), 'accepted-turn'),
  ];
  for (const change of changes) {
    const queue = new PromptQueue();
    queue.enqueue(thread, 'Exact existing draft', 'source', item(1));
    if (change === changes[4]) queue.pauseThread(thread, 'user');
    const before = queue.list();
    queue.save = () => { throw new Error('Synthetic write failure'); };
    assert.throws(() => change(queue), /Synthetic write failure/);
    assert.deepEqual(queue.list(), before);
  }
});

test('failed complete never partially removes the head or changes a following dependency on disk', () => onDisk((directory, path) => {
  const queue = new PromptQueue({ directory });
  queue.enqueue(thread, 'Delivered head', 'source', item(1));
  queue.enqueue(thread, 'Next', 'source', item(2));
  const before = readFileSync(path, 'utf8');
  queue.save = () => { throw new Error('Synthetic write failure'); };
  assert.throws(() => queue.complete(item(1), 'new-native-turn'), /Synthetic write failure/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(queue.list(), new PromptQueue({ directory }).list());
}));

test('malformed persisted records fail closed without rewriting their contents', () => onDisk((directory, path) => {
  const invalid = [
    '{broken', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: {} }),
    JSON.stringify({ version: 1, entries: [record({ phase: 'done' })] }),
    JSON.stringify({ version: 1, entries: [record({ reason: 'anything' })] }),
    JSON.stringify({ version: 1, entries: [record({ resumed: 'yes' })] }),
    JSON.stringify({ version: 1, entries: [record(), record()] }),
    JSON.stringify({ version: 1, entries: [record({ text: '', added: 'field' })] }),
    JSON.stringify({ version: 1, entries: [], unexpected: true }),
  ];
  for (const source of invalid) {
    writeFileSync(path, source, { mode: 0o600 });
    assert.throws(() => new PromptQueue({ directory }), /Queue history could not be read/);
    assert.equal(readFileSync(path, 'utf8'), source);
  }
}));

test('legacy absent resumed marker becomes false in memory without a constructor write', () => onDisk((directory, path) => {
  const entry = record(); delete entry.resumed; persist(path, [entry]);
  const before = readFileSync(path, 'utf8');
  assert.equal(new PromptQueue({ directory }).list(thread)[0].resumed, false);
  assert.equal(readFileSync(path, 'utf8'), before);
}));

test('oversized files, symlinks and nonprivate files are rejected before use', () => onDisk((directory, path) => {
  writeFileSync(path, ' '.repeat(MAX_QUEUE_FILE_BYTES + 1), { mode: 0o600 });
  assert.throws(() => new PromptQueue({ directory }), /Queue history could not be read/);
  rmSync(path);
  const target = join(directory, 'original.json'); persist(target, []);
  symlinkSync(target, path);
  assert.throws(() => new PromptQueue({ directory }), /Queue history could not be read/);
  assert.equal(readFileSync(target, 'utf8'), '{"version":1,"entries":[]}');
  rmSync(path); persist(path, []); chmodSync(path, 0o644);
  assert.throws(() => new PromptQueue({ directory }), /Queue history could not be read/);
}));

test('a replaced storage path cannot redirect a save or alter its external target', () => onDisk((directory, path) => {
  const queue = new PromptQueue({ directory });
  queue.enqueue(thread, 'First', 'source', item(1));
  const before = queue.list();
  const target = join(directory, 'outside.json'); persist(target, []);
  rmSync(path); symlinkSync(target, path);
  assert.throws(() => queue.enqueue(thread, 'Second', 'source', item(2)), /Queue history could not be saved/);
  assert.deepEqual(queue.list(), before);
  assert.equal(readFileSync(target, 'utf8'), '{"version":1,"entries":[]}');
}));


test('contradictory phase reasons are rejected by updates and persisted-record validation', () => onDisk((directory, path) => {
  const combinations = [
    { phase: 'queued', reason: 'user' },
    { phase: 'sending', reason: 'failed' },
    { phase: 'paused', reason: null },
    { phase: 'unknown', reason: null },
    { phase: 'unknown', reason: 'send-failed' },
  ];
  const queue = new PromptQueue();
  queue.enqueue(thread, 'Draft', 'source', item(1));
  for (const changes of combinations) {
    const before = queue.list();
    assert.throws(() => queue.update(item(1), changes), /phase and reason are inconsistent/);
    assert.deepEqual(queue.list(), before);
    persist(path, [record(changes)]);
    const source = readFileSync(path, 'utf8');
    assert.throws(() => new PromptQueue({ directory }), /Queue history could not be read/);
    assert.equal(readFileSync(path, 'utf8'), source);
  }
}));


test('resuming during ongoing work does not authorize a later failed response', () => {
  const queue = new PromptQueue();
  queue.enqueue(thread, 'Wait for the current response', 'prior-turn', item(1));
  queue.pauseThread(thread, 'user');
  queue.resumeThread(thread, 'still-working-turn');
  assert.equal(queue.list(thread)[0].phase, 'queued');
  assert.equal(queue.list(thread)[0].afterTurnId, 'still-working-turn');
  assert.equal(queue.list(thread)[0].resumed, false);
  queue.pauseThread(thread, 'failed');
  queue.resumeThread(thread, 'explicitly-stopped-turn', { allowStopped: true });
  assert.equal(queue.list(thread)[0].resumed, true);
  queue.pauseThread(thread, 'user');
  queue.resumeThread(thread, 'later-working-turn', { allowStopped: false });
  assert.equal(queue.list(thread)[0].resumed, false);
});

test('resume allowStopped accepts only an explicit boolean without changing the queue on failure', () => {
  const queue = new PromptQueue();
  queue.enqueue(thread, 'Draft', 'source', item(1));
  queue.pauseThread(thread, 'user');
  for (const allowStopped of [null, 'true', 1, {}, []]) {
    const before = queue.list();
    assert.throws(() => queue.resumeThread(thread, 'source', { allowStopped }), error409);
    assert.deepEqual(queue.list(), before);
  }
});
