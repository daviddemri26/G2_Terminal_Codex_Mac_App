import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryStore } from './delivery-store.mjs';

test('unknown prompt survives a restart and only its own desktop turn resolves it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-delivery-'));
  try {
    let store = new DeliveryStore({ directory });
    store.beginPrompt('thread', 'message'); store.markPrompt('thread', { phase: 'unknown' });
    store = new DeliveryStore({ directory });
    assert.throws(() => store.beginPrompt('thread', 'duplicate'), e => e.statusCode === 409);
    assert.equal(store.reconcilePrompt('thread', [{ turnId: 'other', params: { clientUserMessageId: 'other' } }]), false);
    assert.equal(store.reconcilePrompt('thread', [{ params: { clientUserMessageId: 'message' } }]), true);
    store.beginPrompt('thread', 'next');
    assert.equal(statSync(join(directory, 'delivery.json')).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('action delivery is not replayed after restart or disappearance of pending request', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-action-'));
  try {
    let store = new DeliveryStore({ directory });
    store.beginAction('thread', 7, 'question-v1'); store.markAction('thread', 7, 'question-v1', 'unknown');
    store = new DeliveryStore({ directory });
    assert.throws(() => store.beginAction('thread', 7, 'question-v1'), e => e.statusCode === 409);
    store.reconcileActions('thread', [{ id: 7, fingerprint: 'question-v1' }]);
    assert.ok(store.pendingAction('thread', 7, 'question-v1'));
    store.reconcileActions('thread', []);
    assert.throws(() => store.beginAction('thread', 7, 'question-v1'), e => e.statusCode === 409);
    store.beginAction('thread', 8, 'question-v2');
    const saved = readFileSync(join(directory, 'delivery.json'), 'utf8');
    assert.equal(saved.includes('answers'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('corrupt history fails closed instead of forgetting prior submissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-corrupt-'));
  try {
    writeFileSync(join(directory, 'delivery.json'), '{broken');
    assert.throws(() => new DeliveryStore({ directory }), /Sending is paused/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('question presentation numbers are reserved durably and never reused after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-question-number-'));
  try {
    let store = new DeliveryStore({ directory });
    assert.equal(store.allocatePresentationNumber(), 1);
    assert.equal(store.allocatePresentationNumber(), 2);
    assert.equal(JSON.parse(readFileSync(join(directory, 'delivery.json'))).presentationCounter, 2);
    store = new DeliveryStore({ directory });
    assert.equal(store.allocatePresentationNumber(), 3);
    store.beginPrompt('different-task', 'message');
    store = new DeliveryStore({ directory });
    assert.equal(store.allocatePresentationNumber(), 4);
    assert.equal(store.prompt('different-task').clientUserMessageId, 'message');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('legacy version-1 history starts numbering at one and preserves unknown fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-legacy-number-'));
  try {
    const path = join(directory, 'delivery.json');
    writeFileSync(path, JSON.stringify({ version: 1, prompts: {}, actions: {}, receipts: {}, futureField: { retained: true } }));
    const store = new DeliveryStore({ directory });
    assert.equal(store.allocatePresentationNumber(), 1);
    store.beginAction('thread', 7, 'question');
    const saved = JSON.parse(readFileSync(path));
    assert.equal(saved.presentationCounter, 1);
    assert.deepEqual(saved.futureField, { retained: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('malformed and exhausted presentation counters fail closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-invalid-number-'));
  try {
    for (const presentationCounter of [null, -1, 1.5, '1', true, Number.MAX_SAFE_INTEGER + 1]) {
      writeFileSync(join(directory, 'delivery.json'), JSON.stringify({ version: 1, prompts: {}, actions: {}, receipts: {}, presentationCounter }));
      assert.throws(() => new DeliveryStore({ directory }), /Sending is paused/);
    }
    const store = new DeliveryStore();
    store.data.presentationCounter = Number.MAX_SAFE_INTEGER;
    assert.throws(() => store.allocatePresentationNumber(), /invalid or exhausted/);
    store.data.presentationCounter = 'changed after loading';
    assert.throws(() => store.allocatePresentationNumber(), /invalid or exhausted/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failed counter save returns no number and a later allocation skips its reserved value', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-number-write-'));
  try {
    const store = new DeliveryStore({ directory });
    const realSave = store.save.bind(store);
    store.save = () => { throw new Error('Synthetic save failure'); };
    let issued;
    assert.throws(() => { issued = store.allocatePresentationNumber(); }, /Synthetic save failure/);
    assert.equal(issued, undefined);
    store.save = realSave;
    assert.equal(store.allocatePresentationNumber(), 2);
    assert.equal(new DeliveryStore({ directory }).allocatePresentationNumber(), 3);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


const GUARDED_THREAD = '00000000-0000-4000-8000-000000000001';

test('local prompt-review guards survive restart without storing the draft or changing delivery records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-input-guard-'));
  try {
    let store = new DeliveryStore({ directory });
    store.beginPrompt('other-task', 'prior-message');
    store.guardPromptInput(GUARDED_THREAD);
    store.guardPromptInput(GUARDED_THREAD);
    store = new DeliveryStore({ directory });
    assert.equal(store.requiresPromptReview(GUARDED_THREAD), true);
    assert.equal(store.requiresPromptReview('00000000-0000-4000-8000-000000000002'), false);
    assert.equal(store.prompt('other-task').clientUserMessageId, 'prior-message');
    const saved = JSON.parse(readFileSync(join(directory, 'delivery.json')));
    assert.deepEqual(saved.localInputGuards, { [GUARDED_THREAD]: true });
    assert.equal(Object.hasOwn(saved, 'draft'), false);
    assert.equal(statSync(join(directory, 'delivery.json')).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('legacy delivery history acquires a durable local guard while retaining unknown fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-legacy-input-guard-'));
  try {
    const path = join(directory, 'delivery.json');
    writeFileSync(path, JSON.stringify({ version: 1, prompts: {}, actions: {}, receipts: {}, futureField: { retained: true } }));
    const store = new DeliveryStore({ directory });
    assert.equal(store.requiresPromptReview(GUARDED_THREAD), false);
    store.guardPromptInput(GUARDED_THREAD);
    const reloaded = new DeliveryStore({ directory });
    assert.equal(reloaded.requiresPromptReview(GUARDED_THREAD), true);
    assert.deepEqual(reloaded.data.futureField, { retained: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('malformed local input guards fail closed rather than silently enabling direct sends', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-invalid-input-guard-'));
  try {
    for (const localInputGuards of [null, false, [], 'enabled', { [GUARDED_THREAD]: false },
      { [GUARDED_THREAD]: 'true' }, { [GUARDED_THREAD]: 1 }, { [GUARDED_THREAD]: {} }, { invalid: true }]) {
      writeFileSync(join(directory, 'delivery.json'), JSON.stringify({ version: 1, prompts: {}, actions: {}, receipts: {}, localInputGuards }));
      assert.throws(() => new DeliveryStore({ directory }), /Sending is paused/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failed local guard write cannot turn a later retry into an unpersisted success', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-input-guard-write-'));
  try {
    const store = new DeliveryStore({ directory });
    const realSave = store.save.bind(store);
    store.save = () => { throw new Error('Synthetic guard save failure'); };
    assert.throws(() => store.guardPromptInput(GUARDED_THREAD), /Synthetic guard save failure/);
    store.save = realSave;
    store.guardPromptInput(GUARDED_THREAD);
    assert.equal(new DeliveryStore({ directory }).requiresPromptReview(GUARDED_THREAD), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
