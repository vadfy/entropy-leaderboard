import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createClient, normalizeTweets, TwitterApiError } from './twitterapi.mjs';
const require = createRequire(import.meta.url);
require('./scoring.js');
const Model = require('./model.js');
const fixture = (overrides = {}) => ({ id: '2113234760927494175', text: 'About Entropy', createdAt: 'Tue Nov 17 09:30:00 +0000 2026',
  viewCount: 100, likeCount: 0, retweetCount: 1, quoteCount: 2, replyCount: 3, bookmarkCount: 4,
  author: { id: '1234567890123456789', userName: 'creator', name: 'Creator', followers: 200 }, ...overrides });
const options = { observedAt: '2026-11-17T10:00:00Z', periodStart: '2026-11-01', periodEndExclusive: '2026-12-01' };
const response = body => ({ ok: true, status: 200, json: async () => body });

test('search uses exact fixed origin, read-only auth header, Latest and opaque cursor', async () => {
  let calls = 0;
  const client = createClient({ apiKey: 'secret', fetchImpl: async (url, init) => {
    calls++; assert.equal(url.origin, 'https://api.twitterapi.io'); assert.equal(url.pathname, '/twitter/tweet/advanced_search');
    assert.equal(url.searchParams.get('query'), '@Entropy -filter:retweets'); assert.equal(url.searchParams.get('cursor'), 'a+b&c');
    assert.equal(url.searchParams.get('queryType'), 'Latest'); assert.equal(init.method, 'GET');
    assert.equal(init.headers['x-api-key'], 'secret'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
    return response({ tweets: [fixture()], has_next_page: true, next_cursor: 'next' });
  } });
  const page = await client.searchPage({ query: '@Entropy -filter:retweets', cursor: 'a+b&c' });
  assert.equal(page.hasNextPage, true); assert.equal(page.nextCursor, 'next'); assert.equal(calls, 1);
});
test('search refuses missing/oversized query and malformed pagination without retries', async () => {
  let calls = 0;
  const client = createClient({ apiKey: 'secret', fetchImpl: async () => { calls++; return response({ tweets: [], has_next_page: true, next_cursor: '' }); } });
  await assert.rejects(client.searchPage({ query: 'x'.repeat(513) }), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
  await assert.rejects(client.searchPage({ query: 'Entropy' }), { code: 'INVALID_RESPONSE' }); assert.equal(calls, 1);
});
test('mentions adapter uses bounded seconds and an independent opaque cursor', async () => {
  let calls = 0;
  const client = createClient({ apiKey: 'secret', fetchImpl: async (url, init) => {
    calls++; assert.equal(url.origin, 'https://api.twitterapi.io'); assert.equal(url.pathname, '/twitter/user/mentions');
    assert.equal(url.searchParams.get('userName'), 'entropyIO'); assert.equal(url.searchParams.get('sinceTime'), '1793491200');
    assert.equal(url.searchParams.get('untilTime'), '1793577600'); assert.equal(url.searchParams.get('cursor'), 'mentions+a&b');
    assert.equal(url.searchParams.has('query'), false); assert.equal(url.searchParams.has('queryType'), false);
    assert.equal(init.method, 'GET'); assert.equal(init.headers['x-api-key'], 'secret'); assert.equal(init.redirect, 'manual');
    return response({ tweets: [fixture()], has_next_page: true, next_cursor: 'mentions-next', status: 'success', msg: '' });
  } });
  const result = await client.mentionsPage({ userName: 'entropyIO', sinceTime: 1793491200, untilTime: 1793577600, cursor: 'mentions+a&b' });
  assert.equal(result.nextCursor, 'mentions-next'); assert.equal(result.hasNextPage, true); assert.equal(result.tweets.length, 1); assert.equal(calls, 1);
});
test('mentions adapter refuses malformed identities, unbounded ranges and nonsecond timestamps before requesting', async () => {
  let calls = 0;
  const client = createClient({ apiKey: 'secret', fetchImpl: async () => { calls++; } });
  const valid = { userName: 'entropyIO', sinceTime: 1793491200, untilTime: 1793577600 };
  for (const changes of [{ userName: '@entropyIO' }, { userName: 'entropy IO' }, { userName: 'x'.repeat(16) },
    { sinceTime: undefined }, { untilTime: null }, { sinceTime: '1793491200' }, { sinceTime: 1793491200000 },
    { sinceTime: 1793491200.5 }, { untilTime: 99999999999 }, { sinceTime: 99999999 }, { untilTime: valid.sinceTime },
    { sinceTime: valid.untilTime + 1 }, { cursor: null }, { cursor: 'x'.repeat(20001) }]) {
    await assert.rejects(client.mentionsPage({ ...valid, ...changes }), { code: 'INVALID_INPUT' });
  }
  assert.equal(calls, 0);
});
test('mentions pagination validates continuation and redacts provider failures without automatic retries', async () => {
  const input = { userName: 'entropyIO', sinceTime: 1793491200, untilTime: 1793577600, cursor: 'current' };
  for (const [body, code] of [[{ tweets: [], has_next_page: true, next_cursor: 'current' }, 'INVALID_RESPONSE'],
    [{ tweets: [], has_next_page: true, next_cursor: '' }, 'INVALID_RESPONSE'], [{ tweets: [], has_next_page: 'true' }, 'INVALID_RESPONSE'],
    [{ tweets: null, has_next_page: false }, 'INVALID_RESPONSE'], [{ status: 'error', msg: 'SECRET_PROVIDER_KEY' }, 'PROVIDER_ERROR']]) {
    let calls = 0;
    const client = createClient({ apiKey: 'secret', fetchImpl: async () => { calls++; return response(body); } });
    await assert.rejects(client.mentionsPage(input), error => error.code === code && !JSON.stringify(error).includes('SECRET'));
    assert.equal(calls, 1);
  }
  const client = createClient({ apiKey: 'secret', fetchImpl: async () => response({ tweets: [], has_next_page: false, next_cursor: 'ignored' }) });
  assert.deepEqual(await client.mentionsPage(input), { tweets: [], hasNextPage: false, nextCursor: null });
});
test('timeouts are bounded, default to 30s and can explicitly allow 65s', async () => {
  for (const timeoutMs of [0, -1, 65001, 1.5, NaN, '65000', null]) {
    assert.throws(() => createClient({ apiKey: 'secret', timeoutMs }), { code: 'INVALID_INPUT' });
  }
  const original = AbortSignal.timeout, durations = [];
  AbortSignal.timeout = value => { durations.push(value); return new AbortController().signal; };
  try {
    for (const options of [{}, { timeoutMs: 65000 }, { timeoutMs: 1 }]) {
      await createClient({ apiKey: 'secret', ...options, fetchImpl: async (_url, init) => {
        assert.ok(init.signal instanceof AbortSignal);
        return response({ tweets: [], has_next_page: false });
      } }).searchPage({ query: '@entropyIO' });
    }
  } finally { AbortSignal.timeout = original; }
  assert.deepEqual(durations, [30000, 65000, 1]);
});
test('timeout and abort failures expose a fixed code without raw cause or credentials', async () => {
  for (const name of ['TimeoutError', 'AbortError', 'Error']) {
    for (const duringBody of [false, true]) {
      const failure = Object.assign(new Error('SECRET_KEY_BODY_AND_URL'), { name, cause: 'SECRET_CAUSE' });
      const client = createClient({ apiKey: 'SECRET_KEY', fetchImpl: async () => {
        if (!duringBody) throw failure;
        return { ok: true, status: 200, json: async () => { throw failure; } };
      } });
      await assert.rejects(client.searchPage({ query: '@entropyIO' }), error => {
        assert.equal(error.code, name === 'Error' ? duringBody ? 'INVALID_RESPONSE' : 'NETWORK_ERROR' : 'REQUEST_TIMEOUT');
        assert.equal(error.cause, undefined); assert.ok(!JSON.stringify(error).includes('SECRET'));
        assert.ok(!error.message.includes('SECRET')); return true;
      });
    }
  }
});
test('redirect responses are rejected without following or exposing the destination', async () => {
  let calls=0;
  const client=createClient({apiKey:'secret',fetchImpl:async (url,init)=>{
    calls++;assert.equal(init.redirect,'manual');assert.equal(url.origin,'https://api.twitterapi.io');
    return {ok:false,status:302,headers:new Headers({Location:'https://untrusted.example/secret'})};
  }});
  await assert.rejects(client.searchPage({query:'@entropyIO'}),error=>error.code==='HTTP_ERROR'&&error.status===302&&!error.message.includes('untrusted')&&!error.message.includes('secret'));
  assert.equal(calls,1);
});
test('default fetch keeps its global receiver and uses Workers-compatible redirect mode', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async function (url,init) {
    assert.equal(this,globalThis);assert.equal(init.redirect,'manual');
    return response({tweets:[],has_next_page:false,next_cursor:''});
  };
  try { const page=await createClient({apiKey:'secret'}).searchPage({query:'@entropyIO'});assert.equal(page.hasNextPage,false); }
  finally { globalThis.fetch=original; }
});
test('by-ID refresh matches exact string IDs, tolerates missing and empty-ID unavailable entries', async () => {
  const wanted = ['2113234760927494175', '2113234760927494176'];
  const client = createClient({ apiKey: 'secret', fetchImpl: async url => {
    assert.equal(url.pathname, '/twitter/tweets'); assert.equal(url.searchParams.get('tweet_ids'), wanted.join(','));
    return response({ status: 'success', tweets: [{ id: '' }, fixture({ id: wanted[1] })] });
  } });
  const result = await client.tweetsByIds(wanted);
  assert.deepEqual(result.missingIds, [wanted[0]]); assert.equal(result.tweets[0].id, wanted[1]); assert.equal(result.unavailableEntries, 1);
});
test('by-ID refuses numeric IDs and >50 IDs before making a request', async () => {
  let calls = 0;
  const client = createClient({ apiKey: 'secret', fetchImpl: async () => { calls++; return response({ tweets: [] }); } });
  await assert.rejects(client.tweetsByIds([2113234760927494175]), { code: 'INVALID_INPUT' });
  await assert.rejects(client.tweetsByIds(Array.from({ length: 51 }, (_, i) => String(i + 1))), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
});
test('by-ID refuses unrequested or duplicate response IDs', async () => {
  for (const tweets of [[fixture({ id: '9' })], [fixture(), fixture()]]) {
    const client = createClient({ apiKey: 'secret', fetchImpl: async () => response({ tweets }) });
    await assert.rejects(client.tweetsByIds(['2113234760927494175']), { code: 'INVALID_RESPONSE' });
  }
});
test('HTTP and provider errors are redacted and never retried', async () => {
  for (const [payload, code] of [[{ ok: false, status: 429 }, 'RATE_LIMITED'], [{ ok: false, status: 402 }, 'CREDITS_EXHAUSTED'], [response({ status: 'error', msg: 'secret' }), 'PROVIDER_ERROR'], [response({ error: 'secret' }), 'PROVIDER_ERROR']]) {
    let calls = 0;
    const client = createClient({ apiKey: 'secret', fetchImpl: async () => { calls++; return payload; } });
    await assert.rejects(client.searchPage({ query: 'Entropy' }), error => error instanceof TwitterApiError && error.code === code && !error.message.includes('secret'));
    assert.equal(calls, 1);
  }
});
test('network, invalid JSON and malformed response fail without leaking input', async () => {
  for (const fetchImpl of [async () => { throw new Error('secret'); }, async () => ({ ok: true, json: async () => { throw new Error('secret'); } }), async () => response({ tweets: null })]) {
    const client = createClient({ apiKey: 'secret', fetchImpl });
    await assert.rejects(client.searchPage({ query: 'Entropy' }), error => !error.message.includes('secret'));
  }
  assert.throws(() => createClient({ apiKey: 'bad\r\nheader' }), { code: 'INVALID_INPUT' });
});
test('normalization creates a valid dataset with exact IDs, UTC dates and raw counts', () => {
  const data = Model.validateDataset(normalizeTweets([fixture()], options));
  assert.equal(data.authors[0].id, '1234567890123456789'); assert.equal(data.posts[0].id, '2113234760927494175');
  assert.equal(data.posts[0].publishedAt, '2026-11-17T09:30:00.000Z'); assert.equal(data.posts[0].metrics.impressions, 100);
  assert.equal(data.posts[0].metrics.likes, 0); assert.equal(data.meta.coverage, 'partial');
  assert.equal(data.authors[0].smartFollowersComplete, false); assert.deepEqual(data.accounts, []);
});
test('missing values stay unknown, including followers; canonical numeric count strings are parsed', () => {
  const tweet = fixture({ viewCount: '100', likeCount: undefined, quoteCount: null, author: { id: '123', userName: 'creator' } });
  const data = normalizeTweets([tweet], options);
  assert.equal(data.posts[0].metrics.impressions, 100); assert.equal(data.posts[0].metrics.likes, null);
  assert.equal(data.posts[0].metrics.quotes, null); assert.equal(data.authors[0].followers, null);
});
test('repost wrappers are excluded; original quote posts retain their own metrics', () => {
  const quote = fixture({ id: '222', quoted_tweet: { id: '999', viewCount: 1000000 } });
  const data = normalizeTweets([fixture({ isRetweet: true }), fixture({ retweeted_tweet: { id: '999' } }), quote], options);
  assert.equal(data.posts.length, 1); assert.equal(data.posts[0].id, '222'); assert.equal(data.posts[0].metrics.impressions, 100);
  assert.equal(data.meta.diagnostics.excludedReposts, 2); assert.equal(data.posts[0].isQuote, true);
});
test('duplicates never sum views; conversation IDs never become automatic work IDs', () => {
  const first = fixture({ conversationId: '999' });
  const second = fixture({ id: '222', conversationId: '999' });
  const data = normalizeTweets([first, second, first], options);
  assert.equal(data.posts.length, 2); assert.equal(data.meta.diagnostics.duplicates, 1);
  assert.equal(data.posts[0].conversationId, '999'); assert.equal(data.posts[0].workId, undefined);
});
test('malformed row identity, dates, text and metric counts are rejected', () => {
  for (const tweet of [null, fixture({ id: 2113234760927494175 }), fixture({ author: {} }), fixture({ createdAt: '2026-11-17T09:30:00' }), fixture({ likeCount: -1 }), fixture({ viewCount: '9007199254740993' }), fixture({ quoteCount: 1.2 }), fixture({ text: {} })]) {
    assert.throws(() => normalizeTweets([tweet], options), { code: 'INVALID_INPUT' });
  }
});
test('UTC period is half-open and an empty result retains requested bounds', () => {
  const data = normalizeTweets([fixture({ createdAt: '2026-12-01T00:00:00Z' })], options);
  assert.equal(data.posts.length, 0); assert.equal(data.meta.diagnostics.outsidePeriod, 1);
  assert.equal(data.meta.periodStart, options.periodStart); assert.equal(data.meta.periodEndExclusive, options.periodEndExclusive);
  assert.throws(() => normalizeTweets([], { ...options, periodStart: '2026-02-30' }), { code: 'INVALID_INPUT' });
});


test('reply source facts are retained and absent isReply stays unknown rather than verified original', () => {
  const values = normalizeTweets([fixture({ id: '111', isReply: true, inReplyToId: '99' }), fixture({ id: '222', isReply: false, inReplyToId: '99' }), fixture({ id: '333' })], { observedAt: '2026-11-17T12:00:00Z' });
  assert.equal(values.posts[0].isReply, true); assert.equal(values.posts[0].inReplyToId, '99');
  assert.equal(values.posts[1].isReply, false); assert.equal(values.posts[1].inReplyToId, '99'); assert.equal(values.posts[2].isReply, null);
});

test('raw expanded URLs and quoted official identity become persisted relevance before source fields are reduced', () => {
  const data = normalizeTweets([
    fixture({ id: '100', text: 'Read my notes', entities: { urls: [{ expanded_url: 'https://pro.entropy.io/?r=creator' }] } }),
    fixture({ id: '101', text: 'This is useful', quoted_tweet: { id: '123', author: { userName: 'entropyIO' } } }),
    fixture({ id: '102', text: 'Entropy looks interesting' }),
  ], options);
  assert.equal(data.posts[0].relevance.status, 'accepted'); assert.ok(data.posts[0].relevance.signals.includes('official_domain'));
  assert.equal(data.posts[1].relevance.status, 'accepted'); assert.ok(data.posts[1].relevance.signals.includes('official_quote'));
  assert.equal(data.posts[2].relevance.status, 'review');
  const roundTrip = Model.validateDataset(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(roundTrip.posts.map(post => post.relevance), data.posts.map(post => post.relevance));
});
