import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_QUEUE_TEXT_LENGTH = 16000;
export const MAX_QUEUE_PER_THREAD = 10;
export const MAX_QUEUE_ENTRIES = 100;
export const MAX_QUEUE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_QUEUE_TURN_ID_LENGTH = 256;
export const QUEUE_PHASES = Object.freeze(['queued', 'paused', 'sending', 'unknown']);
export const QUEUE_REASONS = Object.freeze(['user', 'interrupted', 'failed', 'native-question', 'send-failed',
  'delivery-unknown', 'task-changed', 'disconnected', 'restart']);

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = value => structuredClone(value);
const fail = (message, code = 'QUEUE_INVALID_STATE') => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
const sameId = (a, b) => a.toLowerCase() === b.toLowerCase();
const checkId = value => { if (!uuid(value)) fail('A valid task or queued prompt identity is required.'); };
const checkTurn = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_QUEUE_TURN_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('A valid preceding response identity is required.');
  }
};
const checkReason = value => { if (value !== null && !QUEUE_REASONS.includes(value)) fail('This queue pause reason is not supported.'); };
const empty = () => ({ version: 1, entries: [] });

function validate(data) {
  if (!plain(data) || Object.keys(data).some(key => !['version', 'entries'].includes(key)) ||
      data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_QUEUE_ENTRIES) fail('The prompt queue format is invalid.');
  const ids = new Set(), counts = new Map();
  const keys = ['id', 'threadId', 'text', 'afterTurnId', 'createdAt', 'phase', 'reason'];
  for (const entry of data.entries) {
    if (!plain(entry) || Object.keys(entry).some(key => ![...keys, 'resumed'].includes(key)) || keys.some(key => !own(entry, key)) ||
        (own(entry, 'resumed') && typeof entry.resumed !== 'boolean')) fail('A queued prompt record is invalid.');
    checkId(entry.id); checkId(entry.threadId); checkTurn(entry.afterTurnId); checkReason(entry.reason);
    if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > MAX_QUEUE_TEXT_LENGTH ||
        !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 || !QUEUE_PHASES.includes(entry.phase)) fail('A queued prompt record is invalid.');
    if ((['queued', 'sending'].includes(entry.phase) && entry.reason !== null) ||
        (entry.phase === 'paused' && entry.reason === null) ||
        (entry.phase === 'unknown' && entry.reason !== 'delivery-unknown')) {
      fail('The queued prompt phase and reason are inconsistent.');
    }
    const key = entry.id.toLowerCase(), thread = entry.threadId.toLowerCase();
    if (ids.has(key)) fail('Queued prompt identities are duplicated.');
    ids.add(key); counts.set(thread, (counts.get(thread) ?? 0) + 1);
    if (counts.get(thread) > MAX_QUEUE_PER_THREAD) fail('A task can have at most 10 queued prompts.');
  }
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_QUEUE_FILE_BYTES) fail('The saved prompt queue is too large.');
}

function privateMetadata(metadata, directory = false) {
  const correctType = directory ? metadata.isDirectory() : metadata.isFile();
  if (!correctType || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    fail('Prompt queue storage must be private and owned by this user.', 'QUEUE_STORAGE_ERROR');
  }
}
function checkDirectory(path) {
  try { privateMetadata(lstatSync(path), true); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/**
 * Private durable FIFO only. This class never sends prompts, retries delivery or
 * changes phases on startup. The provider must reconcile sending/unknown items
 * by their exact ID before removing them; those phases are never auto-resumed.
 */
export class PromptQueue {
  constructor({ directory = null, now = Date.now } = {}) {
    if (directory !== null && (typeof directory !== 'string' || !directory)) fail('A queue storage directory is required.');
    if (typeof now !== 'function') fail('A queue clock is required.');
    this.directory = directory === null ? null : resolve(directory);
    this.path = this.directory === null ? null : join(this.directory, 'prompt-queue.json');
    this.now = now;
    this.data = empty();
    if (this.path === null) return;
    let fd;
    try {
      checkDirectory(this.directory);
      let metadata;
      try { metadata = lstatSync(this.path); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      privateMetadata(metadata);
      if (metadata.size > MAX_QUEUE_FILE_BYTES) fail('The saved prompt queue is too large.');
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd); privateMetadata(opened);
      if (opened.size > MAX_QUEUE_FILE_BYTES) fail('The saved prompt queue is too large.');
      const source = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(source, 'utf8') > MAX_QUEUE_FILE_BYTES) fail('The saved prompt queue is too large.');
      const data = JSON.parse(source); validate(data);
      for (const entry of data.entries) if (!own(entry, 'resumed')) entry.resumed = false;
      this.data = data;
    } catch {
      fail('Queue history could not be read. Queued delivery is paused; inspect the saved queue before continuing.', 'QUEUE_STORAGE_ERROR');
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  list(threadId) {
    if (threadId !== undefined) checkId(threadId);
    return clone(this.data.entries.filter(entry => threadId === undefined || sameId(entry.threadId, threadId)));
  }
  threadIds() {
    const ids = new Map();
    for (const entry of this.data.entries) if (!ids.has(entry.threadId.toLowerCase())) ids.set(entry.threadId.toLowerCase(), entry.threadId);
    return [...ids.values()];
  }

  save() {
    validate(this.data);
    if (this.path === null) return;
    const source = JSON.stringify(this.data);
    let fd, committed = false;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      checkDirectory(this.directory);
      try { privateMetadata(lstatSync(this.path)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, source); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.path); committed = true;
      const directoryFd = openSync(this.directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temporary); } catch {}
      throw Object.assign(new Error('Queue history could not be saved. Sending is paused; inspect the saved queue before continuing.'),
        { code: 'QUEUE_STORAGE_ERROR', statusCode: 409, outcomeUnknown: committed });
    }
  }

  change(operation) {
    const previous = this.data;
    const next = clone(previous);
    const result = operation(next);
    validate(next);
    this.data = next;
    try { this.save(); }
    catch (error) { this.data = previous; throw error; }
    return clone(result);
  }

  enqueue(threadId, text, afterTurnId, id = randomUUID()) {
    checkId(threadId); checkId(id); checkTurn(afterTurnId);
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_QUEUE_TEXT_LENGTH) {
      fail('Enter a nonempty draft of at most 16000 characters. Nothing was added to the queue.');
    }
    const existing = this.data.entries.find(entry => sameId(entry.id, id));
    if (existing) {
      if (!sameId(existing.threadId, threadId) || existing.text !== text || existing.afterTurnId !== afterTurnId) {
        fail('This queued prompt identity already belongs to a different draft.');
      }
      return clone(existing);
    }
    if (this.data.entries.length >= MAX_QUEUE_ENTRIES) fail('The queue can hold at most 100 prompts.');
    if (this.list(threadId).length >= MAX_QUEUE_PER_THREAD) fail('A task can have at most 10 queued prompts.');
    const entry = { id, threadId, text, afterTurnId, createdAt: this.now(), phase: 'queued', reason: null, resumed: false };
    return this.change(data => { data.entries.push(entry); return entry; });
  }

  update(id, changes) {
    checkId(id);
    if (!plain(changes) || Object.keys(changes).some(key => !['phase', 'reason', 'afterTurnId'].includes(key))) fail('Only queue delivery metadata can be changed.');
    if (own(changes, 'phase') && !QUEUE_PHASES.includes(changes.phase)) fail('This queue delivery phase is not supported.');
    if (own(changes, 'reason')) checkReason(changes.reason);
    if (own(changes, 'afterTurnId')) checkTurn(changes.afterTurnId);
    if (!this.data.entries.some(entry => sameId(entry.id, id))) return null;
    return this.change(data => {
      const entry = data.entries.find(candidate => sameId(candidate.id, id));
      if (entry.phase === 'unknown' && own(changes, 'phase') && changes.phase !== 'unknown') {
        fail('An uncertain queued delivery must be reconciled before it can be removed.');
      }
      Object.assign(entry, changes); return entry;
    });
  }

  remove(id) {
    checkId(id);
    const existing = this.data.entries.find(entry => sameId(entry.id, id));
    if (!existing) return null;
    if (['sending', 'unknown'].includes(existing.phase)) {
      fail('A queued prompt may already have been sent. Confirm its delivery before removing it.');
    }
    return this.change(data => {
      const index = data.entries.findIndex(entry => sameId(entry.id, id));
      return data.entries.splice(index, 1)[0];
    });
  }

  complete(id, nextAfterTurnId) {
    checkId(id); checkTurn(nextAfterTurnId);
    if (!this.data.entries.some(entry => sameId(entry.id, id))) return null;
    return this.change(data => {
      const index = data.entries.findIndex(entry => sameId(entry.id, id));
      const completed = data.entries[index];
      for (const entry of data.entries.slice(index + 1)) {
        if (sameId(entry.threadId, completed.threadId) && ['queued', 'paused'].includes(entry.phase)) {
          entry.afterTurnId = nextAfterTurnId; entry.resumed = false;
        }
      }
      data.entries.splice(index, 1); return completed;
    });
  }

  pauseThread(threadId, reason) {
    checkId(threadId); checkReason(reason);
    if (reason === null) fail('A queue pause reason is required.');
    if (!this.data.entries.some(entry => sameId(entry.threadId, threadId) && entry.phase === 'queued')) return this.list(threadId);
    return this.change(data => {
      for (const entry of data.entries) if (sameId(entry.threadId, threadId) && entry.phase === 'queued') {
        entry.phase = 'paused'; entry.reason = reason;
      }
      return data.entries.filter(entry => sameId(entry.threadId, threadId));
    });
  }

  resumeThread(threadId, afterTurnId, { allowStopped = false } = {}) {
    checkId(threadId); checkTurn(afterTurnId);
    if (typeof allowStopped !== 'boolean') fail('An explicit stopped-response resume flag is required.');
    if (!this.data.entries.some(entry => sameId(entry.threadId, threadId) && entry.phase === 'paused')) return this.list(threadId);
    return this.change(data => {
      for (const entry of data.entries) if (sameId(entry.threadId, threadId) && entry.phase === 'paused') {
        entry.phase = 'queued'; entry.reason = null; entry.afterTurnId = afterTurnId; entry.resumed = allowStopped;
      }
      return data.entries.filter(entry => sameId(entry.threadId, threadId));
    });
  }

  discardThread(threadId) {
    checkId(threadId);
    const entries = this.list(threadId);
    if (entries.some(entry => ['sending', 'unknown'].includes(entry.phase))) fail('A queued prompt may already have been sent. Confirm its delivery before clearing the queue.');
    if (!entries.length) return [];
    return this.change(data => {
      data.entries = data.entries.filter(entry => !sameId(entry.threadId, threadId)); return entries;
    });
  }
}
