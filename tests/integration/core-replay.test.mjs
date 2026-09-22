import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Evaluate only the generated read-only route: importing core.js would construct
// real providers. The route body is tested with synthetic provider and HTTP data.
const source = readFileSync(new URL('../../.build/runtime/dist/routes/core.js', import.meta.url), 'utf8');
const start = source.indexOf('router.get("/messages",');
const end = source.indexOf('// GET /api/debug/thread/', start);
assert.ok(start > 0 && end > start);
function routeFixture({ provider = 'codex', failRefresh = false } = {}) {
  const calls = [];
  let handler, result, refreshed = false;
  runInNewContext(source.slice(start, end), {
    router: { get(path, callback) { assert.equal(path, '/messages'); handler = callback; } },
    desktopBridgeEnabled: true, getDefaultProvider: () => 'codex',
    getProvider: () => ({
      async sync(id) { calls.push(['sync', id]); if (failRefresh) throw Object.assign(new Error('Refresh unavailable'), { statusCode: 503 }); refreshed = true; },
      getStatus(id) { calls.push(['status', id]); return { state: refreshed ? 'idle' : 'busy', provider }; },
    }),
    getMessages(id, after) { calls.push(['messages', id, after]); return refreshed ? [{ type: 'status', state: 'idle' }] : [{ type: 'user_question' }]; },
    actionError(res, error) { res.status(error.statusCode ?? 409).json({ error: error.message }); },
  });
  const response = { status(code) { result = { status: code }; return this; }, json(body) { result = { status: result?.status ?? 200, body: JSON.parse(JSON.stringify(body)) }; } };
  return { calls, async run(query) { await handler({ query }, response); return result; } };
}

test('desktop messages wait for authoritative state before returning replay or status', async () => {
  const fixture = routeFixture();
  const result = await fixture.run({ sessionId: 'synthetic-task', provider: 'codex', after: '7' });
  assert.deepEqual(fixture.calls.map(call => call[0]), ['sync', 'status', 'messages']);
  assert.equal(result.body.state, 'idle');
  assert.deepEqual(result.body.messages, [{ type: 'status', state: 'idle' }]);
});

test('default desktop provider also refreshes while stock provider keeps its original read path', async () => {
  const defaultProvider = routeFixture();
  await defaultProvider.run({ sessionId: 'synthetic-task' });
  assert.equal(defaultProvider.calls[0][0], 'sync');
  const stock = routeFixture({ provider: 'claude' });
  const result = await stock.run({ sessionId: 'synthetic-task', provider: 'claude' });
  assert.deepEqual(stock.calls.map(call => call[0]), ['status', 'messages']);
  assert.equal(result.body.state, 'busy');
});

test('desktop refresh failure never returns stale cached questions as a successful messages response', async () => {
  const fixture = routeFixture({ failRefresh: true });
  const result = await fixture.run({ sessionId: 'synthetic-task', provider: 'codex' });
  assert.equal(result.status, 503);
  assert.deepEqual(fixture.calls.map(call => call[0]), ['sync']);
  assert.equal(Object.hasOwn(result.body, 'messages'), false);
});

test('messages still reject a missing task before querying a provider', async () => {
  const fixture = routeFixture();
  const result = await fixture.run({});
  assert.equal(result.status, 400);
  assert.deepEqual(fixture.calls, []);
});


test('New session explains the supported handoff and never starts a separate engine', async () => {
  const routeStart = source.indexOf('router.post("/codex/ensure-app-server",');
  const routeEnd = source.indexOf('\n});', routeStart) + 4;
  assert.ok(routeStart > 0 && routeEnd > routeStart);
  let handler, result;
  runInNewContext(source.slice(routeStart, routeEnd), {
    router: { post(path, callback) { assert.equal(path, '/codex/ensure-app-server'); handler = callback; } },
    desktopBridgeEnabled: true,
    ensureAppServerRunning() { assert.fail('A separate engine must not start'); },
  });
  await handler({}, { status(code) { result = { status: code }; return this; }, json(body) { result.body = body; } });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /New session is not supported/);
  assert.match(result.body.error, /Mac app or Remote/);
  assert.match(result.body.error, /select it on your glasses/);
});
