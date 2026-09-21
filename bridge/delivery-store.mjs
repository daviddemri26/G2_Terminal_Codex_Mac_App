import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const empty = () => ({ version: 1, prompts: {}, actions: {}, receipts: {}, presentationCounter: 0 });
const failure = message => Object.assign(new Error(message), { statusCode: 409 });
const actionKey = (threadId, requestId, fingerprint) => JSON.stringify([threadId, requestId, fingerprint]);

// IDs and delivery state only. No prompts, answers, tokens, or approval payloads.
// One supervised process owns this store; rename makes each transition atomic.
export class DeliveryStore {
  constructor({ directory = null, now = Date.now } = {}) {
    this.path = directory ? join(directory, 'delivery.json') : null;
    this.now = now;
    this.data = empty();
    if (this.path && existsSync(this.path)) {
      try {
        const data = JSON.parse(readFileSync(this.path, 'utf8'));
        if (data.version !== 1 || !data.prompts || !data.actions || !data.receipts ||
            [data.prompts, data.actions, data.receipts].some(x => typeof x !== 'object' || Array.isArray(x))) throw new Error('invalid format');
        if (Object.hasOwn(data, 'presentationCounter') &&
            (!Number.isSafeInteger(data.presentationCounter) || data.presentationCounter < 0)) throw new Error('invalid presentation counter');
        // Keep unknown fields so the version-1 record remains safe across a
        // rollback. Older bridge stores likewise retain the parsed object.
        this.data = data;
      } catch {
        throw new Error('Delivery history could not be read. Sending is paused to prevent duplicate messages. Restore the history or check your tasks on the Mac before resetting it.');
      }
    }
  }

  allocatePresentationNumber() {
    const current = Object.hasOwn(this.data, 'presentationCounter') ? this.data.presentationCounter : 0;
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Sending is paused: question numbering is invalid or exhausted. Check the delivery history before continuing.');
    }
    const next = current + 1;
    this.data.presentationCounter = next;
    // Persist before returning: a caller must never display an unreserved
    // number. A failed save may leave a gap, but must never issue a duplicate.
    this.save();
    return next;
  }

  save() {
    if (!this.path) return;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(this.data));
      fsyncSync(fd); closeSync(fd); fd = null;
      renameSync(temporary, this.path);
      const dirFd = openSync(directory, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (error) {
      if (fd != null) closeSync(fd);
      try { unlinkSync(temporary); } catch {}
      throw new Error(`Sending is paused: delivery history could not be saved (${error.code ?? 'storage unavailable'}).`);
    }
  }

  prompt(threadId) { return this.data.prompts[threadId] ?? null; }
  beginPrompt(threadId, clientUserMessageId) {
    if (this.prompt(threadId)) throw failure('This message was already sent or its delivery is unconfirmed. Check this task on the Mac or in Remote before sending again.');
    this.data.prompts[threadId] = { clientUserMessageId, phase: 'sending', createdAt: this.now() };
    this.save();
    return this.prompt(threadId);
  }
  markPrompt(threadId, changes) {
    if (!this.prompt(threadId)) return;
    Object.assign(this.data.prompts[threadId], changes);
    this.save();
  }
  clearPrompt(threadId) {
    if (!this.prompt(threadId)) return;
    delete this.data.prompts[threadId]; this.save();
  }
  reconcilePrompt(threadId, turns) {
    const pending = this.prompt(threadId);
    if (!pending) return false;
    const found = turns.some(t => t.params?.clientUserMessageId === pending.clientUserMessageId ||
      (pending.turnId && t.turnId === pending.turnId) ||
      (t.items ?? []).some(item => (item.type === 'userMessage' && item.clientId === pending.clientUserMessageId) ||
        (item.type === 'steeringUserMessage' && item.status === 'accepted' && item.clientUserMessageId === pending.clientUserMessageId)));
    if (found) this.clearPrompt(threadId);
    return found;
  }

  pendingAction(threadId, requestId, fingerprint) {
    return this.data.actions[actionKey(threadId, requestId, fingerprint)] ?? null;
  }
  beginAction(threadId, requestId, fingerprint) {
    const key = actionKey(threadId, requestId, fingerprint);
    if (this.data.actions[key] || this.data.receipts[key]) throw failure('A response to this request has already been sent. Waiting for the Mac to confirm its state.');
    this.data.actions[key] = { threadId, requestId, fingerprint, phase: 'sending', createdAt: this.now() };
    this.save();
  }
  markAction(threadId, requestId, fingerprint, phase) {
    const entry = this.pendingAction(threadId, requestId, fingerprint);
    if (entry) { entry.phase = phase; this.save(); }
  }
  rejectAction(threadId, requestId, fingerprint) {
    const key = actionKey(threadId, requestId, fingerprint);
    if (this.data.actions[key]) { delete this.data.actions[key]; this.save(); }
  }
  reconcileActions(threadId, pendingActions) {
    let changed = false;
    for (const [key, entry] of Object.entries(this.data.actions)) {
      if (entry.threadId !== threadId || pendingActions.some(a => a.id === entry.requestId && a.fingerprint === entry.fingerprint)) continue;
      delete this.data.actions[key]; this.data.receipts[key] = this.now(); changed = true;
    }
    if (!changed) return;
    const cutoff = this.now() - 30 * 86400000;
    for (const [key, at] of Object.entries(this.data.receipts)) if (at < cutoff) delete this.data.receipts[key];
    this.save();
  }
}
