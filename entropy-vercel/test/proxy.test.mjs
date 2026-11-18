import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaderboardProxy, UPSTREAM_URL } from '../lib/leaderboard-proxy.js';
import handler from '../api/leaderboard.js';

const request = (path = '/api/leaderboard', init) => new Request('https://entropy.example' + path, init);
const json = (body = '{"schemaVersion":1}', init = {}) => new Response(body, {
  ...init, headers: { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=30, stale-while-revalidate=30', etag: '"entropy-42"', ...init.headers },
});
const proxy = (fetchImpl, options = {}) => createLeaderboardProxy({ fetchImpl, logError() {}, ...options });

test('Vercel entry point is a Web Handler', () => assert.equal(typeof handler.fetch, 'function'));

test('only the fixed public GET is fetched, with no caller credentials or headers', async () => {
  let call;
  const response = await proxy(async (...args) => { call = args; return json(); })(request(undefined, {
    headers: { authorization: 'Bearer caller-secret', cookie: 'private=1', origin: 'https://other.example',
      'x-entropy-update': '1', 'oai-authenticated-user-id': 'spoof', host: 'arbitrary.example',
      range: 'bytes=1-4', 'x-target-url': 'https://private.example', 'if-none-match': '"entropy-41"' },
  }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"schemaVersion":1}');
  assert.equal(call[0], UPSTREAM_URL);
  assert.equal(call[1].method, 'GET');
  assert.equal(call[1].redirect, 'manual');
  assert.equal(call[1].credentials, 'omit');
  assert.equal(call[1].cache, 'no-store');
  assert.deepEqual(call[1].headers, { Accept: 'application/json', 'If-None-Match': '"entropy-41"' });
});

test('query parameters and unknown/admin paths never fetch upstream', async () => {
  let count = 0;
  const run = proxy(async () => { count++; return json(); });
  for (const path of ['/api/leaderboard?url=https://private.example', '/api/leaderboard?action=sync',
    '/api/workbench', '/api/status', '/internal/sync', '/api/leaderboard/']) {
    const response = await run(request(path));
    assert.equal(response.status, path.includes('?') ? 400 : 404, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(count, 0);
});

test('all non-GET methods, including HEAD, are read-only rejections', async () => {
  let count = 0;
  const run = proxy(async () => { count++; return json(); });
  for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await run(request(undefined, { method }));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(count, 0);
});

test('upstream public cache, ETag and conditional304 survive without unsafe headers', async () => {
  const response = await proxy(async () => json('ok', { headers: {
    'set-cookie': 'private=never-forward', location: 'https://private.example',
    'access-control-allow-origin': '*', 'x-internal-secret': 'never-forward', 'content-length': '2',
  } }))(request());
  assert.equal(response.headers.get('etag'), '"entropy-42"');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=30');
  for (const name of ['set-cookie', 'location', 'access-control-allow-origin', 'x-internal-secret', 'content-length']) {
    assert.equal(response.headers.get(name), null, name);
  }
  await response.text();
  const notModified = await proxy(async () => new Response(null, { status: 304, headers: {
    etag: '"entropy-42"', 'cache-control': 'public, max-age=30, stale-while-revalidate=30',
  } }))(request(undefined, { headers: { 'if-none-match': '"entropy-42"' } }));
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), '');
  assert.equal(notModified.headers.get('etag'), '"entropy-42"');
});

test('no-store/private and absent cache policies stay conservative', async () => {
  for (const policy of ['no-store', 'private, no-store', null]) {
    const response = await proxy(async () => new Response('{}', { headers: {
      'content-type': 'application/json', ...(policy ? { 'cache-control': policy } : {}),
    } }))(request());
    assert.equal(response.headers.get('cache-control'), policy || 'no-store');
    await response.text();
  }
});

test('a weak Entropy upstream ETag is preserved on a streamed200 response', async () => {
  const response = await proxy(async () => json('{"revision":42}', {
    headers: { etag: 'W/"entropy-42"' },
  }))(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), 'W/"entropy-42"');
  assert.equal(await response.text(), '{"revision":42}');
});

test('GET validators match the same revision across strong and weak tags for304', async () => {
  for (const clientTag of ['"entropy-42"', 'W/"entropy-42"']) {
    for (const upstreamTag of ['"entropy-42"', 'W/"entropy-42"']) {
      const response = await proxy(async (_url, options) => {
        assert.deepEqual(options.headers, { Accept: 'application/json', 'If-None-Match': '"entropy-42"' });
        return new Response(null, { status: 304, headers: {
          etag: upstreamTag, 'cache-control': 'public, max-age=30, stale-while-revalidate=30',
        } });
      })(request(undefined, { headers: { 'if-none-match': clientTag } }));
      assert.equal(response.status, 304, clientTag + ' / ' + upstreamTag);
      assert.equal(response.headers.get('etag'), upstreamTag);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=30');
      assert.equal(await response.text(), '');
    }
  }
});

test('weak tags cannot authorize unsolicited304 or a different snapshot revision', async () => {
  for (const clientTag of [null, '"entropy-41"', 'W/"entropy-41"', 'W/"entropy-empty"']) {
    const response = await proxy(async () => new Response(null, { status: 304,
      headers: { etag: 'W/"entropy-42"', 'cache-control': 'public, max-age=30' } }))(request(undefined,
        clientTag ? { headers: { 'if-none-match': clientTag } } : {}));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), null);
  }
});

test('only the existing Entropy namespace may use weak validators', async () => {
  const invalid = ['W/"other"', 'w/"entropy-42"', 'W/entropy-42', 'W/"entropy-next"',
    'W/"entropy-42", "entropy-43"', 'W/"entropy-42"suffix', 'W/"entropy-' + '1'.repeat(128) + '"'];
  for (const validator of invalid) {
    const response = await proxy(async (_url, options) => {
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      return json();
    })(request(undefined, { headers: { 'if-none-match': validator } }));
    assert.equal(response.status, 200);
    await response.text();
  }
});

test('unsupported validators are not forwarded; unsolicited/mismatched304 fails closed', async () => {
  for (const validator of ['*', '"other"', '"entropy-42", "entropy-43"', 'x'.repeat(1024)]) {
    const response = await proxy(async (_url, options) => {
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      return json();
    })(request(undefined, { headers: { 'if-none-match': validator } }));
    await response.text();
  }
  for (const validator of [null, '"entropy-41"']) {
    const response = await proxy(async () => new Response(null, { status: 304,
      headers: { etag: '"entropy-42"' } }))(request(undefined,
        validator ? { headers: { 'if-none-match': validator } } : {}));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('redirects, upstream errors, HTML and empty responses return sanitized no-store errors', async () => {
  for (const [status, type] of [[302, 'text/html'], [401, 'application/json'], [404, 'application/json'],
    [500, 'application/json'], [200, 'text/html'], [204, 'application/json']]) {
    const response = await proxy(async () => new Response(status === 204 ? null : 'private upstream detail', {
      status, headers: { 'content-type': type, location: 'https://private.example',
        'cache-control': 'public, max-age=3600', 'set-cookie': 'secret=1' },
    }))(request());
    assert.equal(response.status, 503, String(status));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'SERVICE_UNAVAILABLE' });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('location'), null);
  }
});

test('network errors never disclose exception contents', async () => {
  const events = [];
  const response = await proxy(async () => { throw new Error('secret upstream detail'); }, {
    logError: (code) => events.push(code),
  })(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'SERVICE_UNAVAILABLE' });
  assert.deepEqual(events, ['UPSTREAM_FETCH_FAILED']);
});

test('timeout bounds waiting for headers and aborts fetch', async () => {
  let signal;
  const response = await proxy(async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { timeoutMs: 20 })(request());
  assert.equal(signal.aborted, true);
  assert.equal(response.status, 504);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'UPSTREAM_TIMEOUT' });
});

test('streams first chunk before the rest is available and transfers more than4.5MB', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const chunk = new Uint8Array(1024 * 1024).fill(65);
  let pulls = 0;
  const upstream = new ReadableStream({ async pull(controller) {
    pulls++;
    if (pulls === 1) controller.enqueue(new TextEncoder().encode('{'));
    else {
      await gate;
      if (pulls <= 6) controller.enqueue(chunk);
      else { controller.enqueue(new TextEncoder().encode('}')); controller.close(); }
    }
  } }, { highWaterMark: 0 });
  const response = await proxy(async () => json(upstream))(request());
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), '{');
  assert.equal(pulls, 1, 'reading first byte must not wait for or buffer the full snapshot');
  release();
  let bytes = 1;
  while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; }
  assert.equal(bytes, 5 * 1024 * 1024 + 2);
});

test('the total timeout also terminates a stalled response body', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const response = await proxy(async () => json(body), { timeoutMs: 20 })(request());
  await assert.rejects(response.text(), /stream interrupted/);
  assert.equal(cancelled, true);
});

test('downstream cancellation aborts and cancels the upstream body', async () => {
  let signal, cancelled = false;
  const response = await proxy(async (_url, options) => {
    signal = options.signal;
    return json(new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  })(request());
  await response.body.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test('mid-stream upstream errors propagate safely to the reader', async () => {
  let step = 0;
  const response = await proxy(async () => json(new ReadableStream({ pull(controller) {
    if (!step++) controller.enqueue(new TextEncoder().encode('{'));
    else controller.error(new Error('private network detail'));
  } }, { highWaterMark: 0 })))(request());
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), '{');
  await assert.rejects(reader.read(), /Leaderboard stream interrupted/);
});
