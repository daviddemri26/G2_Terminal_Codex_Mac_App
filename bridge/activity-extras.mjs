import { publicActivityHeading } from './activity.mjs';

// Public activity presentation only. Never inspect commands, arguments, outputs,
// diffs, child responses, or reasoning.content to produce these entries.
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const GROUP_TOOLS = new Set(['commandExecution', 'fileChange', 'webSearch']);
const SUBAGENT_STATUS = Object.freeze({
  started: 'started working', interacted: 'updated',
  interrupted: 'interrupted', completed: 'finished',
});
const ACTION_LABELS = Object.freeze({
  read: 'read files', listFiles: 'listed files', search: 'searched files',
  command: 'ran commands', edit: 'edited files', web: 'searched the web',
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.hasOwn(object, key);
const identifier = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;

// Native HOn uses the last non-root path component and sentence case. Only the
// public path/name is used; malformed or empty paths do not invent an agent.
function agentName(path) {
  if (typeof path !== 'string' || path.length > 2048 || /[\u0000-\u001f\u007f]/.test(path)) return null;
  const part = path.split('/').map(value => value.trim()).filter(value => value && value !== 'root').at(-1);
  if (!part) return null;
  const name = part.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!name) return null;
  const readable = name[0].toUpperCase() + name.slice(1);
  return readable.length <= 80 ? readable : `${readable.slice(0, 79).trimEnd()}…`;
}

function completedActions(item) {
  if (item.status !== 'completed') return [];
  switch (item.type) {
    case 'commandExecution': {
      const actions = item.commandActions;
      // Missing parser annotations still establish a completed command, but
      // never fall back to reading its raw command string.
      if (!Array.isArray(actions) || actions.length === 0) return ['command'];
      return [...new Set(actions.map(action => record(action)
        && ['read', 'listFiles', 'search'].includes(action.type) ? action.type : 'command'))];
    }
    case 'fileChange':
      return Array.isArray(item.changes) && item.changes.some(change => record(change)
        && record(change.kind) && ['add', 'delete', 'update'].includes(change.kind.type)) ? ['edit'] : [];
    case 'webSearch': return ['web'];
    default: return [];
  }
}

/**
 * Ordered public activity entries, independent of transport and delivery.
 * Keys are stable across snapshots; headings can change text under the same key.
 * itemId anchors an entry to its native item (the last tool in an action group).
 * Action groups close at an assistant/reasoning/subagent item, or a terminal
 * turn. Open trailing groups are withheld while work continues to avoid noisy
 * partial summaries. A live group with an unfinished tool also waits until it
 * settles; terminal turns report only completed actions. Unknown/malformed
 * items never provide text.
 */
export function activityEntriesForTurn(turn) {
  if (!record(turn) || !Array.isArray(turn.items)) return [];
  const entries = [], seen = new Set();
  const turnId = identifier(turn.turnId);
  let group = null, hasUnfinishedTool = false;
  const keyFor = (kind, id, detail = null) => JSON.stringify(['activity-extra', turnId, kind, id, detail]);
  const append = entry => {
    if (!seen.has(entry.key)) { entries.push(entry); seen.add(entry.key); }
  };
  const flush = () => {
    if (!group || (hasUnfinishedTool && !TERMINAL.has(turn.status))) {
      group = null; hasUnfinishedTool = false; return;
    }
    const summary = [...group.categories].map(category => ACTION_LABELS[category]).join(', ');
    append({ key: keyFor('actions', group.firstId), itemId: group.lastId,
      text: summary[0].toUpperCase() + summary.slice(1), kind: 'actions' });
    group = null; hasUnfinishedTool = false;
  };
  for (const item of turn.items) {
    if (!record(item)) continue;
    const id = identifier(item.id);
    if (['agentMessage', 'reasoning', 'subAgentActivity'].includes(item.type)) {
      flush();
      if (!id) continue;
      if (item.type === 'reasoning') {
        const heading = publicActivityHeading(item);
        if (heading) append({ key: keyFor('heading', id), itemId: id, text: heading, kind: 'heading' });
      } else if (item.type === 'subAgentActivity' && identifier(item.agentThreadId)
        && typeof item.kind === 'string' && has(SUBAGENT_STATUS, item.kind)) {
        const name = agentName(item.agentPath);
        if (name) append({ key: keyFor('subagent', id, item.kind), itemId: id,
          text: `${name} ${SUBAGENT_STATUS[item.kind]}`, kind: 'subagent' });
      }
      continue;
    }
    if (GROUP_TOOLS.has(item.type) && item.status === 'inProgress') hasUnfinishedTool = true;
    if (!id) continue;
    const categories = completedActions(item);
    if (!categories.length) continue;
    group ??= { firstId: id, lastId: id, categories: new Set() };
    group.lastId = id;
    for (const category of categories) group.categories.add(category);
  }
  if (TERMINAL.has(turn.status)) flush();
  return entries;
}
