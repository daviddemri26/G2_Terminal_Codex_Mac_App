import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_TEXT_FORMATTING = Object.freeze({
  showTimestamps: true, showProgressUpdates: true, paragraphSpacing: 'original',
});

export function validateTextFormatting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'paragraphSpacing,showProgressUpdates,showTimestamps'
      || typeof value.showTimestamps !== 'boolean' || typeof value.showProgressUpdates !== 'boolean'
      || !['original', 'compact', 'comfortable'].includes(value.paragraphSpacing)) {
    throw new Error('Invalid text formatting preferences.');
  }
  return { showTimestamps: value.showTimestamps, showProgressUpdates: value.showProgressUpdates,
    paragraphSpacing: value.paragraphSpacing };
}

export function readTextFormatting(path = process.env.EVEN_CODEX_BRIDGE_PREFERENCES_PATH
    || join(homedir(), 'Library', 'Application Support', 'EvenCodexBridge', 'preferences.json')) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > 4096 || metadata.uid !== process.getuid()
        || (metadata.mode & 0o022)) throw new Error('Invalid preferences file.');
    const record = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!record || record.format !== 1 || Object.keys(record).sort().join(',') !== 'format,textFormatting') {
      throw new Error('Invalid preferences format.');
    }
    return validateTextFormatting(record.textFormatting);
  } catch {
    // A damaged preference must never interrupt delivery or expose file contents.
    return { ...DEFAULT_TEXT_FORMATTING };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Adjust existing paragraph gaps only; preserve code and all non-whitespace text. */
export function formatAssistantText(text, preferences = DEFAULT_TEXT_FORMATTING) {
  if (preferences.paragraphSpacing === 'original') return text;
  const protectedRanges = [];
  let offset = 0, fence = null;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const protectedLine = fence !== null || marker || /^(?: {4}|\t)/.test(line);
    if (protectedLine) protectedRanges.push([Math.max(0, offset - 1), offset + line.length + 1]);
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t\\r]*$`).test(line)) fence = null;
    } else if (marker) fence = { character: marker[1][0], length: marker[1].length };
    offset += line.length + 1;
  }
  return text.replace(/\r?\n(?:[ \t]*\r?\n)+/g, (gap, start) => {
    const end = start + gap.length;
    // Keep leading/trailing gaps, fenced blocks, and indented examples verbatim.
    if (start === 0 || end === text.length || protectedRanges.some(([a, b]) => start < b && end > a)) return gap;
    const newline = gap.startsWith('\r\n') ? '\r\n' : '\n';
    return newline.repeat(preferences.paragraphSpacing === 'compact' ? 1 : 3);
  });
}

/** Non-default spacing waits for complete lines so emitted text is append-only. */
export function streamAssistantText(text, preferences = DEFAULT_TEXT_FORMATTING, complete = false) {
  if (complete || preferences.paragraphSpacing === 'original') return formatAssistantText(text, preferences);
  const boundary = text.lastIndexOf('\n');
  if (boundary < 0) return '';
  const stable = text.slice(0, boundary + 1).replace(/(?:\r?\n[ \t]*)+$/, '');
  return formatAssistantText(stable, preferences);
}
