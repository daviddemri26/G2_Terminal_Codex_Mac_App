import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTurnDiff } from './diff-summary.mjs';

const patch = (a, b) => '@@ -1 +1 @@\n-' + a + '\n+' + b + '\n';
const full = (path, body) => 'diff --git a/' + path + ' b/' + path + '\n--- a/' + path + '\n+++ b/' + path + '\n' + body;
const change = (path, type, diff, extra = {}) => ({ path, kind: { type, ...extra }, diff });
const item = (changes, status = 'completed', id) => ({ type: 'fileChange', changes, status, ...(id ? { id } : {}) });
const turn = (...items) => ({ params: { cwd: '/synthetic/project' }, items });
const stats = value => {
  const { fingerprint, text, ...rest } = value;
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  return rest;
};

test('authoritative aggregate net totals override gross repeated edit operations', () => {
  const value = summarizeTurnDiff({ ...turn(item([change('a.js', 'update', patch('a', 'b'))]),
    item([change('a.js', 'update', patch('b', 'c'))])),
    diff: full('a.js', patch('a', 'c')) + full('b.js', '@@ -0,0 +1,2 @@\n+x\n+y\n') });
  assert.deepEqual(stats(value), { files: 2, additions: 3, deletions: 1 });
  assert.equal(value.text, '2 files changed · +3 −1');
});

test('actual file headers are excluded while header-looking hunk content counts', () => {
  assert.deepEqual(stats(summarizeTurnDiff({ diff: full('a.js', '@@ -1 +1 @@\n---content\n+++content\n\\ No newline at end of file\n') })),
    { files: 1, additions: 1, deletions: 1 });
});

test('truncated authoritative hunks never produce precise fallback totals', () => {
  const value = summarizeTurnDiff({ ...turn(item([change('a.js', 'add', 'a\n')])),
    diff: full('a.js', '@@ -0,0 +1,2 @@\n+a\n') });
  assert.deepEqual(stats(value), { files: 1 });
  assert.equal(value.text, '1 file changed');
  assert.equal(summarizeTurnDiff({ diff: 'unrecognized diff' }), null);
});

test('repeated aggregate sections and rename chains do not inflate unique file counts', () => {
  assert.deepEqual(stats(summarizeTurnDiff({ diff: full('a.js', patch('a', 'b')) + full('a.js', patch('b', 'c')) })), { files: 1 });
  const rename = (a, b) => 'diff --git a/' + a + ' b/' + b + '\nsimilarity index 100%\nrename from ' + a + '\nrename to ' + b + '\n';
  assert.deepEqual(stats(summarizeTurnDiff({ diff: rename('a.js', 'b.js') + rename('b.js', 'c.js') })), { files: 1 });
});

test('binary aggregate has count only; pure aggregate rename has known zero line changes', () => {
  const prefix = 'diff --git a/old.bin b/new.bin\nsimilarity index 100%\nrename from old.bin\nrename to new.bin\n';
  assert.deepEqual(stats(summarizeTurnDiff({ diff: prefix + 'Binary files a/old.bin and b/new.bin differ\n' })), { files: 1 });
  assert.deepEqual(stats(summarizeTurnDiff({ diff: prefix })), { files: 1, additions: 0, deletions: 0 });
});

test('unique add delete update fallback totals are proven from their individual payloads', () => {
  assert.deepEqual(stats(summarizeTurnDiff(turn(item([
    change('a.js', 'add', 'a\r\nb\r\n'), change('b.js', 'delete', 'no newline'),
    change('c.js', 'update', patch('old', 'new')),
  ])))), { files: 3, additions: 3, deletions: 2 });
});

test('repeated existing or newly created file edits fall back to count only', () => {
  for (const first of [change('a.js', 'add', 'a\n'), change('a.js', 'update', patch('old', 'a'))]) {
    assert.deepEqual(stats(summarizeTurnDiff(turn(item([first]),
      item([change('./a.js', 'update', patch('a', 'b'))])))), { files: 1 });
  }
});

test('fallback rename and following destination edit remain one file with unknown totals', () => {
  assert.deepEqual(stats(summarizeTurnDiff(turn(
    item([change('old.js', 'update', patch('a', 'b'), { move_path: 'new.js' })]),
    item([change('new.js', 'update', patch('b', 'c'))]),
  ))), { files: 1 });
});

test('failed declined and unknown statuses are omitted and latest item state wins', () => {
  assert.equal(summarizeTurnDiff(turn(
    item([change('a.js', 'add', 'x')], 'inProgress', 'same'),
    item([change('a.js', 'add', 'x')], 'failed', 'same'),
    item([change('b.js', 'add', 'x')], 'declined'), item([change('c.js', 'add', 'x')], 'unknown'),
  )), null);
  assert.equal(summarizeTurnDiff(turn(item([change('d.js', 'add', 'x')], 'inProgress'))), null);
});

test('cwd disambiguates files while output contains no path, content or reasoning', () => {
  const value = summarizeTurnDiff(turn(
    { type: 'reasoning', get content() { throw new Error('Private'); }, get summary() { throw new Error('Not needed'); } },
    item([change('private-name.js', 'add', 'PRIVATE_CONTENT')]),
    { type: 'commandExecution', cwd: '/synthetic/other', get command() { throw new Error('Not needed'); } },
    item([change('private-name.js', 'add', 'PRIVATE_CONTENT')]),
  ));
  assert.equal(value.files, 2);
  assert.doesNotMatch(JSON.stringify(value), /synthetic|private-name|PRIVATE_CONTENT/);
});

test('missing binary or unknown payloads omit all numeric totals', () => {
  for (const diff of ['\0binary', undefined, 'GIT binary patch\nliteral 1']) {
    assert.deepEqual(stats(summarizeTurnDiff(turn(item([change('a.bin', 'add', diff)])))), { files: 1 });
  }
  assert.deepEqual(stats(summarizeTurnDiff(turn(item([change('a.js', 'update', 'unknown format')])))), { files: 1 });
});

test('quoted and spaced git paths parse without being exposed', () => {
  const diff = 'diff --git "a/a space.js" "b/a space.js"\n--- "a/a space.js"\n+++ "b/a space.js"\n' + patch('a', 'b');
  assert.deepEqual(stats(summarizeTurnDiff({ diff })), { files: 1, additions: 1, deletions: 1 });
  assert.equal(summarizeTurnDiff({ diff: full('a space.js', patch('a', 'b')) }).files, 1);
});

test('native visualization artifacts and empty turns have no summary', () => {
  const path = '/synthetic/.codex/visualizations/2026/09/21/task/chart.html';
  assert.equal(summarizeTurnDiff(turn(item([change(path, 'add', 'artifact')]))), null);
  assert.equal(summarizeTurnDiff({ diff: full(path, patch('a', 'b')) }), null);
  for (const value of [null, undefined, {}, { items: [] }]) assert.equal(summarizeTurnDiff(value), null);
});

test('fingerprints deduplicate visible counts without retaining paths or body text', () => {
  const a = summarizeTurnDiff(turn(item([change('a.js', 'add', 'a')])));
  const b = summarizeTurnDiff(turn(item([change('other.js', 'add', 'b')])));
  const c = summarizeTurnDiff(turn(item([change('a.js', 'add', 'a\nb')])));
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test('aggregate copies count their destinations independently from the original file', () => {
  const copy = target => 'diff --git a/original.js b/' + target + '\nsimilarity index 100%\ncopy from original.js\ncopy to ' + target + '\n';
  const diff = full('original.js', patch('a', 'b')) + copy('one.js') + copy('two.js');
  assert.deepEqual(stats(summarizeTurnDiff({ diff })), { files: 3, additions: 1, deletions: 1 });
});


test('only completed changes appear while other operations are still in progress', () => {
  const pending = item([change('pending.js', 'add', 'x')], 'inProgress', 'pending');
  const completed = item([change('done.js', 'add', 'x')], 'completed', 'done');
  assert.deepEqual(stats(summarizeTurnDiff(turn(pending, completed))), { files: 1, additions: 1, deletions: 0 });
  assert.deepEqual(stats(summarizeTurnDiff(turn(pending,
    item(pending.changes, 'completed', 'pending'), completed))), { files: 2, additions: 2, deletions: 0 });
});

test('add and delete patch-shaped payloads never count patch syntax as content lines', () => {
  for (const kind of ['add', 'delete']) {
    for (const diff of [full('a.js', patch('a', 'b')), patch('a', 'b'),
      '--- a/a.js\n+++ b/a.js\n', '*** Begin Patch\n*** Add File: a.js\n+x\n*** End Patch']) {
      assert.deepEqual(stats(summarizeTurnDiff(turn(item([change('a.js', kind, diff)])))), { files: 1 });
    }
  }
});

test('aggregate file headers without hunks yield count only even with index metadata', () => {
  const prefix = 'diff --git a/a.js b/a.js\n';
  for (const body of ['--- a/a.js\n+++ b/a.js\n', 'index 123..456 100644\n--- a/a.js\n+++ b/a.js\n',
    'index 123..456 100644\n--- a/a.js\n']) {
    assert.deepEqual(stats(summarizeTurnDiff({ diff: prefix + body })), { files: 1 });
  }
});

test('visualization filtering is restricted to the reviewed generated HTML pattern', () => {
  for (const path of ['/synthetic/.codex/config.toml',
    '/synthetic/.codex/visualizations/2026/09/21/task/chart.js',
    '/synthetic/.codex/visualizations/custom/chart.html']) {
    assert.equal(summarizeTurnDiff(turn(item([change(path, 'add', 'x')]))).files, 1);
  }
});
