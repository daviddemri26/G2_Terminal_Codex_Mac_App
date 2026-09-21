import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEXT_FORMATTING, validateTextFormatting, readTextFormatting,
  formatAssistantText, streamAssistantText } from './text-formatting.mjs';

const original = { ...DEFAULT_TEXT_FORMATTING };
const compact = { ...original, paragraphSpacing: 'compact' };
const comfortable = { ...original, paragraphSpacing: 'comfortable' };

test('original formatting preserves every character and every streaming chunk', () => {
  const text = '# Heading\n\n**bold** [link](https://example.test)\n\n```js\n\nconst x = 1;\n```\n\n   ';
  assert.equal(formatAssistantText(text), text);
  for (let i = 0; i <= text.length; i++) assert.equal(streamAssistantText(text.slice(0, i)), text.slice(0, i));
});

test('paragraph settings adjust existing prose gaps without changing lines or code', () => {
  const text = 'First.\n\nSecond.\nThird.\n\n\nFourth.';
  assert.equal(formatAssistantText(text, compact), 'First.\nSecond.\nThird.\nFourth.');
  assert.equal(formatAssistantText(text, comfortable), 'First.\n\n\nSecond.\nThird.\n\n\nFourth.');
  for (const code of ['```js\nconst a = 1;\n\nconst b = 2;\n```', '~~~\n# unchanged\n\nbody\n~~~', '    first\n\n    second']) {
    assert.equal(formatAssistantText(`Before.\n\n${code}\n\nAfter.`, compact), `Before.\n\n${code}\n\nAfter.`);
  }
  assert.equal(formatAssistantText('a\r\n\r\nb', comfortable), 'a\r\n\r\n\r\nb');
});

test('every custom streaming prefix remains append-only across paragraphs and code fences', () => {
  for (const preferences of [compact, comfortable]) {
    for (const text of ['First.\n\nSecond line.\nThird line.\n\nLast.',
      'Before.\n\n```js\n\nconst a = 1;\n```\n\nAfter.', 'First.\n\n    code\n\n    again\n\nLast.',
      'First.\r\n\r\nSecond.\r\nLast.']) {
      let previous = '';
      for (let i = 0; i <= text.length; i++) {
        const rendered = streamAssistantText(text.slice(0, i), preferences);
        assert.ok(rendered.startsWith(previous), JSON.stringify({ i, previous, rendered }));
        previous = rendered;
      }
      assert.ok(streamAssistantText(text, preferences, true).startsWith(previous));
      assert.equal(streamAssistantText(text, preferences, true), formatAssistantText(text, preferences));
    }
  }
});

test('preference validation rejects unknown fields, partial inputs, types and unsupported enums', () => {
  assert.deepEqual(validateTextFormatting(original), original);
  for (const value of [null, [], {}, { ...original, token: 'SYNTHETIC' }, { ...original, showTimestamps: 1 },
    { ...original, showProgressUpdates: 'false' }, { ...original, paragraphSpacing: 'anything' }]) {
    assert.throws(() => validateTextFormatting(value), /Invalid text/);
  }
});

test('missing, corrupt, oversized and unsafe preference files fall back without exposing contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g2-formatting-'));
  try {
    const path = join(directory, 'preferences.json');
    assert.deepEqual(readTextFormatting(path), original);
    writeFileSync(path, JSON.stringify({ format: 1, textFormatting: compact }), { mode: 0o600 });
    assert.deepEqual(readTextFormatting(path), compact);
    for (const content of ['SYNTHETIC_SECRET', '{}', ' '.repeat(4097),
      JSON.stringify({ format: 1, textFormatting: compact, token: 'SYNTHETIC_SECRET' })]) {
      writeFileSync(path, content);
      assert.deepEqual(readTextFormatting(path), original);
    }
    writeFileSync(path, JSON.stringify({ format: 1, textFormatting: compact }));
    chmodSync(path, 0o666);
    assert.deepEqual(readTextFormatting(path), original);
    chmodSync(path, 0o600);
    symlinkSync(path, join(directory, 'link.json'));
    assert.deepEqual(readTextFormatting(join(directory, 'link.json')), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
