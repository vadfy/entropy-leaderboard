import test from 'node:test';
import assert from 'node:assert/strict';
import Model from './model.js';
import { mergeDataset, advanceSync, advanceHourlyDiscovery, classifySyncError, normalizeDiscoveryPage, DISCOVERY_QUERY_POLICY, DISCOVERY_LANES, discoveryQuery } from './live-engine.mjs';

const START = '2026-11-17T12:00:00.000Z';
const LATER = '2026-11-17T12:05:00.000Z';
const author = { id: '200', handle: 'creator', followers: 12, smartFollowersComplete: false, smartEngagementComplete: false };
const rawTweet = (id = '111', more = {}) => ({ id, text: 'Useful explanation of @entropyIO', createdAt: '2026-11-01T12:00:00Z',
  author: { id: '200', userName: 'creator', name: 'Creator', followers: 12 },
  viewCount: 100, likeCount: 3, retweetCount: 0, quoteCount: 1, replyCount: 1, ...more });
const post = (id = '111', more = {}) => ({ id, authorId: '200', authorHandle: 'creator', date: '2026-11-01', publishedAt: '2026-11-01T12:00:00.000Z',
  url: 'https://x.com/creator/status/' + id, body: 'Useful explanation of @entropyIO', workId: null,
  metrics: { impressions: 100, likes: 3, reposts: 0, uiReposts: null, quotes: 1, replies: 1, bookmarks: null },
  metricsAsOf: '2026-11-17T10:00:00.000Z', ...more });
function data(posts = [post()], authors = [author], asOf = '2026-11-17T10:00:00.000Z') {
  return Model.validateDataset({ meta: { source: 'twitterapi.io', coverage: 'partial', asOf, periodStart: '2026-11-01', periodEndExclusive: '2026-12-01' }, authors, posts, accounts: [], followRelations: [], interactions: [] });
}
function wb(dataset = data(), sync = {}) { return { dataset, state: Model.initialState(), sync: { enabled: true, ...sync } }; }
function client(search, refresh) {
  return { searchPage: search || (async () => ({ tweets: [], hasNextPage: false, nextCursor: null })),
    tweetsByIds: refresh || (async () => ({ tweets: [], missingIds: [] })) };
}

test('incremental merge retains absent posts, manual work grouping and smart source data', () => {
  const before = data([post('111', { workId: 'thread:manual' }), post('112')]);
  before.authors[0].smartFollowersComplete = true;
  before.accounts = [{ id: '300', trust: 1, reason: 'Reviewed person', evidence: [{ url: 'https://x.com/person' }] }];
  before.followRelations = [{ authorId: '200', accountId: '300', confirmed: true }];
  before.interactions = [{ authorId: '200', accountId: '300', postId: '111', type: 'quote', meaningful: true, occurredAt: '2026-11-02T12:00:00Z' }];
  const incoming = data([post('111', { metrics: { impressions: 150, likes: null } })], [{ ...author, followers: null }], START);
  const untouched = structuredClone(before), merged = mergeDataset(before, incoming);
  assert.equal(merged.posts.length, 2); assert.equal(merged.posts[0].workId, 'thread:manual');
  assert.equal(merged.posts[0].metrics.likes, 3); assert.equal(merged.authors[0].followers, 12);
  assert.equal(merged.authors[0].smartFollowersComplete, true);
  assert.deepEqual(merged.accounts, before.accounts); assert.deepEqual(merged.followRelations, before.followRelations); assert.deepEqual(merged.interactions, before.interactions);
  assert.deepEqual(before, untouched); assert.equal(merged.meta.coverage, 'partial');
});
test('null counts retain old timestamps; genuine newer decreases replace counts and are flagged', () => {
  const previous = data();
  const incoming = data([post('111', { metrics: { impressions: 80, likes: null }, metricsAsOf: START })], [author], START);
  const merged = mergeDataset(previous, incoming), p = merged.posts[0];
  assert.equal(p.metrics.impressions, 80); assert.equal(p.metrics.likes, 3);
  assert.equal(p.metricsObservedAt.impressions, START); assert.equal(p.metricsObservedAt.likes, previous.posts[0].metricsAsOf);
  assert.equal(p.metricsAsOf, previous.posts[0].metricsAsOf);
  assert.equal(p.metricCorrections[0].field, 'impressions'); assert.equal(p.metricCorrections[0].previous, 100);
  assert.ok(p.missingInLatest.includes('likes'));
});
test('older observations cannot overwrite more recent counters', () => {
  const old = data([post('111', { metrics: { impressions: 900 }, metricsAsOf: '2026-11-17T09:00:00Z' })], [author], START);
  const merged = mergeDataset(data(), old);
  assert.equal(merged.posts[0].metrics.impressions, 100); assert.equal(merged.posts[0].metricCorrections.length, 0);
});
test('post-backed identity mapping remaps all old work and smart relationships, never canonical owners', () => {
  const previous = data([post('111', { authorId: 'sample:creator' }), post('112', { authorId: 'sample:creator' })], [{ ...author, id: 'sample:creator' }]);
  previous.followRelations = [{ authorId: 'sample:creator', accountId: '300', confirmed: true }];
  previous.interactions = [{ authorId: 'sample:creator', accountId: '300', postId: '112', type: 'reply' }];
  const merged = mergeDataset(previous, data());
  assert.deepEqual(merged.authors.map(a => a.id), ['200']); assert.ok(merged.posts.every(p => p.authorId === '200'));
  assert.equal(merged.followRelations[0].authorId, '200'); assert.equal(merged.interactions[0].authorId, '200');
  const conflict = data([post('111', { authorId: '999' })], [{ ...author, id: '999' }]);
  assert.throws(() => mergeDataset(data(), conflict), /ownership/);
});
test('disabled, not-due and zero-budget ticks make no provider requests', async () => {
  let calls = 0; const provider = client(async () => { calls++; throw new Error('Unexpected'); });
  await advanceSync(wb(data(), { enabled: false }), { client: provider, now: START });
  await advanceSync(wb(data(), { nextRunAt: LATER }), { client: provider, now: START });
  await advanceSync(wb(), { client: provider, now: START, maxRequests: 0 });
  assert.equal(calls, 0);
});
test('an immediate millisecond-precision schedule is due at that same instant', async () => {
  const now = '2026-11-17T12:00:00.750Z'; let calls = 0;
  const result = await advanceSync(wb(data([], []), { nextRunAt: now }), { now, client: client(async () => {
    calls++; return { tweets: [], hasNextPage: false, nextCursor: null };
  }) });
  assert.equal(calls, 1); assert.equal(result.sync.lastAttemptAt, now);
  assert.equal(result.sync.nextRunAt, '2026-11-17T12:05:00.750Z');
});
test('first discovery finds fresh mentions while retaining the entire UTC month backlog', async () => {
  const calls = [];
  const result = await advanceSync(wb(data([], [])), { now: START, maxRequests: 99, client: client(async args => {
    calls.push(args); return { tweets: [rawTweet('111', { createdAt: '2026-11-17T11:45:00Z' })], hasNextPage: true, nextCursor: 'opaque-1' };
  }) });
  assert.equal(calls.length, 1); assert.equal(calls[0].query, '@entropyIO since_time:' + Date.parse('2026-11-17T11:30:00Z') / 1000 + ' until_time:' + Date.parse(START) / 1000);
  assert.equal(result.sync.discovery.recentWindow.cursor, 'opaque-1');
  assert.equal(result.sync.discovery.pendingWindows[0].start, '2026-11-01T00:00:00.000Z');
  assert.equal(result.sync.discovery.pendingWindows.length, 17);
  assert.equal(result.sync.discovery.coveredThrough, null); assert.equal(result.sync.requestCount, 1);
  assert.equal(result.sync.lastSuccessAt, START); assert.equal(result.dataset.posts.length, 1);
});
test('recent cursor resumes across metric refresh and a backfill turn without losing either queue', async () => {
  const calls = [], observed = new Map(); let recentPages = 0;
  const provider = client(async args => {
    calls.push(args);
    if (args.query.includes('since_time:1793491200 ')) return { tweets: [], hasNextPage: false, nextCursor: null };
    recentPages++;
    const tweet = rawTweet(String(110 + recentPages), { createdAt: recentPages === 1 ? '2026-11-17T11:50:00Z' : '2026-11-17T11:40:00Z' });
    observed.set(tweet.id, tweet);
    return { tweets: [tweet], hasNextPage: recentPages === 1, nextCursor: recentPages === 1 ? 'resume-me' : null };
  }, async ids => ({ tweets: ids.map(id => observed.get(id)), missingIds: [] }));
  let result = await advanceSync(wb(data([], [])), { client: provider, now: START });
  const queued = result.sync.discovery.pendingWindows.length;
  result = await advanceSync(result, { client: provider, now: LATER });
  assert.equal(result.sync.phase, 'discovery'); assert.equal(result.sync.discovery.pendingWindows.length, queued);
  result = await advanceSync(result, { client: provider, now: '2026-11-17T12:10:00Z' });
  assert.equal(result.sync.discovery.recentWindow.cursor, 'resume-me');
  assert.equal(result.sync.discovery.pendingWindows.length, queued - 1); assert.equal(result.sync.discovery.coveredThrough, '2026-11-02T00:00:00.000Z');
  result = await advanceSync(result, { client: provider, now: '2026-11-17T12:15:00Z' });
  result = await advanceSync(result, { client: provider, now: '2026-11-17T12:20:00Z' });
  assert.equal(calls[2].cursor, 'resume-me'); assert.equal(calls[2].query, calls[0].query);
  assert.equal(result.sync.discovery.recentThrough, START); assert.equal(result.sync.discovery.recentWindow, null);
  assert.equal(result.sync.discovery.pendingWindows.length, queued - 1);
  assert.equal(result.dataset.posts.length, 2);
});
test('subsequent discovery overlaps five minutes instead of rescanning the month', async () => {
  let query;
  const result = await advanceSync(wb(data([], []), { discovery: { pendingWindows: [], coveredThrough: '2026-11-17T11:55:00.000Z' } }), {
    now: START, client: client(async args => { query = args.query; return { tweets: [], hasNextPage: false, nextCursor: null }; }) });
  assert.ok(query.includes('since_time:' + Date.parse('2026-11-17T11:50:00Z') / 1000));
  assert.equal(result.sync.discovery.coveredThrough, START);
});
test('raw search candidates must directly mention target, belong to the time window, and not be own/repost work', async () => {
  const valid = rawTweet('111', { createdAt: '2026-11-17T11:45:00Z' });
  const other = rawTweet('112', { createdAt: valid.createdAt, text: 'About @entropyIOOther' });
  const outside = rawTweet('113', { createdAt: START });
  const own = rawTweet('114', { createdAt: valid.createdAt, author: { id: '100', userName: 'entropyIO', followers: 4 } });
  const repost = rawTweet('115', { createdAt: valid.createdAt, isRetweet: true, retweeted_tweet: { id: '1' } });
  const result = await advanceSync(wb(data([], [])), { now: START, client: client(async () => ({ tweets: [valid, other, outside, own, repost], hasNextPage: false, nextCursor: null })) });
  assert.deepEqual(result.dataset.posts.map(p => p.id), ['111']); assert.equal(result.dataset.authors.length, 1);
});
test('unavailable by-ID posts preserve metrics and moderation, and are flagged for review', async () => {
  const before = wb(data(), { phase: 'refresh', requestCount: 1 });
  before.state = Model.decision(before.state, { type: 'ban', authorId: '200', periodKey: '2026-11', reason: 'Visible reason', internalNote: 'PRIVATE_NOTE' }, START);
  const result = await advanceSync(before, { now: START, client: client(null, async () => ({ tweets: [], missingIds: ['111'] })) });
  assert.equal(result.dataset.posts[0].metrics.impressions, 100); assert.equal(result.dataset.posts[0].availability.status, 'unavailable');
  assert.equal(result.state.bans['200'].reason, 'Visible reason'); assert.equal(result.state.bans['200'].internalNote, 'PRIVATE_NOTE');
  assert.ok(result.sync.gaps.some(g => g.code === 'POSTS_UNAVAILABLE')); assert.equal(result.sync.lastSuccessAt, START);
});
test('regular refresh batches are bounded to twenty IDs and queue persists the remainder', async () => {
  const posts = Array.from({ length: 65 }, (_, i) => post(String(1000 + i)));
  let batch;
  const result = await advanceSync(wb(data(posts), { phase: 'refresh', requestCount: 1 }), { now: START, client: client(null, async ids => { batch = ids; return { tweets: [], missingIds: ids }; }) });
  assert.equal(batch.length, 20); assert.equal(result.sync.refresh.pendingIds.length, 45); assert.equal(result.dataset.posts.length, 65);
});
test('failed metric batches preserve the entire backlog and give recent discovery the next due turn', async () => {
  const pendingIds = Array.from({ length: 65 }, (_, i) => String(1000 + i));
  for (const failure of [Object.assign(new Error('PRIVATE'), { name: 'TimeoutError' }),
    Object.assign(new Error('PRIVATE'), { code: 'REQUEST_TIMEOUT' }), Object.assign(new Error('PRIVATE'), { code: 'NETWORK_ERROR' }),
    Object.assign(new Error('PRIVATE'), { status: 429 }), Object.assign(new Error('PRIVATE'), { status: 503 }),
    Object.assign(new Error('PRIVATE'), { code: 'INVALID_RESPONSE' })]) {
    const before = wb(data(pendingIds.map(id => post(id))), { phase: 'refresh', requestCount: 1,
      refresh: { pendingIds, cycleStartedAt: START }, discovery: { pendingWindows: [
        { start: '2026-11-01T00:00:00Z', endExclusive: '2026-11-02T00:00:00Z', cursor: 'historical', seenCursors: [], previousOldest: null }
      ], nextLane: 'backfill', coveredThrough: null } });
    let attempts = 0;
    const result = await advanceSync(before, { now: START, client: client(null, async ids => {
      attempts++; assert.deepEqual(ids, pendingIds.slice(0, 20)); throw failure;
    }) });
    assert.equal(attempts, 1); assert.equal(result.sync.phase, 'discovery'); assert.equal(result.sync.discovery.nextLane, 'recent');
    assert.deepEqual(result.sync.refresh.pendingIds, pendingIds); assert.equal(result.sync.refresh.cycleStartedAt, START);
    assert.equal(result.sync.discovery.pendingWindows[0].cursor, 'historical');
    assert.deepEqual(result.dataset, before.dataset); assert.equal(result.sync.paused, false);
    assert.ok(Date.parse(result.sync.nextRunAt) > Date.parse(START)); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test('recent mentions progress after a metrics timeout, then the smaller metric queue resumes normally', async () => {
  const pendingIds = Array.from({ length: 65 }, (_, i) => String(1000 + i)), calls = [];
  let refreshAttempts = 0;
  const provider = client(async args => {
    calls.push('discovery'); assert.ok(args.query.includes('since_time:1794915000'));
    return { tweets: [rawTweet('9999', { createdAt: '2026-11-17T11:45:00Z' })], hasNextPage: false, nextCursor: null };
  }, async ids => {
    calls.push('refresh'); refreshAttempts++; assert.deepEqual(ids, pendingIds.slice(0, 20));
    if (refreshAttempts === 1) throw Object.assign(new Error('PRIVATE'), { code: 'REQUEST_TIMEOUT' });
    return { tweets: ids.map(id => rawTweet(id)), missingIds: [] };
  });
  let result = await advanceSync(wb(data(pendingIds.map(id => post(id))), { phase: 'refresh', requestCount: 1,
    refresh: { pendingIds, cycleStartedAt: START } }), { now: START, client: provider });
  assert.deepEqual(result.sync.refresh.pendingIds, pendingIds);
  result = await advanceSync(result, { now: LATER, client: provider });
  assert.equal(result.sync.phase, 'refresh'); assert.equal(result.sync.lastError, null);
  assert.ok(result.dataset.posts.some(value => value.id === '9999')); assert.deepEqual(result.sync.refresh.pendingIds, pendingIds);
  result = await advanceSync(result, { now: '2026-11-17T12:10:00Z', client: provider });
  assert.deepEqual(calls, ['refresh', 'discovery', 'refresh']); assert.equal(result.sync.phase, 'discovery');
  assert.deepEqual(result.sync.refresh.pendingIds, pendingIds.slice(20)); assert.equal(result.dataset.posts.length, 66);
});
test('auth or credit failure during metrics refresh retains pending IDs and still pauses collection', async () => {
  for (const status of [401, 402, 403]) {
    const result = await advanceSync(wb(data(), { phase: 'refresh', requestCount: 1,
      refresh: { pendingIds: ['111'], cycleStartedAt: START } }), { now: START,
      client: client(null, async () => { throw Object.assign(new Error('PRIVATE'), { status }); }) });
    assert.equal(result.sync.paused, true); assert.equal(result.sync.status, 'paused');
    assert.deepEqual(result.sync.refresh.pendingIds, ['111']);
    let calls = 0;
    await advanceSync(result, { now: LATER, client: client(async () => { calls++; }, async () => { calls++; }) });
    assert.equal(calls, 0);
  }
});
test('first tick resolves temporary sample identities through immutable posts and preserves bans', async () => {
  const previous = data([post('111', { authorId: 'sample:creator' }), post('112', { authorId: 'sample:creator' })], [{ ...author, id: 'sample:creator' }]);
  const before = wb(previous);
  before.state = Model.decision(before.state, { type: 'ban', authorId: 'sample:creator', periodKey: '2026-11', reason: 'Visible reason', internalNote: 'PRIVATE_NOTE' }, START);
  let searches = 0;
  const result = await advanceSync(before, { now: START, client: client(async () => { searches++; }, async ids => ({ tweets: ids.map(id => rawTweet(id)), missingIds: [] })) });
  assert.equal(searches, 0); assert.equal(result.sync.lastError, null); assert.ok(result.state.bans['200']);
  assert.equal(result.state.bans['sample:creator'], undefined); assert.equal(result.dataset.authors[0].id, '200');
  const publicView = Model.creatorView(result.dataset, result.state, '200', Model.periodFor('2026-11', result.dataset));
  assert.equal(publicView.status, 'banned'); assert.ok(!JSON.stringify(publicView).includes('PRIVATE_NOTE'));
});
test('provider errors preserve data and checkpoint, count the attempt, and redact secrets', async () => {
  const before = wb(data(), { discovery: { pendingWindows: [{ start: '2026-11-01T00:00:00Z', endExclusive: '2026-11-02T00:00:00Z', cursor: 'saved', previousOldest: null, seenCursors: [] }], coveredThrough: null } });
  const untouched = structuredClone(before);
  const result = await advanceSync(before, { now: START, client: client(async () => { const error = new Error('SECRET_PROVIDER_KEY'); error.status = 429; throw error; }) });
  assert.deepEqual(result.dataset, untouched.dataset); assert.deepEqual(result.state, untouched.state); assert.deepEqual(before, untouched);
  assert.equal(result.sync.discovery.pendingWindows[0].cursor, 'saved'); assert.equal(result.sync.lastSuccessAt, null); assert.equal(result.sync.requestCount, 1);
  assert.equal(result.sync.lastError.code, 'RATE_LIMITED'); assert.equal(result.sync.lastError.httpStatus, 429); assert.equal(result.sync.lastError.diagnosticCode, 'HTTP_ERROR'); assert.ok(!JSON.stringify(result).includes('SECRET_PROVIDER_KEY'));
  let calls = 0;
  await advanceSync(result, { now: '2026-11-17T12:01:00Z', client: client(async () => { calls++; }) }); assert.equal(calls, 0);
});
test('invalid keys or exhausted credits pause collection until explicit resume', async () => {
  for (const status of [401, 402, 403]) {
    const result = await advanceSync(wb(), { now: START, client: client(async () => { const e = new Error('ignored'); e.status = status; throw e; }) });
    assert.equal(result.sync.paused, true); assert.equal(result.sync.status, 'paused');
    let calls = 0;
    await advanceSync(result, { now: '2026-11-18T00:00:00Z', client: client(async () => { calls++; }) }); assert.equal(calls, 0);
  }
});
test('malformed records or identity conflicts cannot commit a page or advance its cursor', async () => {
  const before = wb(data(), { discovery: { pendingWindows: [{ start: '2026-11-01T00:00:00Z', endExclusive: '2026-11-02T00:00:00Z', cursor: '', previousOldest: null, seenCursors: [] }], nextLane: 'backfill', coveredThrough: null } });
  const result = await advanceSync(before, { now: START, client: client(async () => ({ tweets: [rawTweet('111', { author: { id: '999', userName: 'other' } })], hasNextPage: true, nextCursor: 'unsafe-next' })) });
  assert.deepEqual(result.dataset, before.dataset); assert.equal(result.sync.discovery.pendingWindows[0].cursor, ''); assert.equal(result.sync.lastError.code, 'SYNC_FAILED');
  assert.equal(result.sync.lastError.diagnosticCode, 'POST_OWNERSHIP_CONFLICT');
});
test('empty continuation is a retained coverage gap, never an exhausted window', async () => {
  const result = await advanceSync(wb(data([], [])), { now: START, client: client(async () => ({ tweets: [], hasNextPage: true, nextCursor: 'maybe-more' })) });
  assert.equal(result.sync.discovery.coveredThrough, null); assert.equal(result.sync.discovery.pendingWindows[0].cursor, '');
  assert.equal(result.sync.gaps[0].code, 'EMPTY_CONTINUATION'); assert.equal(result.dataset.meta.coverage, 'partial');
});
test('UTC month rollover polls recent mentions and retains unfinished earlier windows for their next turn', async () => {
  const queries = [];
  const before = wb(data([], []), { discovery: { pendingWindows: [{ start: '2026-11-30T00:00:00Z', endExclusive: '2026-12-01T00:00:00Z', cursor: '', previousOldest: null, seenCursors: [] }], coveredThrough: '2026-11-30T00:00:00Z' } });
  const provider = client(async args => { queries.push(args.query); return { tweets: [], hasNextPage: false, nextCursor: null }; });
  let result = await advanceSync(before, { now: '2026-12-01T00:05:00Z', client: provider });
  assert.equal(result.sync.discovery.pendingWindows.length, 1);
  assert.equal(result.sync.discovery.coveredThrough, '2026-11-30T00:00:00Z');
  result = await advanceSync(result, { now: '2026-12-01T00:10:00Z', client: provider });
  assert.ok(queries[1].includes('since_time:' + Date.parse('2026-11-30T00:00:00Z') / 1000));
  assert.equal(result.sync.discovery.pendingWindows.length, 0);
  assert.equal(result.sync.discovery.coveredThrough, '2026-12-01T00:05:00.000Z');
});

test('fresh discovery and historical pages both progress under a strict one-call tick budget', async () => {
  const searches = [], observed = new Map(); let calls = 0;
  const provider = client(async args => {
    calls++; searches.push(args);
    const since = Number(args.query.match(/since_time:(\d+)/)[1]) * 1000;
    const until = Number(args.query.match(/until_time:(\d+)/)[1]) * 1000;
    if (since < Date.parse('2026-11-17T00:00:00Z')) return { tweets: [], hasNextPage: false, nextCursor: null };
    const tweet = rawTweet(String(2000 + calls), { createdAt: new Date(until - 60000).toISOString() }); observed.set(tweet.id, tweet);
    return { tweets: [tweet], hasNextPage: false, nextCursor: null };
  }, async ids => { calls++; return { tweets: ids.map(id => observed.get(id)), missingIds: [] }; });
  let result = wb(data([], []));
  for (let tick = 0; tick < 12; tick++) {
    const previousCalls = calls;
    result = await advanceSync(result, { now: new Date(Date.parse(START) + tick * 300000).toISOString(), maxRequests: 99, client: provider });
    assert.equal(calls - previousCalls, 1);
  }
  const recentSearches = searches.filter(s => Number(s.query.match(/since_time:(\d+)/)[1]) >= Date.parse('2026-11-17T00:00:00Z') / 1000);
  const oldSearches = searches.filter(s => !recentSearches.includes(s));
  assert.equal(recentSearches.length, 3); assert.equal(oldSearches.length, 3);
  assert.equal(result.sync.discovery.pendingWindows.length, 14);
  assert.equal(result.sync.discovery.coveredThrough, '2026-11-04T00:00:00.000Z');
  assert.ok(result.dataset.posts.some(p => p.publishedAt > LATER));
  assert.equal(result.dataset.meta.coverage, 'partial');
});

test('recent coverage cannot jump an unresolved historical gap after a long outage', async () => {
  const before = wb(data([], []), { discovery: { pendingWindows: [{ start: '2026-11-01T00:00:00Z', endExclusive: '2026-11-02T00:00:00Z', cursor: '', previousOldest: null, seenCursors: [] }], coveredThrough: '2026-11-01T00:00:00Z' } });
  const provider = client(async () => ({ tweets: [], hasNextPage: false, nextCursor: null }));
  let result = await advanceSync(before, { now: '2026-12-10T12:00:00Z', client: provider });
  assert.equal(result.sync.discovery.coveredThrough, '2026-11-01T00:00:00Z');
  assert.equal(result.sync.discovery.recentThrough, '2026-12-10T12:00:00.000Z');
  result = await advanceSync(result, { now: '2026-12-10T12:05:00Z', client: provider });
  assert.equal(result.sync.discovery.coveredThrough, '2026-11-02T00:00:00Z');
});

test('safe diagnostics retain SDK codes and HTTP status without provider messages or stacks', async () => {
  for (const diagnosticCode of ['NETWORK_ERROR','REQUEST_TIMEOUT','INVALID_RESPONSE','PROVIDER_ERROR','INVALID_INPUT']) {
    const error = new Error('SECRET_PROVIDER_BODY_AND_KEY'); error.code = diagnosticCode; error.status = 503;
    const result = await advanceSync(wb(), { now: START, client: client(async () => { throw error; }) });
    assert.equal(result.sync.lastError.code, 'SYNC_FAILED'); assert.equal(result.sync.lastError.diagnosticCode, diagnosticCode);
    assert.equal(result.sync.lastError.httpStatus, 503); assert.ok(!JSON.stringify(result).includes('SECRET_PROVIDER_BODY_AND_KEY'));
    assert.ok(!('stack' in result.sync.lastError));
  }
  assert.deepEqual(classifySyncError(Object.assign(new Error('SECRET'), {code:'SECRET_UNKNOWN_CODE',status:999})), {diagnosticCode:'UNCLASSIFIED_ERROR'});
  for (const name of ['TimeoutError', 'AbortError']) {
    assert.deepEqual(classifySyncError(Object.assign(new Error('SECRET'), { name, cause: 'SECRET_CAUSE' })), { diagnosticCode: 'REQUEST_TIMEOUT' });
  }
});
test('normalization diagnostics expose only fixed allowed fields and never malformed values', async () => {
  for (const [extra, code, field] of [
    [{viewCount:'SECRET_COUNT_VALUE'},'INVALID_COUNT','viewCount'],
    [{author:{id:123,userName:'creator'}},'INVALID_AUTHOR',undefined],
    [{id:111},'INVALID_TWEET_ID',undefined],
    [{createdAt:'2026-11-01T12:00:00'},'MISSING_TIMEZONE',undefined],
    [{createdAt:'2026-99-01T12:00:00Z'},'INVALID_TIMESTAMP',undefined],
  ]) {
    const result = await advanceSync(wb(), { now: START, client: client(async () => ({tweets:[rawTweet('111',extra)],hasNextPage:false,nextCursor:null})) });
    assert.equal(result.sync.lastError.diagnosticCode,code); assert.equal(result.sync.lastError.diagnosticField,field);
    assert.equal(result.sync.lastError.httpStatus,null); assert.ok(!JSON.stringify(result.sync.lastError).includes('SECRET_COUNT_VALUE'));
  }
});
test('known merge and identity errors map to static diagnostics', () => {
  for (const [message,code] of [
    ['Post publication time conflict.','PUBLICATION_TIME_CONFLICT'],
    ['Ambiguous sample identity.','SAMPLE_IDENTITY_CONFLICT'],
    ['Суперечливі дублікати X Post ID.','DUPLICATE_POST'],
    ['Суперечливі імена одного автора у знімку.','AUTHOR_HANDLE_CONFLICT'],
    ['Імпорт зупинено: конфлікт ідентичності автора. PRIVATE_DETAIL','MODEL_IDENTITY_CONFLICT'],
  ]) {
    const result=classifySyncError(new Error(message)); assert.deepEqual(result,{diagnosticCode:code}); assert.ok(!JSON.stringify(result).includes('PRIVATE_DETAIL'));
  }
});

const emptyPage = () => ({ tweets: [], hasNextPage: false, nextCursor: null });
const hourTweet = (id, createdAt = '2026-11-17T11:45:00Z', extra = {}) => rawTweet(id, { createdAt, ...extra });
const hourlyClient = search => ({ searchPage: async ({ query, cursor }) => {
  assert.match(query, / -filter:replies -filter:nativeretweets since_time:\d+ until_time:\d+$/);
  return search({ userName: 'entropyIO', sinceTime: Number(query.match(/since_time:(\d+)/)[1]), untilTime: Number(query.match(/until_time:(\d+)/)[1]), cursor });
}, mentionsPage: async () => { throw new Error('Filtered discovery must use search.'); }, tweetsByIds: async () => { throw new Error('Discovery must not refresh metrics.'); } });
// These legacy regression assertions concern the reserved direct lane.
const activeWindows = result => result.sync.hourly.pendingWindows.filter(window => !window.audit && (window.discoveryLane || 'direct') === 'direct');
const hourlyState = extra => ({ queryPolicy: DISCOVERY_QUERY_POLICY, method: 'search', migratedLegacyRecent: true, lastAuditDay: '2026-11-17', pendingWindows: [], ...extra });
const frozenWindow = (start, endExclusive, extra = {}) => ({ id: 'test-window', queryPolicy: DISCOVERY_QUERY_POLICY, query: discoveryQuery(start, endExclusive), method: 'search', kind: 'recovery', start, endExclusive, cursor: '', previousOldest: null, seenCursors: [], observedPostIds: [], ...extra });

test('hourly latest uses filtered search before metrics, history and old cursors, retaining data and usage', async () => {
  const legacy = { start: '2026-11-10T22:00:00Z', endExclusive: '2026-11-10T23:00:00Z', cursor: 'old-search', seenCursors: ['old-search'], previousOldest: null };
  const before = wb(data([], []), { phase: 'refresh', requestCount: 50, refresh: { pendingIds: ['999'] }, discovery: { recentWindow: legacy, pendingWindows: [legacy] } });
  const calls = [];
  const result = await advanceHourlyDiscovery(before, { now: START, client: hourlyClient(async args => { calls.push(args); return { tweets: [hourTweet('5000')], hasNextPage: true, nextCursor: 'new-tail' }; }) });
  assert.deepEqual(calls, [{ userName: 'entropyIO', sinceTime: Date.parse('2026-11-17T10:55:00Z') / 1000, untilTime: Date.parse(START) / 1000, cursor: '' }]);
  assert.equal(result.dataset.posts.length, 1); assert.equal(result.sync.requestCount, 51);
  assert.deepEqual(result.sync.refresh.pendingIds, ['999']); assert.equal(result.sync.discovery.recentWindow.cursor, 'old-search');
  assert.ok(activeWindows(result).some(window => window.kind === 'legacy-recent' && window.cursor === '' && window.queryPolicy === DISCOVERY_QUERY_POLICY));
  assert.ok(activeWindows(result).some(window => window.cursor === 'new-tail')); assert.equal(result.sync.hourly.method, 'search');
  assert.equal(result.sync.hourly.lastSuccessAt, START); assert.equal(result.sync.hourly.completedThrough, null);
});

test('policy migration restarts old mentions and search cursors without carrying old completion proof', async () => {
  const old = { start: '2026-11-10T22:00:00Z', endExclusive: '2026-11-10T23:00:00Z', method: 'mentions', cursor: 'old-mentions', seenCursors: ['old-mentions'], previousOldest: null };
  const before = wb(data(), { requestCount: 80, hourly: { requestCount: 20, addedPosts: 4, completedThrough: START, completedRanges: [{ start: old.start, endExclusive: START }], pendingWindows: [old], migratedLegacyRecent: true } });
  const result = await advanceHourlyDiscovery(before, { now: START, client: hourlyClient(async () => emptyPage()) });
  const restored = result.sync.hourly.pendingWindows.find(window => Date.parse(window.start) === Date.parse(old.start));
  assert.equal(restored.method, 'search'); assert.equal(restored.cursor, ''); assert.deepEqual(restored.seenCursors, []);
  assert.match(restored.query, /-filter:replies/); assert.equal(result.sync.requestCount, 81); assert.equal(result.sync.hourly.requestCount, 21);
  assert.equal(result.sync.hourly.addedPosts, 4); assert.equal(result.dataset.posts.length, 1); assert.equal(result.sync.hourly.completedThrough, null);
  assert.equal(result.sync.hourly.policyHistory.at(-1).pendingWindows[0].hadCursor, true);
  assert.ok(!JSON.stringify(result.sync.hourly).includes('old-mentions'));
});

test('subsequent hourly calls start a fresh current window while older page tails remain resumable', async () => {
  const calls = [], provider = hourlyClient(async args => { calls.push(args); return { tweets: [hourTweet('500' + calls.length, new Date(args.untilTime * 1000 - 60000).toISOString())], hasNextPage: true, nextCursor: 'tail-' + calls.length }; });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:00Z', client: provider });
  assert.equal(calls.length, 2); assert.equal(calls[1].cursor, ''); assert.equal(calls[1].sinceTime, Date.parse('2026-11-17T11:55:00Z') / 1000);
  assert.ok(activeWindows(result).some(window => window.cursor === 'tail-1')); assert.ok(activeWindows(result).some(window => window.cursor === 'tail-2'));
  assert.equal(result.sync.hourly.latestPlannedThrough, '2026-11-17T13:00:00.000Z'); assert.equal(result.sync.hourly.completedThrough, null);
});

test('hourly disabled, paused, zero-budget and not-due calls make no provider request', async () => {
  let calls = 0; const provider = hourlyClient(async () => { calls++; return emptyPage(); });
  for (const sync of [{ enabled: false }, { paused: true }, { hourly: { nextRunAt: '2026-11-17T13:00:00Z' } }]) await advanceHourlyDiscovery(wb(data([], []), sync), { now: START, client: provider });
  await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider, maxRequests: 0 }); assert.equal(calls, 0);
});

test('catchup drains a frozen filtered cursor without relabelling latest success or moving its deadline', async () => {
  const calls = [], provider = hourlyClient(async args => { calls.push(args); return calls.length === 1
    ? { tweets: [hourTweet('5000')], hasNextPage: true, nextCursor: 'saved-tail' }
    : { tweets: [hourTweet('5001', '2026-11-17T11:10:00Z')], hasNextPage: false, nextCursor: null }; });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  const query = activeWindows(result)[0].query;
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:06Z', client: provider, lane: 'catchup' });
  assert.equal(calls[1].cursor, 'saved-tail'); assert.equal(result.dataset.posts.length, 2); assert.equal(activeWindows(result).length, 0);
  assert.equal(result.sync.hourly.lastSuccessAt, START); assert.equal(result.sync.hourly.catchupLastSuccessAt, '2026-11-17T12:00:06.000Z');
  assert.equal(result.sync.hourly.nextRunAt, '2026-11-17T13:00:00.000Z'); assert.equal(result.sync.nextRunAt, result.sync.hourly.nextRunAt);
  assert.equal(query, discoveryQuery('2026-11-17T10:55:00Z', START)); assert.equal(result.sync.hourly.completedThrough, null);
});

test('catchup observes spacing and empty queues do not make paid requests', async () => {
  let calls = 0; const provider = hourlyClient(async () => { calls++; return emptyPage(); });
  const result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:01Z', client: provider, lane: 'catchup' }); assert.equal(calls, 1);
  const empty = structuredClone(result); empty.sync.hourly.pendingWindows = [];
  await advanceHourlyDiscovery(empty, { now: LATER, client: provider, lane: 'catchup' }); assert.equal(calls, 1);
});

test('outages queue their missed interval while current-hour discovery still runs first', async () => {
  const before = wb(data([], []), { hourly: hourlyState({ latestPlannedThrough: START, coverageFrom: START, completedThrough: START }) });
  let called; const result = await advanceHourlyDiscovery(before, { now: '2026-11-20T12:00:00Z', client: hourlyClient(async args => { called = args; return emptyPage(); }) });
  assert.equal(called.sinceTime, Date.parse('2026-11-20T10:55:00Z') / 1000); assert.equal(called.untilTime, Date.parse('2026-11-20T12:00:00Z') / 1000);
  assert.equal(activeWindows(result)[0].start, START); assert.equal(activeWindows(result).at(-1).endExclusive, '2026-11-20T10:55:00.000Z');
  assert.equal(result.sync.hourly.completedThrough, START);
});

test('every sixth catchup attempt serves the oldest work, even if current pages fail', async () => {
  for (const failing of [false, true]) {
    const old = frozenWindow('2026-11-10T22:00:00Z', '2026-11-10T23:00:00Z', { cursor: 'saved-old', seenCursors: ['saved-old'] });
    const calls = []; let currentPages = 0;
    const provider = hourlyClient(async args => {
      if (args.sinceTime === Date.parse(old.start) / 1000) { calls.push(['old', args.cursor]); return emptyPage(); }
      calls.push(['current', args.cursor]); currentPages++;
      if (failing && currentPages > 1) throw Object.assign(new Error('SECRET'), { code: 'NETWORK_ERROR' });
      return { tweets: [hourTweet(String(6000 + currentPages), new Date(Date.parse(START) - currentPages * 60000).toISOString())], hasNextPage: true, nextCursor: 'tail-' + currentPages };
    });
    let result = await advanceHourlyDiscovery(wb(data([], []), { hourly: hourlyState({ pendingWindows: [old] }) }), { now: START, client: provider });
    for (let step = 1; step <= 6; step++) result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.nextAttemptAt, client: provider, lane: 'catchup' });
    assert.deepEqual(calls.map(value => value[0]), ['current', 'current', 'current', 'current', 'current', 'current', 'old']);
    assert.equal(calls.at(-1)[1], 'saved-old'); assert.equal(result.sync.hourly.catchupRequestCount, 6);
    assert.equal(result.sync.hourly.lastSuccessAt, START); assert.equal(result.sync.hourly.completedThrough, '2026-11-10T23:00:00.000Z');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('failed latest and maintenance requests preserve data and cannot delay next hourly discovery', async () => {
  let calls = 0; const provider = hourlyClient(async () => { calls++; if (calls === 1) throw Object.assign(new Error('SECRET'), { code: 'REQUEST_TIMEOUT' }); return emptyPage(); });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  assert.equal(activeWindows(result).length, 1); assert.equal(result.sync.hourly.lastSuccessAt, null); assert.equal(result.sync.hourly.lastError.diagnosticCode, 'REQUEST_TIMEOUT');
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:00Z', client: provider });
  assert.equal(calls, 2); assert.equal(activeWindows(result)[0].endExclusive, START); assert.equal(result.sync.hourly.lastError, null);
  assert.equal(result.sync.hourly.lastSuccessAt, '2026-11-17T13:00:00.000Z'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  const fresh = result.sync.hourly.lastSuccessAt;
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:06Z', lane: 'catchup', client: hourlyClient(async () => { throw Object.assign(new Error('SECRET'), { status: 503 }); }) });
  assert.equal(result.sync.hourly.lastSuccessAt, fresh); assert.equal(result.sync.nextRunAt, '2026-11-17T14:00:00.000Z'); assert.equal(result.sync.hourly.catchupLastError.httpStatus, 503);
});

test('authentication and credit failures pause both hourly lanes without discarding windows', async () => {
  for (const status of [401, 402, 403]) {
    let calls = 0; const provider = hourlyClient(async () => { calls++; throw Object.assign(new Error('SECRET'), { status }); });
    let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
    assert.equal(result.sync.paused, true); assert.equal(activeWindows(result).length, 1);
    result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:00Z', client: provider, lane: 'catchup' }); assert.equal(calls, 1);
  }
});

test('cursor cycles, empty continuations and adapter cursor rejection split independent filtered windows', async () => {
  for (const makePage of [() => ({ tweets: [], hasNextPage: true, nextCursor: 'empty' }), () => ({ tweets: [hourTweet('8000')], hasNextPage: true, nextCursor: '' }), () => { throw Object.assign(new Error('Некоректний курсор наступної сторінки.'), { code: 'INVALID_RESPONSE' }); }]) {
    const result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: hourlyClient(async () => makePage()) });
    assert.equal(activeWindows(result).length, 2); assert.equal(result.sync.hourly.splitWindows, 1);
    assert.ok(activeWindows(result).every(window => window.method === 'search' && window.cursor === '' && window.queryPolicy === DISCOVERY_QUERY_POLICY));
    assert.equal(result.sync.hourly.completedThrough, null); assert.equal(result.sync.hourly.latestWindow.status, 'split');
  }
});

test('minimum-window known missing roots remain explicit gaps while saved replies do not cause false gaps', async () => {
  const window = frozenWindow('2026-11-17T11:55:00Z', START);
  for (const reply of [false, true]) {
    const before = wb(data([post('9000', { date: '2026-11-17', publishedAt: '2026-11-17T11:58:00Z', isReply: reply })]), { hourly: hourlyState({ pendingWindows: [window], coverageFrom: window.start, nextRunAt: '2026-11-17T13:00:00Z' }) });
    const result = await advanceHourlyDiscovery(before, { now: START, lane: 'catchup', client: hourlyClient(async () => emptyPage()) });
    assert.equal(result.sync.hourly.pendingWindows.length, 0); assert.equal(result.sync.hourly.gaps.length, reply ? 0 : 1);
    if (!reply) assert.equal(result.sync.hourly.gaps[0].code, 'KNOWN_POST_NOT_RETURNED');
    assert.equal(result.dataset.posts[0].metrics.impressions, 100);
  }
});

test('hourly ingestion excludes replies and quoted-only mentions while preserving moderation and work grouping', async () => {
  const before = wb(data([post('9100', { workId: 'thread:manual', date: '2026-11-17', publishedAt: '2026-11-17T11:45:00Z' })]));
  before.state = Model.decision(before.state, { type: 'ban', authorId: '200', periodKey: '2026-11', reason: 'Public reason', internalNote: 'Private note' }, START);
  const tweets = [hourTweet('9100'), hourTweet('9101', START), hourTweet('9102', undefined, { text: 'About @entropyIOOther' }), hourTweet('9103', undefined, { author: { id: '999', userName: 'entropyIO' } }), hourTweet('9104', undefined, { isRetweet: true }), hourTweet('9105', undefined, { isReply: true }), hourTweet('9106', undefined, { isReply: false, inReplyToId: '9000' }), hourTweet('9107', undefined, { text: 'Quoted commentary', quoted_tweet: { text: '@entropyIO' } })];
  const result = await advanceHourlyDiscovery(before, { now: START, client: hourlyClient(async () => ({ tweets, hasNextPage: false, nextCursor: null })) });
  assert.deepEqual(result.dataset.posts.map(value => value.id), ['9100']); assert.equal(result.dataset.posts[0].workId, 'thread:manual');
  assert.equal(result.state.bans['200'].internalNote, 'Private note'); assert.equal(result.sync.hourly.lastDataAt, START);
});

test('hourly fresh discovery crosses UTC months without losing the previous-month overlap', async () => {
  let args; const result = await advanceHourlyDiscovery(wb(data([], [])), { now: '2026-12-01T00:05:00Z', client: hourlyClient(async value => { args = value; return { tweets: [hourTweet('9200', '2026-11-30T23:55:00Z')], hasNextPage: false, nextCursor: null }; }) });
  assert.equal(args.sinceTime, Date.parse('2026-11-30T23:00:00Z') / 1000); assert.equal(result.dataset.posts[0].date, '2026-11-30'); assert.equal(result.sync.hourly.completedThrough, null);
});

test('daily delayed-index audit is bounded, does not duplicate unfinished generations, and catches a formerly absent tweet', async () => {
  const delayed = hourTweet('9900', '2026-11-17T10:20:00Z'); let calls = 0;
  const provider = hourlyClient(async args => {
    calls++; const at = Date.parse(delayed.createdAt) / 1000;
    return { tweets: calls > 1 && at >= args.sinceTime && at < args.untilTime ? [delayed] : [], hasNextPage: false, nextCursor: null };
  });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  const audit = result.sync.hourly.pendingWindows.filter(window => window.audit && window.discoveryLane === 'direct');
  assert.ok(audit.length >= 3 && audit.length <= 4); assert.equal(result.dataset.posts.length, 0);
  const from = Math.min(...audit.map(window => Date.parse(window.start))), until = Math.max(...audit.map(window => Date.parse(window.endExclusive)));
  assert.equal(Date.parse(START) - from, 72 * 3600000); assert.equal(until, Date.parse(START) - 3600000);
  result = await advanceHourlyDiscovery(result, { now: '2026-11-18T12:00:00Z', client: provider });
  assert.equal(result.sync.hourly.pendingWindows.filter(window => window.audit && window.discoveryLane === 'direct').length, audit.length);
  for (let step = 0; result.sync.hourly.pendingWindows.length && step < 40; step++) result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.nextAttemptAt, lane: 'catchup', client: provider });
  assert.deepEqual(result.dataset.posts.map(post => post.id), ['9900']); assert.ok(result.sync.hourly.completedRanges.length > 0);
});

test('positive reply evidence survives weaker observations, and raw refresh never calls a returned reply unavailable', async () => {
  const old = data([post('111', { isReply: true, inReplyToId: '99' })]);
  const merged = mergeDataset(old, data([post('111', { isReply: false, inReplyToId: null })], [author], START));
  assert.equal(merged.posts[0].isReply, true); assert.equal(merged.posts[0].inReplyToId, '99');
  const before = wb(data([post('111')]), { phase: 'refresh', requestCount: 1, refresh: { pendingIds: ['111'] } });
  const result = await advanceSync(before, { now: START, client: client(null, async () => ({ tweets: [rawTweet('111', { isReply: true, inReplyToId: '99' })] })) });
  assert.equal(result.dataset.posts[0].isReply, true); assert.equal(result.dataset.posts[0].availability.status, 'available');
  assert.ok(!result.sync.gaps.some(gap => gap.code === 'POSTS_UNAVAILABLE'));
  let refreshed = [];
  await advanceSync(wb(old, { phase: 'refresh', requestCount: 1, refresh: { pendingIds: ['111'] } }), { now: START, client: client(async () => emptyPage(), async ids => { refreshed = ids; return { tweets: [] }; }) });
  assert.deepEqual(refreshed, []);
});

test('exact-ID discovery helper accepts own direct mentions, not replies, own account or quoted contents', () => {
  const long = hourTweet('111', undefined, { text: 'A'.repeat(350) + ' @entropyIO' });
  const result = normalizeDiscoveryPage([long, hourTweet('112', undefined, { isReply: true }), hourTweet('113', undefined, { text: 'Quote commentary', quoted_tweet: { text: '@entropyIO' } }), hourTweet('114', undefined, { author: { id: '999', userName: 'entropyIO' } })], START);
  assert.deepEqual(result.posts.map(post => post.id), ['111']); assert.equal(result.posts[0].body, long.text);
});


test('positive repost evidence and unknown reply classification survive a weaker merge', () => {
  for (const facts of [{ isRetweet: true }, { isRepost: true }, { retweeted_tweet: '99' }, { repostedTweetId: '99' }]) {
    const result = mergeDataset(data([post('111', facts)]), data([post('111', { isRetweet: false, isRepost: false, retweeted_tweet: '', repostedTweetId: '' })], [author], START));
    assert.equal(Model.postEligibility(result.posts[0]).reason, 'repost');
  }
  const unknown = mergeDataset(data([post('111')]), data([post('111', { isReply: null })], [author], START));
  assert.equal(unknown.posts[0].isReply, null);
});

test('two repeated audit timeouts split the stalled window and minimum gaps allow later audit work', async () => {
  const audit = frozenWindow('2026-11-15T00:00:00Z', '2026-11-16T00:00:00Z', { audit: true, kind: 'audit' });
  let result = wb(data([], []), { hourly: hourlyState({ pendingWindows: [audit], nextRunAt: '2026-11-17T13:00:00Z' }) });
  const timeout = hourlyClient(async () => { throw Object.assign(new Error('SECRET'), { code: 'REQUEST_TIMEOUT' }); });
  result = await advanceHourlyDiscovery(result, { now: START, lane: 'catchup', client: timeout });
  assert.equal(result.sync.hourly.pendingWindows[0].consecutiveTimeouts, 1);
  result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.nextAttemptAt, lane: 'catchup', client: timeout });
  assert.equal(result.sync.hourly.pendingWindows.length, 2); assert.equal(result.sync.hourly.splitWindows, 1);
  assert.ok(result.sync.hourly.pendingWindows.every(window => window.audit && window.cursor === ''));
  assert.equal(result.sync.hourly.catchupLastError, null);
  const tiny = frozenWindow('2026-11-15T00:00:00Z', '2026-11-15T00:05:00Z', { audit: true, kind: 'audit' });
  const later = frozenWindow('2026-11-16T00:00:00Z', '2026-11-16T00:05:00Z', { id: 'later', audit: true, kind: 'audit' });
  result.sync.hourly.pendingWindows = [tiny, later]; result.sync.hourly.nextAttemptAt = START;
  for (let index = 0; index < 2; index++) result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.nextAttemptAt, lane: 'catchup', client: timeout });
  assert.equal(result.sync.hourly.pendingWindows.length, 1); assert.equal(result.sync.hourly.gaps.at(-1).code, 'REQUEST_TIMEOUT');
  let seen;
  result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.nextAttemptAt, lane: 'catchup', client: hourlyClient(async args => { seen = args; return emptyPage(); }) });
  assert.equal(seen.sinceTime, Date.parse(later.start) / 1000); assert.equal(result.sync.hourly.pendingWindows.length, 0);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

const queryLane = query => query.startsWith('@entropyIO') ? 'direct' : query.startsWith('Entropy ') ? 'context' : 'evidence';
test('each explicit hourly first page plans only its selected query lane and retains independent success', async () => {
  const calls = [];
  const provider = client(async args => { calls.push(args); return emptyPage(); });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  assert.equal(calls.length, 1); assert.equal(queryLane(calls[0].query), 'direct');
  assert.equal(result.sync.hourly.lanes.evidence.latestPlannedThrough, null);
  assert.equal(result.sync.hourly.lanes.context.latestPlannedThrough, null);
  assert.equal(result.sync.hourly.lanes.evidence.latestSuccessAt, null);
  assert.equal(result.sync.hourly.lanes.context.latestSuccessAt, null);
  for (const [index, discoveryLane] of ['evidence', 'context'].entries()) result = await advanceHourlyDiscovery(result, { now: new Date(Date.parse(START) + (index + 1) * 6000).toISOString(), discoveryLane, client: provider });
  assert.deepEqual(calls.map(call => queryLane(call.query)), DISCOVERY_LANES);
  for (const lane of DISCOVERY_LANES) {
    const state = result.sync.hourly.lanes[lane], windows = result.sync.hourly.pendingWindows.filter(window => window.discoveryLane === lane);
    const at = new Date(Date.parse(START) + DISCOVERY_LANES.indexOf(lane) * 6000).toISOString();
    assert.equal(state.latestPlannedThrough, at); assert.equal(state.latestSuccessAt, at);
    assert.equal(state.lastSuccessAt, at); assert.equal(state.latestNextRunAt, '2026-11-17T13:00:00.000Z');
    assert.equal(state.completedThrough, null);
    assert.ok(windows.some(window => window.audit));
    for (const window of windows) {
      assert.equal(queryLane(window.query), lane); assert.ok(window.id.includes(':' + lane + ':'));
      assert.ok(window.query.length <= 512); assert.equal(window.cursor, '');
    }
  }
  assert.equal(result.sync.hourly.lastSuccessAt, START); assert.equal(result.sync.hourly.latestWindow.discoveryLane, 'direct');
  assert.equal(result.sync.hourly.lanes.evidence.completedRanges.length, 1);
  assert.equal(result.sync.hourly.lanes.context.completedRanges.length, 1);
});
test('fair maintenance visits broad lanes while a noisy context cursor cannot take the next direct hourly slot', async () => {
  const calls = []; let page = 0;
  const provider = client(async args => {
    const lane = queryLane(args.query); calls.push({ ...args, lane });
    if (lane === 'context') return { tweets: [hourTweet('700' + (++page), undefined, { text: 'Shannon entropy and information theory' })], hasNextPage: true, nextCursor: 'context-' + page };
    return emptyPage();
  });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  for (let index = 0; index < 9; index++) result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.nextAttemptAt, lane: 'catchup', client: provider });
  assert.ok(calls.slice(1).some(value => value.lane === 'evidence'));
  assert.ok(calls.slice(1).some(value => value.lane === 'context'));
  assert.ok(result.sync.hourly.pendingWindows.some(window => window.discoveryLane === 'context' && window.cursor));
  assert.equal(result.dataset.posts.length, 0);
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:00Z', client: provider });
  assert.equal(calls.at(-1).lane, 'direct'); assert.equal(calls.at(-1).cursor, '');
  assert.equal(result.sync.hourly.lastSuccessAt, '2026-11-17T13:00:00.000Z');
});
test('cross-lane observations deduplicate one work and retain compact official evidence and lane membership', async () => {
  const source = hourTweet('8800', undefined, { text: '@entropyIO docs https://entropy.io/', entities: { urls: [{ expanded_url: 'https://entropy.io/' }] } });
  const provider = client(async () => ({ tweets: [source], hasNextPage: false, nextCursor: null }));
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  for (const discoveryLane of ['evidence', 'context']) result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.nextAttemptAt, discoveryLane, client: provider });
  assert.equal(result.dataset.posts.length, 1);
  assert.deepEqual([...result.dataset.posts[0].discoveryLanes].sort(), ['context', 'direct', 'evidence']);
  assert.equal(result.dataset.posts[0].relevance.status, 'accepted');
  assert.ok(result.dataset.posts[0].relevance.signals.includes('official_domain'));
  assert.equal(result.dataset.posts[0].metrics.impressions, 100);
});
test('discovery retains ambiguous Entropy privately while filtering science, unrelated projects and reply formats', () => {
  const result = normalizeDiscoveryPage([
    hourTweet('9001', undefined, { text: 'Entropy HIP-3 perpetual markets on Hyperliquid' }),
    hourTweet('9002', undefined, { text: 'Entropy Creator Program is live' }),
    hourTweet('9003', undefined, { text: 'Shannon entropy and information theory' }),
    hourTweet('9004', undefined, { text: 'Pyth Entropy generates randomness' }),
    hourTweet('9005', undefined, { text: 'Entropy HIP-3 perpetual markets', isReply: true }),
    hourTweet('9006', undefined, { text: 'This is useful', quoted_tweet: { id: '123', author: { userName: 'entropyIO' } } }),
  ], START);
  assert.deepEqual(result.posts.map(post => post.id), ['9001', '9002', '9006']);
  assert.equal(result.posts[1].relevance.status, 'review');
  assert.equal(result.posts[2].relevance.signals.includes('official_quote'), true);
});
test('metrics cannot erase saved quote proof, and stronger observations can promote a review candidate', async () => {
  const source = normalizeDiscoveryPage([hourTweet('8801', undefined, { text: 'This is useful', quoted_tweet: { id: '123', author: { userName: 'entropyIO' } } })], START);
  const refreshed = await advanceSync(wb(source, { phase: 'refresh', refresh: { pendingIds: ['8801'] } }), { now: LATER,
    client: client(null, async () => ({ tweets: [hourTweet('8801', undefined, { text: null, viewCount: 120 })] })) });
  assert.equal(refreshed.dataset.posts[0].relevance.status, 'accepted');
  assert.equal(refreshed.dataset.posts[0].relevance.signals.includes('official_quote'), true);
  const review = normalizeDiscoveryPage([hourTweet('8802', undefined, { text: 'Entropy looks interesting' })], START);
  const proven = normalizeDiscoveryPage([hourTweet('8802', undefined, { text: 'Entropy looks interesting', entities: { urls: [{ expanded_url: 'https://entropy.io/' }] } })], LATER);
  const promoted = mergeDataset(review, proven);
  assert.equal(promoted.posts[0].relevance.status, 'accepted');
});
test('known missing checks use query scope and keep candidates out of coverage obligations', async () => {
  for (const candidate of [false, true]) {
    const source = normalizeDiscoveryPage([hourTweet('8803', '2026-11-17T11:58:00Z', { text: candidate ? 'Entropy looks interesting' : 'Entropy HIP-3 perpetual markets' })], START);
    source.posts[0].discoveryLanes = ['context'];
    for (const lane of ['direct', 'context']) {
      const window = frozenWindow('2026-11-17T11:55:00Z', START, { discoveryLane: lane, query: discoveryQuery('2026-11-17T11:55:00Z', START, DISCOVERY_QUERY_POLICY, lane) });
      const before = wb(source, { hourly: hourlyState({ pendingWindows: [window], nextRunAt: '2026-11-17T13:00:00Z' }) });
      const result = await advanceHourlyDiscovery(before, { now: START, lane: 'catchup', client: client(async () => emptyPage()) });
      assert.equal(result.sync.hourly.gaps.length, lane === 'context' && !candidate ? 1 : 0);
    }
  }
});
test('broader cursor splits retain lane identity and cannot reuse a direct query cursor', async () => {
  const window = frozenWindow('2026-11-17T11:00:00Z', START, { discoveryLane: 'context', query: discoveryQuery('2026-11-17T11:00:00Z', START, DISCOVERY_QUERY_POLICY, 'context'), cursor: 'context-only', seenCursors: ['context-only'] });
  let result = wb(data([], []), { hourly: hourlyState({ pendingWindows: [window], nextRunAt: '2026-11-17T13:00:00Z' }) });
  let called;
  result = await advanceHourlyDiscovery(result, { now: START, lane: 'catchup', client: client(async args => { called = args; return { tweets: [], hasNextPage: true, nextCursor: 'context-only' }; }) });
  assert.equal(called.cursor, 'context-only'); assert.equal(queryLane(called.query), 'context');
  assert.equal(result.sync.hourly.pendingWindows.length, 2);
  assert.ok(result.sync.hourly.pendingWindows.every(value => value.discoveryLane === 'context' && value.cursor === '' && queryLane(value.query) === 'context'));
});

test('dense context audits cannot monopolize the old-work slot of other query lanes', async () => {
  const calls = [], sequences = new Map();
  const provider = client(async args => {
    const lane = queryLane(args.query), from = Number(args.query.match(/since_time:(\d+)/)[1]);
    const key = lane + ':' + from, page = (sequences.get(key) || 0) + 1; sequences.set(key, page);
    calls.push({ lane, from });
    return { tweets: [hourTweet(String(90000 + calls.length), new Date(from * 1000 + 60000).toISOString())], hasNextPage: true, nextCursor: lane + ':' + from + ':' + page };
  });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  for (let index = 0; index < 18; index++) result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.nextAttemptAt, lane: 'catchup', client: provider });
  const oldSlots = [calls[6], calls[12], calls[18]];
  assert.deepEqual(oldSlots.map(call => call.lane), ['direct', 'evidence', 'context']);
  assert.ok(oldSlots.every(call => call.from < Date.parse(START) / 1000 - 48 * 3600));
});

test('all three hourly first pages bypass old cursors and maintenance backoff, including untagged posts', async () => {
  const from = '2026-11-10T00:00:00Z', until = '2026-11-11T00:00:00Z';
  const pendingWindows = DISCOVERY_LANES.map(discoveryLane => frozenWindow(from, until, { id: 'old-' + discoveryLane, discoveryLane,
    query: discoveryQuery(from, until, DISCOVERY_QUERY_POLICY, discoveryLane), cursor: 'old-' + discoveryLane, seenCursors: ['old-' + discoveryLane] }));
  const lanes = Object.fromEntries(DISCOVERY_LANES.map(discoveryLane => [discoveryLane, { latestPlannedThrough: until, lastSuccessAt: '2026-11-16T10:00:00Z' }]));
  let result = wb(data([], []), { hourly: hourlyState({ lanes, pendingWindows, catchupRequestCount: 5, nextAttemptAt: '2026-11-17T13:45:00Z' }) });
  const calls = [], bodies = ['@entropyIO creator update', 'Entropy docs https://entropy.io/', 'Entropy HIP-3 perpetual markets on Hyperliquid'];
  const provider = client(async args => {
    calls.push(args); const discoveryLane = queryLane(args.query), index = DISCOVERY_LANES.indexOf(discoveryLane);
    assert.equal(args.cursor, ''); assert.ok(Number(args.query.match(/since_time:(\d+)/)[1]) >= Date.parse('2026-11-17T10:55:00Z') / 1000);
    return { tweets: [hourTweet(String(92000 + index), '2026-11-17T11:50:00Z', { text: bodies[index] }),
      hourTweet(String(93000 + index), '2026-11-17T11:50:00Z', { text: bodies[index], isReply: true })], hasNextPage: true, nextCursor: 'fresh-' + discoveryLane };
  });
  for (const [index, discoveryLane] of DISCOVERY_LANES.entries()) result = await advanceHourlyDiscovery(result, { now: new Date(Date.parse(START) + index * 6000).toISOString(), discoveryLane, client: provider });
  assert.deepEqual(calls.map(call => queryLane(call.query)), DISCOVERY_LANES);
  assert.deepEqual(result.dataset.posts.map(post => post.id).sort(), ['92000', '92001', '92002']);
  assert.ok(result.dataset.posts.every(post => post.relevance.status === 'accepted' && !post.isReply));
  assert.equal(result.sync.hourly.latestPages, 3); assert.equal(result.sync.hourly.catchupRequestCount, 5);
  assert.equal(result.sync.hourly.lastSuccessAt, START); assert.equal(result.sync.nextRunAt, '2026-11-17T13:00:00.000Z');
  for (const discoveryLane of DISCOVERY_LANES) {
    assert.equal(result.sync.hourly.pendingWindows.find(window => window.id === 'old-' + discoveryLane).cursor, 'old-' + discoveryLane);
    assert.ok(result.sync.hourly.pendingWindows.some(window => window.discoveryLane === discoveryLane && window.cursor === 'fresh-' + discoveryLane));
  }
});

test('fresh continuation uses only its selected current range and never falls back to overlapping history or audits', async () => {
  const calls = [], provider = client(async args => {
    calls.push(args);
    return { tweets: [hourTweet(String(94000 + calls.length), args.cursor ? '2026-11-17T11:10:00Z' : '2026-11-17T11:50:00Z', { text: 'Entropy docs https://entropy.io/' })],
      hasNextPage: !args.cursor, nextCursor: args.cursor ? null : 'current-evidence' };
  });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, discoveryLane: 'evidence', client: provider });
  const latest = result.sync.hourly.lanes.evidence.latestRange;
  const old = frozenWindow('2026-11-10T00:00:00Z', '2026-11-17T12:30:00Z', { id: 'wide-history', discoveryLane: 'evidence', cursor: 'wide-old', query: discoveryQuery('2026-11-10T00:00:00Z', '2026-11-17T12:30:00Z', DISCOVERY_QUERY_POLICY, 'evidence') });
  const audit = frozenWindow(latest.start, latest.endExclusive, { id: 'same-range-audit', discoveryLane: 'evidence', kind: 'audit', audit: true, cursor: 'audit-old', query: discoveryQuery(latest.start, latest.endExclusive, DISCOVERY_QUERY_POLICY, 'evidence') });
  result.sync.hourly.pendingWindows.unshift(old, audit); result.sync.hourly.catchupRequestCount = 5;
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:06Z', lane: 'fresh', discoveryLane: 'evidence', client: provider });
  assert.equal(calls.length, 2); assert.equal(calls[1].cursor, 'current-evidence'); assert.equal(calls[1].query, calls[0].query);
  assert.equal(result.sync.hourly.freshPages, 1); assert.equal(result.sync.hourly.catchupRequestCount, 5);
  assert.equal(result.sync.hourly.lanes.evidence.latestSuccessAt, START);
  assert.equal(result.sync.hourly.lanes.evidence.latestContinuationAt, '2026-11-17T12:00:06.000Z');
  assert.equal(result.sync.hourly.pendingWindows.find(window => window.id === old.id).cursor, 'wide-old');
  assert.equal(result.sync.hourly.pendingWindows.find(window => window.id === audit.id).cursor, 'audit-old');
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:12Z', lane: 'fresh', discoveryLane: 'evidence', client: provider });
  await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:18Z', lane: 'fresh', discoveryLane: 'context', client: provider });
  assert.equal(calls.length, 2);
});

test('fresh first-page retry remains lane-local while other lanes succeed and keep their own hourly deadlines', async () => {
  const calls = [], provider = client(async args => {
    const discoveryLane = queryLane(args.query); calls.push({ ...args, discoveryLane });
    if (calls.length === 1) throw Object.assign(new Error('SECRET'), { code: 'NETWORK_ERROR' });
    return emptyPage();
  });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  assert.equal(result.sync.hourly.lanes.direct.latestNextAttemptAt, LATER);
  for (const [index, discoveryLane] of ['evidence', 'context'].entries()) result = await advanceHourlyDiscovery(result, { now: new Date(Date.parse(START) + (index + 1) * 6000).toISOString(), discoveryLane, client: provider });
  assert.equal(calls.length, 3); assert.equal(result.sync.hourly.lanes.direct.latestError.diagnosticCode, 'NETWORK_ERROR');
  assert.equal(result.sync.hourly.lanes.direct.latestSuccessAt, null);
  assert.equal(result.sync.hourly.lanes.evidence.latestSuccessAt, '2026-11-17T12:00:06.000Z');
  assert.equal(result.sync.hourly.lanes.context.latestSuccessAt, '2026-11-17T12:00:12.000Z');
  assert.equal(result.sync.hourly.lastSuccessAt, null); assert.equal(result.sync.hourly.lastError.diagnosticCode, 'NETWORK_ERROR');
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:01:00Z', lane: 'fresh', client: provider });
  assert.equal(calls.length, 3);
  result = await advanceHourlyDiscovery(result, { now: LATER, lane: 'fresh', client: provider });
  assert.equal(calls.length, 4); assert.equal(calls[3].discoveryLane, 'direct'); assert.equal(calls[3].cursor, '');
  assert.equal(result.sync.hourly.lanes.direct.latestContinuationAt, LATER); assert.equal(result.sync.hourly.lanes.direct.latestSuccessAt, null);
  for (const discoveryLane of DISCOVERY_LANES) result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:10:00Z', discoveryLane, client: provider });
  assert.equal(calls.length, 4);
  for (const [index, discoveryLane] of DISCOVERY_LANES.entries()) result = await advanceHourlyDiscovery(result, { now: new Date(Date.parse('2026-11-17T13:00:00Z') + index * 6000).toISOString(), discoveryLane, client: provider });
  assert.equal(calls.length, 7); assert.ok(calls.slice(4).every(call => call.cursor === ''));
  assert.equal(result.sync.hourly.lastSuccessAt, '2026-11-17T13:00:00.000Z'); assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('rate-limit cooldown is shared across query lanes and all hourly actions', async () => {
  let calls = 0; const provider = client(async () => {
    calls++; if (calls === 1) throw Object.assign(new Error('SECRET'), { code: 'RATE_LIMITED', status: 429 });
    return emptyPage();
  });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, discoveryLane: 'context', client: provider });
  assert.equal(result.sync.hourly.providerNextAttemptAt, LATER); assert.equal(result.sync.paused, false);
  for (const lane of ['latest', 'fresh', 'catchup']) for (const discoveryLane of DISCOVERY_LANES) result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:01:00Z', lane, discoveryLane, client: provider });
  assert.equal(calls, 1);
  result = await advanceHourlyDiscovery(result, { now: LATER, discoveryLane: 'evidence', client: provider });
  assert.equal(calls, 2); assert.equal(result.sync.hourly.lanes.evidence.latestSuccessAt, LATER);
  assert.equal(result.sync.hourly.lanes.context.latestError.code, 'RATE_LIMITED'); assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('fresh cursor recovery keeps split windows inside their lane and current range ahead of old work', async () => {
  let calls = 0; const provider = client(async args => {
    calls++;
    if (calls === 1) return { tweets: [hourTweet('95000', undefined, { text: 'Entropy HIP-3 perpetual markets' })], hasNextPage: true, nextCursor: 'context-tail' };
    if (calls < 4) throw Object.assign(new Error('SECRET'), { code: 'REQUEST_TIMEOUT' });
    assert.equal(queryLane(args.query), 'context'); assert.equal(args.cursor, '');
    return emptyPage();
  });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, discoveryLane: 'context', client: provider });
  const latest = structuredClone(result.sync.hourly.lanes.context.latestRange);
  result.sync.hourly.pendingWindows.unshift(frozenWindow('2026-11-10T00:00:00Z', '2026-11-11T00:00:00Z', { id: 'history', discoveryLane: 'context', cursor: 'history-only' }));
  for (let attempt = 0; attempt < 2; attempt++) result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.lanes.context.latestNextAttemptAt, lane: 'fresh', discoveryLane: 'context', client: provider });
  assert.equal(calls, 3); assert.equal(result.sync.hourly.splitWindows, 1);
  result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.lanes.context.latestNextAttemptAt, lane: 'fresh', discoveryLane: 'context', client: provider });
  assert.equal(calls, 4); assert.equal(result.sync.hourly.pendingWindows.find(window => window.id === 'history').cursor, 'history-only');
  const recovered = result.sync.hourly.lanes.context.latestContinuationWindow;
  assert.ok(Date.parse(recovered.start) >= Date.parse(latest.start)); assert.ok(Date.parse(recovered.endExclusive) <= Date.parse(latest.endExclusive));
  assert.equal(result.sync.hourly.catchupRequestCount, 0); assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('v3 unrequested broad first page is due independently of the legacy direct deadline', async () => {
  const start = '2026-11-17T10:55:00.000Z', latestRange = { start, endExclusive: START };
  const window = frozenWindow(start, START, { discoveryLane: 'context', kind: 'latest', query: discoveryQuery(start, START, DISCOVERY_QUERY_POLICY, 'context') });
  const before = wb(data([], []), { hourly: hourlyState({ nextRunAt: '2026-11-17T13:00:00Z', pendingWindows: [window], lanes: { context: { latestPlannedThrough: START, latestRange, lastSuccessAt: '2026-11-17T11:59:00Z' } } }) });
  let calls = 0;
  const result = await advanceHourlyDiscovery(before, { now: START, discoveryLane: 'context', client: client(async args => { calls++; assert.equal(args.cursor, ''); assert.equal(queryLane(args.query), 'context'); return emptyPage(); }) });
  assert.equal(calls, 1); assert.equal(result.sync.hourly.lanes.context.latestSuccessAt, START);
  assert.equal(result.sync.hourly.lastSuccessAt, null); assert.equal(result.sync.nextRunAt, '2026-11-17T13:00:00Z');
});

test('paused and zero-budget v3 checkpoints retain flat direct success and due timestamps before migration', async () => {
  for (const options of [{ sync: { paused: true } }, { sync: {}, maxRequests: 0 }]) {
    const before = wb(data([], []), { ...options.sync, hourly: hourlyState({ lanes: { direct: { completedRanges: [] }, evidence: {}, context: {} },
      lastSuccessAt: START, nextRunAt: '2026-11-17T13:00:00Z', latestWindow: { status: 'complete' } }) });
    const result = await advanceHourlyDiscovery(before, { now: LATER, maxRequests: options.maxRequests ?? 1, client: client(async () => { throw new Error('Must not request.'); }) });
    assert.equal(result.sync.hourly.lastSuccessAt, START); assert.equal(result.sync.hourly.nextRunAt, '2026-11-17T13:00:00Z');
    assert.deepEqual(result.sync.hourly.latestWindow, { status: 'complete' });
  }
});

test('a v3 provider rate-limit deadline cannot be bypassed by a newly enabled broad lane', async () => {
  let calls = 0;
  const before = wb(data([], []), { hourly: hourlyState({ nextAttemptAt: LATER, nextRunAt: '2026-11-17T13:00:00Z', lastError: { code: 'RATE_LIMITED', at: START } }) });
  const result = await advanceHourlyDiscovery(before, { now: '2026-11-17T12:01:00Z', discoveryLane: 'context', client: client(async () => { calls++; return emptyPage(); }) });
  assert.equal(calls, 0); assert.equal(result.sync.hourly.providerNextAttemptAt, LATER);
  assert.equal(result.sync.hourly.lanes.context.latestAttemptAt, null);
});

test('next-hour fresh pagination recovers from a prior range failure while retaining the failed old cursor', async () => {
  const calls = [], provider = client(async args => {
    calls.push(args);
    if (calls.length === 2) throw Object.assign(new Error('SECRET'), { status: 503 });
    const old = calls.length === 1;
    return { tweets: [hourTweet(String(96000 + calls.length), old ? '2026-11-17T11:50:00Z' : args.cursor ? '2026-11-17T12:10:00Z' : '2026-11-17T12:50:00Z', { text: 'Entropy HIP-3 perpetual markets' })],
      hasNextPage: !args.cursor, nextCursor: args.cursor ? null : old ? 'failed-old-tail' : 'new-hour-tail' };
  });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, discoveryLane: 'context', client: provider });
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:06Z', lane: 'fresh', discoveryLane: 'context', client: provider });
  assert.equal(result.sync.hourly.lanes.context.latestContinuationError.httpStatus, 503);
  assert.equal(result.sync.hourly.lanes.context.latestContinuationWindow.status, 'error');
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:00Z', discoveryLane: 'context', client: provider });
  assert.equal(result.sync.hourly.lanes.context.latestContinuationError, null);
  assert.equal(result.sync.hourly.lanes.context.latestContinuationWindow, null);
  assert.ok(result.sync.hourly.pendingWindows.some(window => window.cursor === 'failed-old-tail'));
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:06Z', lane: 'fresh', discoveryLane: 'context', client: provider });
  assert.equal(calls.length, 4); assert.equal(calls[3].cursor, 'new-hour-tail'); assert.equal(result.sync.hourly.lanes.context.latestContinuationWindow.status, 'complete');
  assert.equal(result.sync.hourly.lanes.context.latestContinuationAt, '2026-11-17T13:00:06.000Z');
  assert.ok(result.sync.hourly.pendingWindows.some(window => window.cursor === 'failed-old-tail')); assert.ok(!JSON.stringify(result).includes('SECRET'));
});
