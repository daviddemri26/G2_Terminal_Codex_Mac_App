import { createHash } from 'node:crypto';
import { posix } from 'node:path';

// Display-only calculation from public file-change data: no file reads, tool
// arguments, outputs or reasoning. Unknown net line totals are omitted.
const LIMIT = 2 * 1024 * 1024;
const visualization = /(?:^|\/)\.codex\/visualizations\/\d{4}\/\d{2}\/\d{2}\/[a-zA-Z0-9_-]+\/[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
function key(value, cwd = '') {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) return null;
  const path = value.replace(/\\/g, '/');
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:\//i.test(path)) return null;
  return posix.normalize(path.startsWith('/') || /^[a-z]:\//i.test(path) ? path : posix.join(cwd.replace(/\\/g, '/'), path));
}
function lines(value) {
  if (typeof value !== 'string' || value.length > LIMIT || value.includes('\0')) return null;
  const out = value.replace(/\r\n/g, '\n').split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}
function unquote(value) {
  try { return value.startsWith('"') ? JSON.parse(value) : value; } catch { return null; }
}
function paths(header) {
  const rest = header.slice(11);
  let before, after;
  if (rest.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(rest);
    if (!match) return null;
    before = unquote(match[1]); after = unquote(match[2]);
  } else {
    const separator = rest.lastIndexOf(' b/');
    if (separator < 0) return null;
    before = rest.slice(0, separator); after = rest.slice(separator + 1);
  }
  if (!before?.startsWith('a/') || !after?.startsWith('b/')) return null;
  const source = key(before.slice(2)), target = key(after.slice(2));
  return source && target ? { source, target } : null;
}
function section(input, fragment = false) {
  let additions = 0, deletions = 0, oldHeader = false, newHeader = false;
  let metadata = false, opaque = false, copy = false, hunks = 0, oldEnd = 0, newEnd = 0;
  for (let i = 0; i < input.length;) {
    const line = input[i];
    if (line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(line);
      if (!match || (!fragment && !(oldHeader && newHeader))) return null;
      const [a, b, c, d] = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
      if (![a, b, c, d].every(Number.isSafeInteger) || b + d > LIMIT ||
          (b && !a) || (d && !c) || (hunks && (a < oldEnd || c < newEnd))) return null;
      oldEnd = a + b; newEnd = c + d; hunks++;
      let oldLeft = b, newLeft = d;
      i++;
      while (oldLeft || newLeft) {
        const row = input[i++];
        if (row === undefined) return null;
        if (row === '\\ No newline at end of file') continue;
        if (row[0] === ' ') { oldLeft--; newLeft--; }
        else if (row[0] === '+') { newLeft--; additions++; }
        else if (row[0] === '-') { oldLeft--; deletions++; }
        else return null;
        if (oldLeft < 0 || newLeft < 0) return null;
      }
      if (input[i] === '\\ No newline at end of file') i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (oldHeader || newHeader || hunks) return null;
      oldHeader = true;
    } else if (line.startsWith('+++ ')) {
      if (!oldHeader || newHeader || hunks) return null;
      newHeader = true;
    } else if (/^(?:new file mode|deleted file mode|old mode|new mode) \d+$/.test(line) ||
               /^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/.test(line) ||
               /^(?:dis)?similarity index \d+%$/.test(line) ||
               /^(?:rename|copy) (?:from|to) .+$/.test(line)) {
      if (hunks) return null;
      metadata = true; copy ||= line.startsWith('copy ');
    } else if (line === 'GIT binary patch' || /^Binary files .+ differ$/.test(line)) {
      opaque = true; break;
    } else if (line !== '') return null;
    i++;
  }
  // File headers with no hunk can be a truncated patch, not proof of zero lines.
  if (!hunks && (oldHeader || newHeader)) opaque = true;
  return hunks || metadata || opaque ? { additions, deletions, opaque, hunks, copy } : null;
}
function aggregate(diff) {
  const input = lines(diff);
  if (!input?.length || !input[0].startsWith('diff --git ')) return null;
  const out = [];
  for (let i = 0; i < input.length;) {
    const names = paths(input[i++]);
    if (!names) return null;
    const start = i;
    while (i < input.length && !input[i].startsWith('diff --git ')) i++;
    const parsed = section(input.slice(start, i));
    if (!parsed) return null;
    if (!visualization.test(names.target)) out.push({ ...names, ...parsed, source: parsed.copy ? names.target : names.source });
  }
  return out;
}
function result(files, additions, deletions) {
  if (!files) return null;
  const exact = Number.isSafeInteger(additions) && Number.isSafeInteger(deletions);
  const text = files + (files === 1 ? ' file changed' : ' files changed') +
    (exact ? ' · +' + additions + ' −' + deletions : '');
  return { text, fingerprint: createHash('sha256').update(text).digest('hex'), files,
    ...(exact ? { additions, deletions } : {}) };
}
function groupRecords(records) {
  const aliases = new Map(), groups = new Set();
  for (const record of records) {
    let group = aliases.get(record.source) ?? aliases.get(record.target);
    if (!group) { group = []; groups.add(group); }
    const other = aliases.get(record.target);
    if (other && other !== group) {
      group.push(...other); groups.delete(other);
      for (const [path, prior] of aliases) if (prior === other) aliases.set(path, group);
    }
    aliases.set(record.source, group); aliases.set(record.target, group); group.push(record);
  }
  return groups;
}
function totals(records, suppress = false) {
  let additions = 0, deletions = 0, exact = !suppress;
  const groups = groupRecords(records);
  for (const group of groups) {
    // Repeated edits are not independent net changes. Without a proven
    // composition, show only unique files, never gross +/- operation totals.
    if (group.length !== 1 || group[0].opaque) { exact = false; continue; }
    const row = group[0];
    if (!Number.isSafeInteger(row.additions) || !Number.isSafeInteger(row.deletions)) { exact = false; continue; }
    additions += row.additions; deletions += row.deletions;
  }
  return result(groups.size, exact ? additions : undefined, exact ? deletions : undefined);
}
function fallback(turn, suppress = false) {
  let cwd = typeof turn.params?.cwd === 'string' ? turn.params.cwd : '';
  const records = [], items = Array.isArray(turn.items) ? turn.items : [];
  const latest = new Map(items.flatMap((item, i) => item?.id ? [[item.id, i]] : []));
  for (const [i, item] of items.entries()) {
    if (!item || (item.id && latest.get(item.id) !== i)) continue;
    if (item.type === 'commandExecution') { if (typeof item.cwd === 'string') cwd = item.cwd; continue; }
    if (item.type !== 'fileChange' || item.status !== 'completed' || !Array.isArray(item.changes)) continue;
    for (const change of item.changes) {
      const kind = change?.kind?.type;
      if (!['add', 'delete', 'update'].includes(kind)) continue;
      const source = key(change.path, cwd);
      const target = kind === 'update' && change.kind.move_path != null ? key(change.kind.move_path, cwd) : source;
      if (!source || !target || visualization.test(target)) continue;
      let parsed = null;
      if (source === target && kind === 'update') {
        const input = lines(change.diff);
        if (input?.[0]?.startsWith('diff --git ')) {
          const parts = aggregate(change.diff);
          if (parts?.length === 1) parsed = parts[0];
        } else if (input) parsed = section(input, true);
        if (!parsed?.hunks || parsed.opaque) parsed = null;
      } else if (source === target) {
        const content = lines(change.diff);
        // Reviewed native kOn/mOn map add/delete.diff to raw file content.
        // Refuse patch-looking content conservatively if that contract drifts.
        if (content && !content.some((line, i) => line === 'GIT binary patch' ||
          /^Binary files .+ differ$/.test(line) || line.startsWith('diff --git ') ||
          line.startsWith('@@ ') || line === '*** Begin Patch' ||
          (line.startsWith('--- ') && content[i + 1]?.startsWith('+++ ')))) {
          parsed = { additions: kind === 'add' ? content.length : 0, deletions: kind === 'delete' ? content.length : 0 };
        }
      }
      records.push({ source, target, additions: parsed?.additions, deletions: parsed?.deletions });
    }
  }
  return totals(records, suppress);
}

/** Pure per-turn display summary. files is a count; absent +/- totals mean unknown.
 * Fingerprints identify visible text and must be scoped to the turn by callers.
 */
export function summarizeTurnDiff(turn) {
  if (!turn || typeof turn !== 'object') return null;
  if (typeof turn.diff === 'string' && turn.diff.length) {
    const parsed = aggregate(turn.diff);
    return parsed ? totals(parsed) : fallback(turn, true);
  }
  return fallback(turn);
}
