import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Model } from '../lib/entropy-engine.mjs';

const result = await build({ entryPoints: [new URL('../lib/community-projection.ts', import.meta.url).pathname], bundle: true,
  format: 'esm', platform: 'node', target: 'node22', write: false });
const { projectCommunitySnapshot, publishCommunitySnapshot } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const now = new Date('2026-11-18T12:00:00Z');
const author = (id, handle) => ({ id, handle, displayName: handle.slice(1), followers: 0, smartFollowersComplete: true, smartEngagementComplete: true });
const metrics = (impressions = 10000) => ({ impressions, likes: 10, reposts: 2, quotes: 1, replies: 3 });
const post = (id, authorId, date = '2026-11-08', overrides = {}) => ({ id, authorId, date, publishedAt: date + 'T12:00:00Z',
  url: 'https://x.com/test/status/' + id, body: 'Public post ' + id, summary: 'Public summary ' + id,
  metrics: metrics(), metricsAsOf: '2026-11-18T10:00:00Z', ...overrides });
function fixture() {
  return { revision: 17, updatedAt: '2026-11-18T11:00:00Z', state: Model.initialState(), sync: {
    lastSuccessAt: '2026-11-18T11:59:00Z', backfill: { lastSuccessAt: '2026-11-18T11:58:00Z' },
    hourly: { lastSuccessAt: '2026-11-18T10:35:00Z' },
  }, dataset: Model.validateDataset({ meta: { coverage: 'complete' },
    authors: [author('101', '@alpha'), author('102', '@beta'), author('103', '@gamma')],
    posts: [post('1001', '101'), post('1002', '101'), post('1003', '102'), post('1004', '103')], accounts: [], followRelations: [], interactions: [] }) };
}
const decision = { reason: 'PRIVATE_PUBLIC_REASON', internalNote: 'PRIVATE_INTERNAL_NOTE', at: '2026-11-18T11:00:00Z' };
const allRows = snapshot => snapshot.public.periods.flatMap(period => period.rows);

test('projection is a strict public whitelist even when stored entities contain arbitrary internal fields', () => {
  const source = fixture();
  Object.assign(source, { secret: 'PRIVATE_SOURCE_KEY' });
  Object.assign(source.dataset.meta, { sourceNote: 'PRIVATE_SOURCE_NOTE' });
  Object.assign(source.dataset.authors[0], { internalNote: 'PRIVATE_AUTHOR_NOTE', reason: 'PRIVATE_AUTHOR_REASON', evidence: ['PRIVATE_EVIDENCE'] });
  Object.assign(source.dataset.posts[0], { internalNote: 'PRIVATE_POST_NOTE', reason: 'PRIVATE_POST_REASON', cursor: 'PRIVATE_CURSOR' });
  source.state.audit.push({ ...decision, id: 'audit:1', actorUserId: 'PRIVATE_OWNER' });
  source.state.identityEvidence = { '101': { id: 'PRIVATE_IDENTITY_EVIDENCE' } };
  source.state.accountReviews = { '199': { id: '199', internalNote: 'PRIVATE_ACCOUNT_REVIEW' } };
  source.sync.apiKey = 'PRIVATE_PROVIDER_KEY';
  const snapshot = projectCommunitySnapshot(source, now);
  assert.deepEqual(Object.keys(snapshot), ['schemaVersion', 'revision', 'updatedAt', 'public']);
  assert.deepEqual(Object.keys(snapshot.public), ['target', 'defaultPeriod', 'periods', 'posts', 'freshness']);
  assert.deepEqual(Object.keys(snapshot.public.periods[0]), ['key', 'start', 'endExclusive', 'rows']);
  assert.deepEqual(Object.keys(allRows(snapshot)[0]), ['rank', 'author', 'score', 'posts', 'metrics']);
  assert.deepEqual(Object.keys(allRows(snapshot)[0].author), ['id', 'handle', 'displayName']);
  assert.deepEqual(Object.keys(allRows(snapshot)[0].metrics), ['impressions', 'likes', 'reposts', 'quotes', 'replies']);
  assert.deepEqual(Object.keys(snapshot.public.posts[0]), ['id', 'authorId', 'date', 'publishedAt', 'url', 'body', 'summary', 'metrics', 'metricsAsOf']);
  const json = JSON.stringify(snapshot);
  assert.ok(!json.includes('PRIVATE_'));
  for (const field of ['internalNote', 'accountReviews', 'identityEvidence', 'reasonCodes', 'components', 'personal', 'algorithmVersion']) assert.ok(!json.includes(field));
  assert.equal(snapshot.public.freshness.lastDiscoveryAt, '2026-11-18T10:35:00.000Z');
  assert.equal(snapshot.public.freshness.coverage, 'partial');
  assert.ok(allRows(snapshot).find(row => row.author.id === '101').score > 0);
});

test('ban, calendar-period exclusion and post exclusion remove bodies and counters at the server boundary', () => {
  const source = fixture();
  source.dataset.posts.push(post('1005', '102', '2026-10-18'), post('1006', '103', '2026-10-18'));
  source.state.bans['102'] = decision;
  source.state.periodDecisions['2026-11|103'] = decision;
  source.state.postExclusions['1001'] = { ...decision, authorId: '101' };
  const snapshot = projectCommunitySnapshot(source, now);
  const november = snapshot.public.periods.find(period => period.key === '2026-11');
  assert.deepEqual(november.rows.map(row => row.author.id), ['101']);
  assert.equal(november.rows[0].posts, 1);
  assert.equal(november.rows[0].metrics.impressions, 10000);
  assert.equal(november.rows[0].score, null);
  assert.deepEqual(snapshot.public.periods.find(period => period.key === '2026-10').rows.map(row => row.author.id), ['103']);
  assert.deepEqual(new Set(snapshot.public.posts.map(item => item.id)), new Set(['1002', '1006']));
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
});

test('all-post exclusions remove creator row and post text; empty current month remains an honest default', () => {
  const source = fixture();
  for (const item of source.dataset.posts) source.state.postExclusions[item.id] = { ...decision, authorId: item.authorId };
  const snapshot = projectCommunitySnapshot(source, now);
  assert.deepEqual(snapshot.public.periods, [{ key: '2026-11', start: '2026-11-01', endExclusive: '2026-12-01', rows: [] }]);
  assert.deepEqual(snapshot.public.posts, []);
  assert.equal(snapshot.public.defaultPeriod, '2026-11');
});

test('reply posts never enter the public snapshot, while replies received by an original remain a metric', () => {
  const source = fixture();
  Object.assign(source.dataset.posts[2], { isReply: true, inReplyToId: '1001', body: 'PRIVATE_IGNORED_REPLY' });
  Object.assign(source.dataset.posts[3], { isReply: false, inReplyToId: '1004', body: 'PRIVATE_IGNORED_SELF_REPLY' });
  source.dataset.posts.push(post('1005', '101', '2026-11-09', { isReply: true, inReplyToId: '1001', body: 'PRIVATE_IGNORED_THREAD_REPLY' }));
  source.dataset.posts[0].metrics.replies = 27;
  source.dataset.posts[1].isQuote = true;
  // Restoring a prior manual exclusion does not override the automatic policy.
  source.state.postExclusions['1005'] = { ...decision, authorId: '101' };
  delete source.state.postExclusions['1005'];
  const snapshot = projectCommunitySnapshot(source, now), rows = allRows(snapshot);
  assert.deepEqual(rows.map(row => row.author.id), ['101']);
  assert.equal(rows[0].posts, 2); assert.equal(rows[0].metrics.impressions, 20000);
  assert.equal(rows[0].metrics.replies, 30); assert.ok(rows[0].score > 0);
  assert.deepEqual(new Set(snapshot.public.posts.map(item => item.id)), new Set(['1001', '1002']));
  assert.equal(snapshot.public.posts.find(item => item.id === '1001').metrics.replies, 27);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_IGNORED'));
  assert.equal(source.dataset.posts.length, 5); // Source history is preserved.
});

test('untagged matches require accepted relevance or an explicit private review, without exposing review evidence', () => {
  const source = fixture();
  const relevance = status => ({ version: 'entropy-context-v1', status,
    reasonCodes: [status === 'accepted' ? 'DIRECT_MENTION' : status === 'review' ? 'AMBIGUOUS_ENTROPY' : 'NO_PROJECT_EVIDENCE'],
    signals: status === 'accepted' ? ['direct_mention'] : status === 'review' ? ['brand_name'] : [] });
  Object.assign(source.dataset.posts[0], { body: 'PRIVATE_PENDING_ENTROPY', relevance: relevance('review') });
  Object.assign(source.dataset.posts[1], { body: 'PRIVATE_UNRELATED_ENTROPY', relevance: relevance('rejected') });
  source.dataset.posts[2].relevance = relevance('accepted');
  source.dataset.posts[3].relevance = relevance('review');
  source.state.postRelevance['1004'] = { ...decision, authorId: '103', action: 'approve' };
  let snapshot = projectCommunitySnapshot(source, now);
  assert.deepEqual(new Set(snapshot.public.posts.map(post => post.id)), new Set(['1003', '1004']));
  assert.deepEqual(new Set(allRows(snapshot).map(row => row.author.id)), new Set(['102', '103']));
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(snapshot).includes('relevance'));
  source.state.postRelevance['1003'] = { ...decision, authorId: '102', action: 'reject' };
  // A later strong observation cannot reverse the moderator's saved rejection.
  snapshot = projectCommunitySnapshot(source, now);
  assert.deepEqual(snapshot.public.posts.map(post => post.id), ['1004']);
  source.dataset.posts[3].isReply = true;
  assert.deepEqual(projectCommunitySnapshot(source, now).public.posts, []);
});

test('calendar UTC periods replace research window and rankings use views with deterministic ties and unknowns last', () => {
  const source = fixture();
  source.dataset.posts = [post('1001', '101', '2026-10-30', { metrics: metrics(null) }), post('1002', '102', '2026-10-31'), post('1003', '103', '2026-10-31')];
  source.dataset.meta.periodStart = '2026-10-17'; source.dataset.meta.periodEndExclusive = '2026-11-17';
  source.state.ui.period = 'sample';
  const snapshot = projectCommunitySnapshot(source, now);
  assert.deepEqual(snapshot.public.periods.map(period => period.key), ['2026-11', '2026-10']);
  const october = snapshot.public.periods[1];
  assert.deepEqual(october.rows.map(row => [row.rank, row.author.id]), [[1, '102'], [2, '103'], [3, '101']]);
  assert.equal(october.rows[2].metrics.impressions, null);
  assert.equal(snapshot.public.posts.find(item => item.id === '1001').metrics.impressions, null);
  assert.equal(october.start, '2026-10-01'); assert.equal(october.endExclusive, '2026-11-01');
});

test('unknown metrics and provisional scores stay null; no smart evidence or review reasons are disclosed', () => {
  const source = fixture();
  source.dataset.posts[0].metrics.likes = null;
  source.dataset.posts[2].metrics.likes = 5000;
  source.dataset.posts.push(post('1005', '102', '2026-11-09', { metrics: { ...metrics(), likes: 5000 } }));
  source.dataset.authors[0].smartFollowersComplete = false;
  const snapshot = projectCommunitySnapshot(source, now);
  const alpha = allRows(snapshot).find(row => row.author.id === '101');
  const beta = allRows(snapshot).find(row => row.author.id === '102');
  assert.equal(alpha.metrics.likes, null); assert.equal(alpha.score, null); assert.equal(beta.score, null);
  assert.ok(allRows(snapshot).some(row => row.author.id === '102'));
  assert.deepEqual(snapshot.public.freshness, { lastDiscoveryAt: '2026-11-18T10:35:00.000Z', coverage: 'partial' });
});

test('public URLs strip credentials and parameters; missing body is kept separate from summary', () => {
  const source = fixture();
  Object.assign(source.dataset.posts[0], { url: 'https://PRIVATE_USER:PRIVATE_PASSWORD@x.com/test/status/1001?key=PRIVATE_QUERY#PRIVATE_HASH',
    body: null, summary: 'Known summary', publishedAt: 'invalid', metricsAsOf: 'invalid' });
  const projected = projectCommunitySnapshot(source, now).public.posts.find(item => item.id === '1001');
  assert.equal(projected.url, 'https://x.com/test/status/1001');
  assert.equal(projected.body, null); assert.equal(projected.summary, 'Known summary');
  assert.equal(projected.publishedAt, null); assert.equal(projected.metricsAsOf, null);
});

test('non-counter values remain unknown and inconsistent publication times are not published as facts', () => {
  const source = fixture();
  source.dataset.posts[0].metrics.likes = 2.5;
  Object.assign(source.dataset.posts[0], { publishedAt: '2026-11-09T00:00:00Z', url: 'https://x.com:8443/i/web/status/1001' });
  const snapshot = projectCommunitySnapshot(source, now);
  const projected = snapshot.public.posts.find(item => item.id === '1001');
  assert.equal(projected.metrics.likes, null); assert.equal(projected.publishedAt, null);
  assert.equal(projected.url, 'https://x.com/i/web/status/1001');
  assert.equal(allRows(snapshot).find(row => row.author.id === '101').metrics.likes, null);
});

test('mirror is disabled without both settings and rejects unsafe destinations before a network call', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('Unexpected call'); };
    const source = fixture();
    for (const config of [{}, { url: 'https://viewer.example' }, { secret: 'FAKE_SYNC_SECRET' }]) {
      assert.deepEqual(await publishCommunitySnapshot(source, config), { configured: false, delivered: false, revision: 17 });
    }
    for (const url of ['http://viewer.example', 'https://user:password@viewer.example', 'https://viewer.example?key=unsafe']) {
      assert.deepEqual(await publishCommunitySnapshot(source, { url, secret: 'FAKE_SYNC_SECRET' }), { configured: true, delivered: false, revision: 17 });
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('mirror sends only public snapshot over fixed path, caps deadline and never follows redirects', async () => {
  const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
  try {
    const deadlines = []; AbortSignal.timeout = value => { deadlines.push(value); return originalTimeout(value); };
    let received;
    globalThis.fetch = async (url, options) => { received = { url: String(url), options }; return { ok: true }; };
    const source = fixture(); source.sync.key = 'PRIVATE_PROVIDER_KEY';
    const delivered = await publishCommunitySnapshot(source, { url: 'https://viewer.example/ignored-base-path', secret: 'FAKE_SYNC_SECRET' });
    assert.deepEqual(delivered, { configured: true, delivered: true, revision: 17 });
    assert.equal(received.url, 'https://viewer.example/internal/snapshot');
    assert.equal(received.options.method, 'POST'); assert.equal(received.options.redirect, 'manual');
    assert.equal(received.options.headers.Authorization, 'Bearer FAKE_SYNC_SECRET');
    assert.deepEqual(deadlines, [5000]);
    assert.equal(JSON.parse(received.options.body).revision, 17);
    assert.ok(!received.options.body.includes('PRIVATE_PROVIDER_KEY'));
    assert.ok(!received.options.body.includes('FAKE_SYNC_SECRET'));
    globalThis.fetch = async () => { throw new Error('PRIVATE_NETWORK_DETAILS'); };
    assert.deepEqual(await publishCommunitySnapshot(source, { url: 'https://viewer.example', secret: 'FAKE_SYNC_SECRET' }), { configured: true, delivered: false, revision: 17 });
    globalThis.fetch = async () => ({ ok: false, status: 302 });
    assert.equal((await publishCommunitySnapshot(source, { url: 'https://viewer.example', secret: 'FAKE_SYNC_SECRET' })).delivered, false);
  } finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; }
});
