// Installed desktop renderer evidence (26.915.31945 / 9922):
// app-initial-a498f911edeb.js BOn formats reasoning.summary; Zcc extracts its
// last visible line; selector tlc calls Zcc(BOn(item.summary)). The turn
// renderer's fl component renders that selector as the compact activity title.
// This module reads that PUBLIC summary only, never reasoning.content.
// OOn maps commandActions read/listFiles/search names and paths to visible UI.
// Native turn timing is turnStartedAtMs/durationMs (Gm and iAn in app-initial).

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const text = value => typeof value === 'string' ? value : '';
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const limitText = (value, limit) => value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

function visibleText(value) {
  return text(value).replace(controls, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function compactText(value, limit = 180) {
  return limitText(visibleText(value)
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ').trim(), limit);
}

/** The same brief, public heading displayed in the Mac's activity row. */
export function publicActivityHeading(item) {
  if (item?.type !== 'reasoning' || !Array.isArray(item.summary)) return null;
  // Fail closed on unknown summary schemas instead of probing content/args.
  if (!item.summary.every(part => typeof part === 'string')) return null;
  const visible = visibleText(item.summary.join('\n\n'));
  const line = visible.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^(```|~~~)/.test(line)).at(-1);
  return line ? compactText(line) || null : null;
}

/** Assistant commentary is already public; final answers/questions stay separate. */
export function publicCommentary(item) {
  if (item?.type !== 'agentMessage' || item.phase !== 'commentary' || item.questions?.length) return null;
  return limitText(visibleText(item.text), 4000) || null;
}

function fileName(value) {
  if (typeof value !== 'string' || (!/^[a-z]:[\\/]/i.test(value) && /^[a-z][a-z\d+.-]*:/i.test(value))) return null;
  const last = value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1);
  if (!last || last === '.' || last === '..') return null;
  return limitText(visibleText(last).replace(/\s+/g, ' ').trim(), 80) || null;
}

function namedFiles(paths) {
  const names = [...new Set(paths.map(fileName).filter(Boolean))];
  if (!names.length) return null;
  return names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} ${names.length === 2 ? 'file' : 'files'}`;
}

const NATIVE_TOOL_NAMES = {
  exec_command: 'Running a command', exec: 'Running a command', apply_patch: 'Updating files',
  web_search: 'Searching the web', web_run: 'Searching the web', read_file: 'Reading a file',
  list_files: 'Listing files', view_image: 'Viewing an image', imagegen: 'Creating an image',
  request_user_input: 'Asking a question', request_user_input_async: 'Asking a question',
  wait: 'Waiting for work to finish', wait_threads: 'Waiting for tasks',
  read_thread: 'Reading task updates', list_threads: 'Checking tasks',
};

function namedTool(item) {
  // Tool identifiers are protocol metadata. Arguments, commands, output and
  // arbitrary tool "summary" fields are intentionally never inspected.
  const name = text(item.tool).split(/__|\./).at(-1);
  if (NATIVE_TOOL_NAMES[name]) return NATIVE_TOOL_NAMES[name];
  if (!name || name.length > 100 || !/^[a-zA-Z][a-zA-Z\d_-]*$/.test(name)) return 'Using a connected tool';
  const words = name.replace(/[_-]+/g, ' ').trim();
  return `Using ${words}`;
}

/** A useful label from public metadata, without command strings or tool arguments. */
export function publicToolLabel(item) {
  if (!item) return null;
  switch (item.type) {
    case 'commandExecution': {
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      const reads = actions.filter(action => action.type === 'read');
      if (reads.length === actions.length && reads.length) {
        const names = namedFiles(reads.map(action => action.path ?? action.name));
        return names ? `Reading ${names}` : 'Reading files';
      }
      if (actions.length && actions.every(action => action.type === 'search')) return 'Searching files';
      if (actions.length && actions.every(action => action.type === 'listFiles')) return 'Listing files';
      return 'Running a command';
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const names = namedFiles(changes.map(change => change.path));
      const verb = changes.length && changes.every(change => change.kind?.type === 'add') ? 'Creating'
        : changes.length && changes.every(change => change.kind?.type === 'delete') ? 'Removing' : 'Updating';
      return names ? `${verb} ${names}` : `${verb} files`;
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': return namedTool(item);
    case 'webSearch': return 'Searching the web';
    case 'imageView': return 'Viewing an image';
    case 'imageGeneration': return 'Creating an image';
    case 'collabAgentToolCall': return item.tool === 'wait' ? 'Waiting for another agent' : 'Working with another agent';
    case 'contextCompaction': return 'Updating task context';
    default: return null;
  }
}

function timestamp(value) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === 'string') value = value.trim() ? (Number.isFinite(Number(value)) ? Number(value) : Date.parse(value)) : NaN;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Wall-clock task duration; reconnecting does not restart a known native clock. */
export function turnElapsedMs(turn, { now = Date.now(), fallbackStartedAtMs = null } = {}) {
  if (!turn) return null;
  const start = timestamp(turn.turnStartedAtMs) ?? timestamp(turn.firstTurnWorkItemStartedAtMs) ?? timestamp(fallbackStartedAtMs);
  if (TERMINAL.has(turn.status)) {
    const duration = timestamp(turn.durationMs);
    if (duration !== null) return duration;
    const end = timestamp(turn.finalAssistantStartedAtMs);
    return start !== null && end !== null ? Math.max(0, end - start) : null;
  }
  const end = timestamp(now);
  return turn.status === 'inProgress' && start !== null && end !== null ? Math.max(0, end - start) : null;
}

export function formatElapsed(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return '';
  const seconds = Math.floor(milliseconds / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A fixed time label; total minutes keep the same format for long tasks. */
export function messageTimeLabel(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return '';
  const seconds = Math.floor(milliseconds / 1000);
  return `[${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}]`;
}

/** Independent presentation data. The provider controls transport and deduplication. */
export function activityForTurn(turn, options = {}) {
  const active = turn?.status === 'inProgress';
  const elapsedMs = turnElapsedMs(turn, options);
  const base = { active, turnId: turn?.turnId ?? null, elapsedMs, elapsedLabel: formatElapsed(elapsedMs) };
  if (!active) return { ...base, title: null, titleSource: null, itemId: null, commentary: null, commentaryItemId: null };
  let latest = null, commentary = null, tool = null;
  for (const item of turn.items ?? []) {
    const heading = publicActivityHeading(item), message = publicCommentary(item);
    if (heading) latest = { title: heading, titleSource: 'summary', itemId: item.id ?? null };
    if (message) {
      commentary = { text: message, id: item.id ?? null };
      latest = { title: compactText(message), titleSource: 'commentary', itemId: item.id ?? null };
    }
    if (item.status === 'inProgress') {
      const label = publicToolLabel(item);
      if (label) tool = { title: label, titleSource: 'tool', itemId: item.id ?? null };
    }
  }
  return { ...base, ...(latest ?? tool ?? { title: 'Working…', titleSource: 'fallback', itemId: null }),
    commentary: commentary?.text ?? null, commentaryItemId: commentary?.id ?? null };
}
