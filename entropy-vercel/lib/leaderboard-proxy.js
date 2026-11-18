export const UPSTREAM_URL = 'https://entropyio-leaderboard.vadfy.chatgpt.site/api/leaderboard';
const ETAG = /^"entropy-(?:empty|[0-9]+)"$/;
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function errorResponse(status, code, extra = {}) {
  return Response.json({ error: code }, {
    status, headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...extra },
  });
}
function cachePolicy(value) {
  // Preserve a private/no-store policy too. No header or CDN-specific override
  // may turn an upstream response into something more cacheable.
  return value && value.length <= 512 && /^[\x20-\x7e]+$/.test(value) ? value : 'no-store';
}
function validETag(value) { return typeof value === 'string' && value.length <= 128 && ETAG.test(value) ? value : null; }

/** A fixed public read, with no environment credentials or caller-selected target. */
export function createLeaderboardProxy({ fetchImpl = globalThis.fetch, timeoutMs = 10000,
  logError = (code) => console.error('[entropy-public-proxy]', code) } = {}) {
  return async function leaderboard(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/leaderboard') return errorResponse(404, 'NOT_FOUND');
    if (request.method !== 'GET') return errorResponse(405, 'READ_ONLY', { Allow: 'GET' });
    if (url.search) return errorResponse(400, 'INVALID_QUERY');
    if (request.signal.aborted) return errorResponse(408, 'REQUEST_ABORTED');

    const abort = new AbortController();
    let timedOut = false, finished = false, reader, streamController;
    const cleanup = () => {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onClientAbort);
    };
    const stop = (reason) => {
      if (finished) return;
      finished = true;
      cleanup();
      abort.abort(reason);
      if (reader) void reader.cancel(reason).catch(() => {});
      if (streamController) streamController.error(new Error('Leaderboard stream interrupted.'));
    };
    const onClientAbort = () => stop(new Error('Client disconnected.'));
    const timer = setTimeout(() => {
      timedOut = true;
      logError('UPSTREAM_TIMEOUT');
      stop(new Error('Upstream timeout.'));
    }, timeoutMs);
    request.signal.addEventListener('abort', onClientAbort, { once: true });

    let upstream;
    const validator = validETag(request.headers.get('if-none-match'));
    try {
      const headers = { Accept: 'application/json' };
      if (validator) headers['If-None-Match'] = validator;
      upstream = await fetchImpl(UPSTREAM_URL, {
        method: 'GET', headers, credentials: 'omit', cache: 'no-store',
        redirect: 'manual', signal: abort.signal,
      });
      if (finished) {
        void upstream.body?.cancel().catch(() => {});
        return errorResponse(timedOut ? 504 : 408, timedOut ? 'UPSTREAM_TIMEOUT' : 'REQUEST_ABORTED');
      }
      const etag = validETag(upstream.headers.get('etag'));
      const headersOut = new Headers({ ...SECURITY_HEADERS,
        'cache-control': cachePolicy(upstream.headers.get('cache-control')) });
      if (etag) headersOut.set('etag', etag);
      if (upstream.status === 304 && validator && etag === validator) {
        finished = true;
        cleanup();
        return new Response(null, { status: 304, headers: headersOut });
      }
      if (upstream.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(upstream.headers.get('content-type') || '') || !upstream.body) {
        logError('UPSTREAM_UNAVAILABLE');
        stop(new Error('Invalid upstream response.'));
        void upstream.body?.cancel().catch(() => {});
        return errorResponse(503, 'SERVICE_UNAVAILABLE');
      }
      headersOut.set('content-type', 'application/json; charset=utf-8');
      reader = upstream.body.getReader();
      // Read one chunk per downstream pull. Never collect or parse the snapshot;
      // this stays a streamed response as the public dataset grows beyond 4.5MB.
      const body = new ReadableStream({
        start(controller) { streamController = controller; },
        async pull(controller) {
          if (finished) return;
          try {
            const chunk = await reader.read();
            if (finished) return;
            if (chunk.done) {
              finished = true;
              cleanup();
              reader.releaseLock();
              controller.close();
            } else controller.enqueue(chunk.value);
          } catch {
            if (!finished) {
              logError('UPSTREAM_STREAM_FAILED');
              stop(new Error('Upstream stream failed.'));
            }
          }
        },
        cancel() {
          if (finished) return;
          finished = true;
          cleanup();
          abort.abort();
          return reader.cancel().catch(() => {});
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: 200, headers: headersOut });
    } catch {
      if (!timedOut && !request.signal.aborted) logError('UPSTREAM_FETCH_FAILED');
      stop(new Error('Upstream fetch failed.'));
      return errorResponse(timedOut ? 504 : request.signal.aborted ? 408 : 503,
        timedOut ? 'UPSTREAM_TIMEOUT' : request.signal.aborted ? 'REQUEST_ABORTED' : 'SERVICE_UNAVAILABLE');
    }
  };
}
