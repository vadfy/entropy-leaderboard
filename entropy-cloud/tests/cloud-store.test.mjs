import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const scope = { DB: null };
globalThis.__entropyCloudTestEnv = scope;
const originalFetch = globalThis.fetch;
let sqlite, beforeBatch;
let batchSizes = [];
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sql, args); }
  runSync() { const result = sqlite.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(result.changes) } }; }
  async run() { return this.runSync(); }
  async first(column) { const row = sqlite.prepare(this.sql).get(...this.args); return column ? row?.[column] ?? null : row ?? null; }
  async all() { return { success: true, results: sqlite.prepare(this.sql).all(...this.args), meta: { changes: 0 } }; }
}
const database = {
  prepare(sql) { return new Statement(sql); },
  async batch(statements) {
    batchSizes.push(statements.length);
    if (beforeBatch) await beforeBatch(statements);
    sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.runSync()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
const migration = await readFile(new URL('../drizzle/0000_aberrant_gamora.sql', import.meta.url), 'utf8');
async function moduleFor(path) {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false,
    plugins: [{ name: 'test-env', setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'env', namespace: 'cloud-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'cloud-test' }, () => ({ contents: 'export const env = globalThis.__entropyCloudTestEnv;', loader: 'js' }));
    } }] });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const store = await moduleFor('../lib/workbench.ts');
const api = await moduleFor('../app/api/[...path]/route.ts');
const mcp = await moduleFor('../app/mcp/route.ts');
const internal = await moduleFor('../app/internal/sync/route.ts');
const backfill = await moduleFor('../app/internal/backfill/route.ts');
const community = await moduleFor('../app/internal/community-sync/route.ts');
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(':memory:'); sqlite.exec(migration);
  scope.DB = database; delete scope.TWITTERAPI_IO_KEY;
  delete scope.COMMUNITY_VIEWER_URL; delete scope.COMMUNITY_SYNC_SECRET;
  batchSizes = []; beforeBatch = null;
  globalThis.fetch = async () => { throw new Error('Unexpected network call in test'); };
});
after(() => { sqlite?.close(); globalThis.fetch = originalFetch; delete globalThis.__entropyCloudTestEnv; });
const control = () => sqlite.prepare('SELECT * FROM entropy_control WHERE id=?').get('main');
const fakeKey = () => { scope.TWITTERAPI_IO_KEY = 'FAKE_TEST_PROVIDER_KEY_DO_NOT_RETURN'; };
const emptyProvider = () => ({ ok: true, status: 200, json: async () => ({ status: 'success', tweets: [], has_next_page: false, next_cursor: '' }) });
const context = path => ({ params: Promise.resolve({ path: [path] }) });
function browserRequest(path, payload, extraHeaders = {}) {
  return new Request('https://entropy.example/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://entropy.example', 'oai-authenticated-user-id': 'owner', ...extraHeaders }, body: JSON.stringify(payload) });
}

test('seed initializes once, stays disabled, and does not fabricate live success', async () => {
  const first = await store.getWorkbench(), again = await store.getWorkbench();
  assert.equal(first.revision, 0); assert.equal(first.dataset.posts.length, 24); assert.equal(first.mode, 'cloud');
  assert.equal(first.sync.enabled, false); assert.equal(first.sync.lastSuccessAt, null); assert.equal(first.connection.configured, false);
  assert.equal(first.sync.attemptBudget.limit, 288); assert.equal(again.revision, 0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM entropy_control').get().n, 1);
  assert.ok(!JSON.stringify(first).includes('lease_token'));
});
test('state writes use strong CAS; competing edits cannot overwrite each other', async () => {
  const first = await store.getWorkbench();
  const a = structuredClone(first.state), b = structuredClone(first.state);
  a.bans[first.dataset.authors[0].id] = { reason: 'Visible decision A', internalNote: 'PRIVATE_A', at: new Date().toISOString() };
  b.bans[first.dataset.authors[1].id] = { reason: 'Visible decision B', at: new Date().toISOString() };
  const results = await Promise.allSettled([store.saveState(a, 0, 'owner'), store.saveState(b, 0, 'owner')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected'); assert.equal(rejected.reason.code, 'CONFLICT');
  const current = await store.getWorkbench(); assert.equal(current.revision, 1); assert.equal(Object.keys(current.state.bans).length, 1);
  await assert.rejects(store.saveState(first.state, 0, 'owner'), error => error.code === 'CONFLICT');
});

test('private relevance decisions persist by post ID and gain server actor attribution', async () => {
  let value = await store.getWorkbench();
  const post = value.dataset.posts[0], state = structuredClone(value.state);
  state.postRelevance[post.id] = { action: 'approve', authorId: post.authorId, reason: 'Confirmed the Entropy context', internalNote: 'PRIVATE_RELEVANCE_NOTE', at: new Date().toISOString() };
  state.audit.unshift({ id: 'event:relevance', type: 'approve-relevance', postId: post.id, authorId: post.authorId, reason: 'Confirmed the Entropy context', internalNote: 'PRIVATE_RELEVANCE_NOTE', at: new Date().toISOString() });
  value = await store.saveState(state, value.revision, 'PRIVATE_REVIEWER_ID');
  const reloaded = await store.getWorkbench();
  assert.deepEqual(reloaded.state.postRelevance, value.state.postRelevance);
  assert.equal(reloaded.state.postRelevance[post.id].action, 'approve');
  assert.equal(reloaded.state.audit[0].actorUserId, 'PRIVATE_REVIEWER_ID');
  assert.ok(sqlite.prepare('SELECT count(*) n FROM entropy_records WHERE generation=? AND kind=?').get(control().generation, 'state:postRelevance').n > 0);
  assert.ok(!JSON.stringify(await store.getCommunityPreview()).includes('PRIVATE_'));
});

test('replacement cannot make an unreviewed match eligible by stripping its relevance facts', async () => {
  let value = await store.getWorkbench(), dataset = structuredClone(value.dataset);
  dataset.posts[0].relevance = { version: 'entropy-context-v1', status: 'review', reasonCodes: ['AMBIGUOUS_ENTROPY'], signals: ['brand_name'] };
  value = await store.importWorkbench({ dataset, expectedRevision: value.revision });
  const replacement = structuredClone(value.dataset); delete replacement.posts[0].relevance;
  value = await store.importWorkbench({ dataset: replacement, expectedRevision: value.revision });
  assert.equal(value.dataset.posts[0].relevance.status, 'review');
  assert.ok(!(await store.getCommunityPreview()).public.posts.some(post => post.id === dataset.posts[0].id));
});
test('enabling requires a server secret; neither normal responses nor backups receive it', async () => {
  const first = await store.getWorkbench();
  await assert.rejects(store.setCollector(true, first.revision), error => error.code === 'KEY_REQUIRED');
  fakeKey();
  const enabled = await store.setCollector(true, 0);
  assert.equal(enabled.connection.configured, true); assert.equal(enabled.connection.keySource, 'environment'); assert.equal(enabled.sync.enabled, true);
  assert.ok(!JSON.stringify(enabled).includes(scope.TWITTERAPI_IO_KEY)); assert.equal(control().daily_attempts, 0);
});
test('every committed edit mirrors only the filtered public snapshot; delivery failure never rolls back decisions', async () => {
  let value = await store.getWorkbench();
  scope.COMMUNITY_VIEWER_URL = 'https://community.example'; scope.COMMUNITY_SYNC_SECRET = 'FAKE_TEST_MIRROR_SECRET';
  fakeKey(); const sent = [];
  globalThis.fetch = async (url, options) => { sent.push({ url: String(url), options, snapshot: JSON.parse(options.body) }); return { ok: true }; };
  const authorId = value.dataset.authors[0].id;
  const state = structuredClone(value.state);
  state.bans[authorId] = { reason: 'PRIVATE_CREATOR_REASON', internalNote: 'PRIVATE_ADMIN_NOTE', at: new Date().toISOString() };
  value = await store.saveState(state, value.revision, 'PRIVATE_OWNER_ID');
  assert.equal(sent.length, 1); assert.equal(sent[0].url, 'https://community.example/internal/snapshot');
  assert.equal(sent[0].options.headers.Authorization, 'Bearer FAKE_TEST_MIRROR_SECRET');
  assert.equal(sent[0].snapshot.revision, value.revision);
  assert.ok(!sent[0].snapshot.public.periods.some(period => period.rows.some(row => row.author.id === authorId)));
  assert.ok(!sent[0].snapshot.public.posts.some(post => post.authorId === authorId));
  assert.ok(!sent[0].options.body.includes('PRIVATE_'));
  assert.ok(!sent[0].options.body.includes(scope.TWITTERAPI_IO_KEY));
  assert.ok(!JSON.stringify(value).includes(scope.COMMUNITY_SYNC_SECRET));
  globalThis.fetch = async () => { throw new Error('PRIVATE_MIRROR_FAILURE_DETAILS'); };
  const failedDelivery = await store.setCollector(false, value.revision);
  assert.equal(failedDelivery.revision, value.revision + 1);
  assert.equal((await store.getWorkbench()).state.bans[authorId].internalNote, 'PRIVATE_ADMIN_NOTE');
  assert.equal(control().daily_attempts, 0); assert.equal(control().lease_token, null);
});
test('ingestion commits push new revision while preserving independent provider credentials and request allowance', async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  scope.COMMUNITY_VIEWER_URL = 'https://community.example'; scope.COMMUNITY_SYNC_SECRET = 'FAKE_TEST_MIRROR_SECRET';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return String(url).startsWith('https://community.example/') ? { ok: true } : emptyProvider();
  };
  value = await store.runSync(value.revision, true);
  assert.equal(calls.length, 2);
  const mirror = calls.find(call => call.url.startsWith('https://community.example/'));
  assert.equal(JSON.parse(mirror.options.body).revision, value.revision);
  assert.equal(mirror.options.headers.Authorization, 'Bearer FAKE_TEST_MIRROR_SECRET');
  assert.ok(!mirror.options.body.includes(scope.TWITTERAPI_IO_KEY));
  assert.equal(control().daily_attempts, 1);
});
test('owner preview is authenticated and contains only whitelist; service republish changes no source state', async () => {
  const value = await store.getWorkbench();
  const unauthorized = await api.GET(new Request('https://entropy.example/api/community-preview'), context('community-preview'));
  assert.equal(unauthorized.status, 401);
  const preview = await api.GET(new Request('https://entropy.example/api/community-preview', { headers: { 'oai-authenticated-user-id': 'owner' } }), context('community-preview'));
  assert.equal(preview.status, 200); const data = await preview.json();
  assert.deepEqual(Object.keys(data), ['schemaVersion', 'revision', 'updatedAt', 'public']);
  assert.ok(!JSON.stringify(data).includes('identityEvidence'));
  scope.COMMUNITY_VIEWER_URL = 'https://community.example'; scope.COMMUNITY_SYNC_SECRET = 'FAKE_TEST_MIRROR_SECRET';
  let calls = 0; globalThis.fetch = async () => { calls++; return { ok: true }; };
  const request = new Request('https://entropy.example/internal/community-sync', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-entropy-update': '1' }, body: '{}' });
  const republished = await community.POST(request);
  assert.equal(republished.status, 200);
  assert.deepEqual(await republished.json(), { configured: true, delivered: true, revision: value.revision });
  assert.equal(calls, 1); assert.equal(control().revision, value.revision); assert.equal(control().daily_attempts, 0);
  assert.equal((await store.getWorkbench()).updatedAt, value.updatedAt);
});
test('private community republish rejects malformed intent, origin, body and type without changing data', async () => {
  await store.getWorkbench();
  const cases = [
    [{}, '{}', 403],
    [{ 'x-entropy-update': '1', origin: 'https://evil.example' }, '{}', 403],
    [{ 'x-entropy-update': '1', 'content-type': 'text/plain' }, '{}', 415],
    [{ 'x-entropy-update': '1' }, '{"action":"sync"}', 400],
    [{ 'x-entropy-update': '1' }, '[]', 400],
    [{ 'x-entropy-update': '1' }, 'x'.repeat(1025), 413],
  ];
  for (const [headers, body, status] of cases) {
    const response = await community.POST(new Request('https://entropy.example/internal/community-sync', { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body }));
    assert.equal(response.status, status);
  }
  assert.equal(control().revision, 0); assert.equal(control().daily_attempts, 0);
});
test('lease and attempt are durable before provider access; a second tick or edit is blocked', { timeout: 5000 }, async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  let release; let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  globalThis.fetch = async () => { enteredResolve(); return new Promise(resolve => { release = () => resolve(emptyProvider()); }); };
  const pending = store.runSync(value.revision, true); await entered;
  assert.equal(control().daily_attempts, 1); assert.ok(control().lease_token); assert.ok(control().lease_until > Date.now());
  await assert.rejects(store.runSync(), error => error.code === 'SYNC_BUSY');
  await assert.rejects(store.saveState(value.state, value.revision, 'owner'), error => error.code === 'SYNC_BUSY');
  release(); const completed = await pending;
  assert.equal(completed.revision, value.revision + 1); assert.equal(control().lease_token, null); assert.equal(control().daily_attempts, 1);
  assert.equal(completed.sync.attemptBudget.count, 1); assert.ok(completed.sync.lastSuccessAt);
});
test('daily limit rejects a tick before network access and survives another process load', async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  const today = new Date().toISOString().slice(0, 10);
  sqlite.prepare('UPDATE entropy_control SET daily_date=?,daily_attempts=288').run(today);
  let calls = 0; globalThis.fetch = async () => { calls++; return emptyProvider(); };
  await assert.rejects(store.runSync(value.revision, true), error => error.code === 'DAILY_LIMIT');
  assert.equal(calls, 0); assert.equal((await store.getWorkbench()).sync.attemptBudget.count, 288); assert.equal(control().daily_attempts, 288);
});
test('regular cloud collection allows the same 65-second provider deadline as historical collection', async () => {
  const originalTimeout = AbortSignal.timeout, deadlines = [];
  AbortSignal.timeout = milliseconds => { deadlines.push(milliseconds); return originalTimeout(milliseconds); };
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    globalThis.fetch = async () => emptyProvider();
    await store.runSync(value.revision, true);
    assert.deepEqual(deadlines, [65000]); assert.equal(control().daily_attempts, 1); assert.equal(control().lease_token, null);
  } finally { AbortSignal.timeout = originalTimeout; }
});
test('an expired worker cannot overwrite moderation saved after its lease expires', { timeout: 5000 }, async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  let release; let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  globalThis.fetch = async () => { enteredResolve(); return new Promise(resolve => { release = () => resolve(emptyProvider()); }); };
  const pending = store.runSync(value.revision, true); await entered;
  sqlite.prepare('UPDATE entropy_control SET lease_until=?').run(Date.now() - 1);
  const state = structuredClone(value.state);
  state.bans[value.dataset.authors[0].id] = { reason: 'Newer moderation must survive', at: new Date().toISOString() };
  const saved = await store.saveState(state, value.revision, 'owner');
  release(); await assert.rejects(pending, error => error.code === 'CONFLICT');
  const final = await store.getWorkbench();
  assert.equal(final.revision, saved.revision); assert.equal(final.state.bans[value.dataset.authors[0].id].reason, 'Newer moderation must survive');
  assert.equal(control().daily_attempts, 1); assert.equal(control().lease_token, null);
});
test('provider 402 pauses with old data retained and counted attempt; errors never expose key', async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  globalThis.fetch = async () => ({ ok: false, status: 402, json: async () => ({ secret: scope.TWITTERAPI_IO_KEY }) });
  const result = await store.runSync(value.revision, true);
  assert.equal(result.sync.paused, true); assert.equal(result.sync.lastError.code, 'CREDITS_EXHAUSTED');
  assert.equal(result.dataset.posts.length, value.dataset.posts.length); assert.equal(result.sync.attemptBudget.count, 1); assert.equal(control().lease_token, null);
  assert.ok(!JSON.stringify(result).includes(scope.TWITTERAPI_IO_KEY));
  await assert.rejects(store.runSync(result.revision, true), error => error.code === 'COLLECTOR_PAUSED');
});
test('imports require stopped collection and reset checkpoints without resetting durable usage', async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  await assert.rejects(store.importWorkbench({ dataset: value.dataset, expectedRevision: value.revision }), error => error.code === 'COLLECTOR_ACTIVE');
  value = await store.setCollector(false, value.revision);
  sqlite.prepare('UPDATE entropy_control SET daily_date=?,daily_attempts=17').run(new Date().toISOString().slice(0, 10));
  const result = await store.importWorkbench({ dataset: value.dataset, expectedRevision: value.revision });
  assert.equal(result.sync.enabled, false); assert.deepEqual(result.sync.discovery.pendingWindows, []); assert.equal(result.sync.discovery.coveredThrough, null);
  assert.equal(result.sync.lastSuccessAt, null); assert.equal(result.sync.attemptBudget.count, 17); assert.equal(control().daily_attempts, 17);
});
test('replacement imports retain known reply and repost facts for the same post IDs without losing decisions', async () => {
  let value = await store.getWorkbench(), dataset = structuredClone(value.dataset);
  const [reply, parentOnlyReply, repost, original] = dataset.posts;
  reply.isReply = true;
  parentOnlyReply.isReply = false; parentOnlyReply.inReplyToId = '1900000000000000000';
  repost.isRepost = true;
  value = await store.importWorkbench({ dataset, expectedRevision: value.revision });
  const state = structuredClone(value.state);
  state.postExclusions[reply.id] = { authorId: reply.authorId, reason: 'Existing decision', at: new Date().toISOString() };
  value = await store.saveState(state, value.revision, 'owner');
  dataset = structuredClone(value.dataset);
  for (const post of dataset.posts) { post.isReply = false; delete post.inReplyToId; post.isRepost = false; }
  value = await store.importWorkbench({ dataset, expectedRevision: value.revision });
  const byId = new Map(value.dataset.posts.map(post => [post.id, post]));
  assert.equal(byId.get(reply.id).isReply, true);
  assert.equal(byId.get(parentOnlyReply.id).isReply, true);
  assert.equal(byId.get(parentOnlyReply.id).inReplyToId, '1900000000000000000');
  assert.equal(byId.get(repost.id).isRepost, true);
  assert.equal(byId.get(original.id).isReply, false);
  assert.equal(value.state.postExclusions[reply.id].reason, 'Existing decision');
  assert.equal(value.dataset.posts.length, 24); assert.equal(control().daily_attempts, 0);
});
test('post-proven identity upgrades preserve bans; browser state writes cannot erase the evidence ledger', async () => {
  let value = await store.getWorkbench();
  const oldAuthor = value.dataset.authors[0], realId = '1234567890123456789';
  const state = structuredClone(value.state);
  state.bans[oldAuthor.id] = { reason: 'Visible reason', internalNote: 'PRIVATE_NOTE', at: new Date().toISOString() };
  value = await store.saveState(state, value.revision, 'owner');
  const dataset = structuredClone(value.dataset);
  dataset.authors.find(a => a.id === oldAuthor.id).id = realId;
  dataset.posts.filter(p => p.authorId === oldAuthor.id).forEach(p => { p.authorId = realId; });
  value = await store.importWorkbench({ dataset, expectedRevision: value.revision });
  assert.equal(value.state.bans[realId].reason, 'Visible reason'); assert.equal(value.state.bans[realId].internalNote, 'PRIVATE_NOTE');
  assert.ok(value.state.identityEvidence[realId]);
  const tampered = structuredClone(value.state); tampered.identityEvidence = {};
  const result = await store.saveState(tampered, value.revision, 'owner');
  assert.deepEqual(result.state.identityEvidence, value.state.identityEvidence);
});
test('large Unicode records are sharded below row limits and reassembled exactly', async () => {
  const text = 'x'.repeat(127998) + '🙂' + '語'.repeat(200000);
  const chunks = store.splitPayload(text);
  assert.ok(chunks.length > 1); assert.equal(JSON.parse(chunks.join('')), text);
  assert.ok(chunks.every(chunk => new TextEncoder().encode(chunk).byteLength < 512000));
  let value = await store.getWorkbench(); const dataset = structuredClone(value.dataset); dataset.posts[0].body = text;
  value = await store.importWorkbench({ dataset, expectedRevision: value.revision });
  assert.equal(value.dataset.posts.find(p => p.id === dataset.posts[0].id).body, text);
  const max = sqlite.prepare('SELECT max(length(CAST(payload AS BLOB))) n FROM entropy_records').get(); assert.ok(max.n < 512000);
});
test('browser APIs require trusted identity, JSON and same-origin writes before touching storage', async () => {
  const anonymous = await api.GET(new Request('https://entropy.example/api/workbench'), context('workbench')); assert.equal(anonymous.status, 401);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM entropy_control').get().n, 0);
  const crossSite = await api.POST(browserRequest('collector', { enabled: true, expectedRevision: 0 }, { origin: 'https://evil.example' }), context('collector')); assert.equal(crossSite.status, 403);
  const wrongType = await api.POST(browserRequest('collector', {}, { 'content-type': 'text/plain' }), context('collector')); assert.equal(wrongType.status, 415);
  const oversized = await api.POST(browserRequest('collector', {}, { 'content-length': String(16 * 1024 * 1024) }), context('collector')); assert.equal(oversized.status, 413);
  const ok = await api.GET(new Request('https://entropy.example/api/workbench', { headers: { 'oai-authenticated-user-id': 'owner' } }), context('workbench'));
  assert.equal(ok.status, 200); assert.equal((await ok.json()).mode, 'cloud');
});
test('manual sync requires enabled collector; unversioned browser mutations are rejected', async () => {
  fakeKey(); const value = await store.getWorkbench();
  const disabled = await api.POST(browserRequest('sync', { expectedRevision: value.revision }), context('sync'));
  assert.equal(disabled.status, 400); assert.equal((await disabled.json()).error.code, 'COLLECTOR_DISABLED');
  const missingVersion = await api.POST(browserRequest('sync', {}), context('sync')); assert.equal(missingVersion.status, 400);
  assert.equal(control().daily_attempts, 0);
});
test('MCP discovery is supported; tools disclose status without notes, keys or auto enabling', async () => {
  fakeKey(); let value = await store.getWorkbench();
  const state = structuredClone(value.state); state.bans[value.dataset.authors[0].id] = { reason: 'Public reason', internalNote: 'MCP_PRIVATE_NOTE', at: new Date().toISOString() };
  value = await store.saveState(state, value.revision, 'owner');
  const call = async (method, params) => mcp.POST(new Request('https://entropy.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
  const discovery = await (await call('server/discover')).json(); assert.deepEqual(discovery.result.supportedVersions, ['2026-07-28']);
  const listed = await (await call('tools/list')).json(); assert.deepEqual(listed.result.tools.map(t => t.name), ['entropy_status', 'entropy_sync']);
  const response = await (await call('tools/call', { name: 'entropy_sync', arguments: {} })).json();
  assert.equal(response.result.structuredContent.sync.enabled, false); assert.equal(control().daily_attempts, 0);
  assert.ok(!JSON.stringify(response).includes('MCP_PRIVATE_NOTE')); assert.ok(!JSON.stringify(response).includes(scope.TWITTERAPI_IO_KEY));
});
function internalRequest(body = '{}', headers = {}) {
  return new Request('https://entropy.example/internal/sync', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-entropy-update': '1', ...headers }, body });
}
test('private service writer rejects malformed intent, origin, type and bounded JSON before storage', async () => {
  const cases = [
    [internalRequest('{}', { 'x-entropy-update': '' }), 403],
    [internalRequest('{}', { origin: 'https://evil.example' }), 403],
    [internalRequest('{}', { 'content-type': 'text/plain' }), 415],
    [internalRequest('{}', { 'content-type': 'application/json-not-json' }), 415],
    [internalRequest('{}', { 'content-length': '1025' }), 413],
    [internalRequest(' '.repeat(1025)), 413],
    [internalRequest('not json'), 400],
    [internalRequest('null'), 400],
    [internalRequest('[]'), 400],
    [internalRequest('{"force":true}'), 400],
    [internalRequest('{"action":"unknown"}'), 400],
    [internalRequest('{"action":"catchup","force":true}'), 400],
    [internalRequest('{"action":"repair","ids":[]}'), 400],
    [internalRequest('{"action":"repair","ids":["not-an-id"]}'), 400],
    [internalRequest('{"action":"repair","ids":["123","123"]}'), 400],
    [internalRequest('{"action":"repair","ids":["123"],"force":true}'), 400],
    [internalRequest(JSON.stringify({ action: 'repair', ids: Array.from({ length: 21 }, (_, i) => String(100 + i)) })), 400],
  ];
  for (const [request, status] of cases) {
    const result = await internal.POST(request); assert.equal(result.status, status);
    assert.ok((await result.json()).error.code);
  }
  assert.equal(sqlite.prepare('SELECT count(*) n FROM entropy_control').get().n, 0);
});
test('private service status and disabled ticks whitelist summary without auto enabling or revealing notes', async () => {
  fakeKey(); let value = await store.getWorkbench();
  const state = structuredClone(value.state);
  state.bans[value.dataset.authors[0].id] = { reason: 'Public decision', internalNote: 'INTERNAL_ROUTE_PRIVATE_NOTE', at: new Date().toISOString() };
  value = await store.saveState(state, value.revision, 'owner');
  for (const result of [await internal.GET(), await internal.POST(internalRequest())]) {
    assert.equal(result.status, 200);
    const payload = await result.json(), text = JSON.stringify(payload);
    assert.deepEqual(Object.keys(payload).sort(), ['authors', 'connection', 'mode', 'posts', 'revision', 'sync', 'updatedAt']);
    assert.equal(payload.posts, 24); assert.equal(payload.sync.enabled, false);
    assert.ok(!text.includes(scope.TWITTERAPI_IO_KEY)); assert.ok(!text.includes('INTERNAL_ROUTE_PRIVATE_NOTE'));
    assert.ok(!('dataset' in payload)); assert.ok(!('state' in payload));
  }
  assert.equal(control().daily_attempts, 0);
});
async function withCycleClock(action) {
  const originalClock = Date.now, originalTimeout = globalThis.setTimeout;
  let now = Date.now() + 1000;
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay, ...args) => { now += Number(delay) || 0; queueMicrotask(() => callback(...args)); return { unref() {} }; };
  try { return await action({ now: () => now, advance: milliseconds => { now += milliseconds; } }); }
  finally { Date.now = originalClock; globalThis.setTimeout = originalTimeout; }
}
test('private service writer accepts absent or same origin, checks every due lane and preserves next due time', async () => withCycleClock(async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  let calls = 0; globalThis.fetch = async () => { calls++; return emptyProvider(); };
  const first = await internal.POST(internalRequest()); assert.equal(first.status, 200);
  const payload = await first.json(); assert.equal(calls, 3); assert.equal(payload.sync.attemptBudget.count, 3); assert.ok(payload.sync.lastSuccessAt);
  assert.equal(payload.sync.hourly.cycle.source, 'service'); assert.equal(payload.sync.hourly.cycle.status, 'complete');
  assert.equal(payload.sync.collectionHealth.allLanesCurrent, true);
  const again = await internal.POST(internalRequest('{}', { origin: 'https://entropy.example' })); assert.equal(again.status, 200);
  const unchanged = await again.json(); assert.equal(calls, 3); assert.equal(unchanged.revision, payload.revision);
  assert.equal(unchanged.sync.nextRunAt, payload.sync.nextRunAt); assert.equal(control().daily_attempts, 3);
}));
test('private service writer reports redacted server errors and does not resume paused collection', async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  globalThis.fetch = async () => ({ ok: false, status: 402 });
  const first = await internal.POST(internalRequest()); assert.equal(first.status, 200);
  const paused = await first.json(); assert.equal(paused.sync.paused, true); assert.equal(paused.sync.lastError.code, 'CREDITS_EXHAUSTED');
  const next = await internal.POST(internalRequest()); assert.equal(next.status, 200); assert.equal((await next.json()).sync.paused, true);
  assert.equal(control().daily_attempts, 1);
  scope.DB = { prepare() { throw new Error(scope.TWITTERAPI_IO_KEY); } };
  const unavailable = await internal.GET(); assert.equal(unavailable.status, 503);
  const text = await unavailable.text(); assert.ok(text.includes('STORE_UNAVAILABLE')); assert.ok(!text.includes(scope.TWITTERAPI_IO_KEY));
});

test('small edits write only changed rows even with thousands of stored posts', async () => {
  let value = await store.getWorkbench(); const dataset = structuredClone(value.dataset), template = dataset.posts[0];
  dataset.posts.push(...Array.from({ length: 2500 }, (_, i) => ({ ...template, id: 'sample:scale:' + i })));
  value = await store.importWorkbench({ dataset, expectedRevision: value.revision });
  const generation = control().generation;
  const rowsBefore = sqlite.prepare('SELECT count(*) n FROM entropy_records WHERE generation=?').get(generation).n;
  batchSizes = [];
  const state = structuredClone(value.state);
  state.bans[value.dataset.authors[0].id] = { reason: 'Manual review', at: new Date().toISOString() };
  const saved = await store.saveState(state, value.revision, 'owner');
  assert.equal(saved.dataset.posts.length, 2524); assert.equal(control().generation, generation);
  assert.deepEqual(batchSizes, [2]); // One decision record plus final atomic CAS.
  assert.equal(sqlite.prepare('SELECT count(*) n FROM entropy_records WHERE generation=?').get(generation).n, rowsBefore + 1);
});
test('incremental writes remove old chunks and deleted rows without leaving partial records', async () => {
  let value = await store.getWorkbench(), dataset = structuredClone(value.dataset);
  const postId = dataset.posts[0].id, removedPostId = dataset.posts[1].id;
  dataset.posts[0].body = '語'.repeat(300000);
  value = await store.importWorkbench({ dataset, expectedRevision: value.revision });
  const generation = control().generation;
  assert.ok(sqlite.prepare('SELECT count(*) n FROM entropy_records WHERE generation=? AND kind=? AND record_id=?').get(generation, 'post', postId).n > 1);
  dataset = structuredClone(value.dataset); dataset.posts.find(p => p.id === postId).body = 'Shortened';
  dataset.posts = dataset.posts.filter(p => p.id !== removedPostId);
  value = await store.importWorkbench({ dataset, expectedRevision: value.revision });
  assert.equal(control().generation, generation);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM entropy_records WHERE generation=? AND kind=? AND record_id=?').get(generation, 'post', postId).n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM entropy_records WHERE generation=? AND kind=? AND record_id=?').get(generation, 'post', removedPostId).n, 0);
  assert.equal(value.dataset.posts.find(p => p.id === postId).body, 'Shortened');
});
test('a stale incremental batch cannot resurrect a decision deleted by a newer edit', { timeout: 5000 }, async () => {
  let value = await store.getWorkbench(); const id = value.dataset.authors[0].id;
  const state = structuredClone(value.state); state.bans[id] = { reason: 'Initial reason', at: new Date().toISOString() };
  value = await store.saveState(state, value.revision, 'owner');
  let release, enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  beforeBatch = async () => { beforeBatch = null; enteredResolve(); await new Promise(resolve => { release = resolve; }); };
  const staleState = structuredClone(value.state); staleState.bans[id].reason = 'Stale replacement';
  const stale = store.saveState(staleState, value.revision, 'owner'); await entered;
  const freshState = structuredClone(value.state); delete freshState.bans[id];
  const fresh = await store.saveState(freshState, value.revision, 'owner');
  release(); await assert.rejects(stale, error => error.code === 'CONFLICT');
  const final = await store.getWorkbench(); assert.equal(final.revision, fresh.revision); assert.equal(final.state.bans[id], undefined);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM entropy_records WHERE generation=? AND kind=? AND record_id=?').get(control().generation, 'state:bans', id).n, 0);
});

function backfillRequest(payload, headers = {}) {
  return new Request('https://entropy.example/internal/backfill', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-entropy-update': '1', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}
const historicalRange = (now = Date.now(), requestLimit = 250) => ({
  start: new Date(now - 2 * 86400000).toISOString(), endExclusive: new Date(now - 1000).toISOString(), requestLimit, lanes: ['direct'],
});
const emptySearchPage = () => ({ ok: true, status: 200, json: async () => ({ status: 'success', tweets: [], has_next_page: false, next_cursor: '' }) });
test('default history scans all three lanes independently and validates explicit lane scope before reserving attempts', async () => {
  const clock = Date.now; let now = Date.parse('2026-11-18T12:20:00Z'); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    const range = { start: '2026-11-18T11:20:00Z', endExclusive: '2026-11-18T12:19:00Z', requestLimit: 10 };
    for (const lanes of [[], ['other'], ['direct', 'direct'], ['direct', 'evidence', 'context', 'other']])
      await assert.rejects(store.startBackfill({ ...range, lanes }), error => error.code === 'INVALID_INPUT');
    assert.equal(control().daily_attempts, 0);
    value = await store.startBackfill(range);
    assert.deepEqual(value.sync.backfill.lanes, ['direct', 'evidence', 'context']);
    assert.equal(value.sync.backfill.pendingWindows.length, 3);
    const queries = [];
    globalThis.fetch = async url => { queries.push(new URL(url).searchParams.get('query')); return emptySearchPage(); };
    for (let step = 0; step < 3; step++) {
      now += 6000; value = await store.runBackfill();
      assert.equal(value.sync.backfill.requestCount, step + 1);
      if (step < 2) assert.notEqual(value.sync.backfill.status, 'complete');
    }
    assert.equal(value.sync.backfill.status, 'complete');
    assert.equal(value.sync.backfill.pendingWindows.length, 0);
    assert.ok(queries.some(query => query.startsWith('@entropyIO ')));
    assert.ok(queries.some(query => query.startsWith('(url:entropy.io ')));
    assert.ok(queries.some(query => query.startsWith('Entropy ')));
    assert.equal(control().daily_attempts, 3);
  } finally { Date.now = clock; }
});
test('historical jobs require a key and enabled collection, validate a fixed cutoff, and start idempotently without paid calls', async () => {
  const range = historicalRange(); const value = await store.getWorkbench();
  await assert.rejects(store.startBackfill(range), error => error.code === 'KEY_REQUIRED');
  fakeKey(); await assert.rejects(store.startBackfill(range), error => error.code === 'COLLECTOR_DISABLED');
  await store.setCollector(true, value.revision);
  await assert.rejects(store.startBackfill({ ...range, endExclusive: new Date(Date.now() + 60000).toISOString() }), error => error.code === 'INVALID_INPUT');
  await assert.rejects(store.startBackfill({ ...range, requestLimit: 1001 }), error => error.code === 'INVALID_INPUT');
  const first = await store.startBackfill(range), again = await store.startBackfill(range);
  assert.equal(again.revision, first.revision); assert.equal(again.sync.backfill.id, first.sync.backfill.id);
  assert.equal(first.sync.backfill.status, 'running'); assert.equal(first.sync.backfill.requestCount, 0);
  assert.equal(first.sync.backfill.totalRequests, 0); assert.equal(control().daily_attempts, 0);
  assert.equal((await store.getStatus()).sync.backfill.nextStepAt, first.sync.backfill.nextStepAt);
});
test('accelerated steps preserve their own progress while hourly discovery keeps the latest slot', async () => {
  const clock = Date.now, base = Date.now(); let now = base;
  Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    value = await store.startBackfill(historicalRange(base));
    let calls = 0;
    globalThis.fetch = async url => {
      calls++; assert.equal(control().daily_attempts, calls); assert.ok(control().lease_token); assert.ok(control().lease_until > now);
      if (calls === 1) {
        assert.equal(new URL(url).pathname, '/twitter/tweet/advanced_search');
        assertTweetOnlySearch(url);
      } else assertTweetOnlySearch(url);
      return emptySearchPage();
    };
    const early = await store.runBackfill(); assert.equal(early.revision, value.revision); assert.ok(Date.parse(early.sync.backfill.nextStepAt) > now);
    assert.equal(calls, 0); assert.equal(control().daily_attempts, 0);
    now += 6000; const first = await store.runBackfill();
    assert.equal(calls, 1); assert.equal(first.sync.backfill.requestCount, 1); assert.equal(first.sync.backfill.successfulPages, 1);
    assert.equal(control().lease_token, null); assert.equal(first.sync.attemptBudget.count, 1);
    const tooSoon = await store.runBackfill(); assert.equal(calls, 1); assert.equal(tooSoon.revision, first.revision);
    // An active historic job cannot replace the new-post hourly search.
    now += 6000; const hourly = await store.runSync();
    assert.equal(calls, 2); assert.equal(hourly.sync.backfill.requestCount, 1); assert.equal(hourly.sync.attemptBudget.count, 2);
    assert.ok(hourly.sync.hourly.lastSuccessAt); assert.ok(hourly.sync.hourly.lastAttemptAt);
  } finally { Date.now = clock; }
});
test('historical daily cap and stopped jobs never access the provider; only an explicit limit extension resumes', async () => {
  const clock = Date.now, base = Date.now(); let now = base;
  Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    const range = historicalRange(base, 1); value = await store.startBackfill(range); now += 6000;
    sqlite.prepare('UPDATE entropy_control SET daily_date=?,daily_attempts=216').run(new Date(now).toISOString().slice(0, 10));
    await assert.rejects(store.runBackfill(), error => error.code === 'FRESH_DISCOVERY_RESERVE');
    sqlite.prepare('UPDATE entropy_control SET daily_attempts=0').run();
    let calls = 0; globalThis.fetch = async () => { calls++; return emptySearchPage(); };
    const limited = await store.runBackfill(); assert.equal(limited.sync.backfill.status, 'request-limit'); assert.equal(calls, 1);
    now += 6000; const stopped = await store.runBackfill(); assert.equal(stopped.sync.backfill.status, 'request-limit'); assert.equal(calls, 1);
    const resumed = await store.startBackfill({ ...range, requestLimit: 2 });
    assert.equal(resumed.sync.backfill.status, 'running'); assert.equal(resumed.sync.backfill.requestCount, 1);
    assert.equal(control().daily_attempts, 1); now += 6000;
    await store.runBackfill(); assert.equal(calls, 2);
  } finally { Date.now = clock; }
});
test('historical collection stops at the fresh-discovery reserve, including a racing allowance claim', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    await store.startBackfill(historicalRange(now)); now += 6000;
    const today = new Date(now).toISOString().slice(0, 10);
    sqlite.prepare('UPDATE entropy_control SET daily_date=?,daily_attempts=215').run(today);
    let calls = 0; globalThis.fetch = async () => { calls++; return emptySearchPage(); };
    value = await store.runBackfill(); assert.equal(calls, 1); assert.equal(control().daily_attempts, 216);
    now += 6000;
    await assert.rejects(store.runBackfill(), error => error.code === 'FRESH_DISCOVERY_RESERVE');
    assert.equal(calls, 1); assert.equal(control().daily_attempts, 216);
    await store.runSync(undefined, true); assert.equal(calls, 2); assert.equal(control().daily_attempts, 217);
    now += 6000;
    sqlite.prepare('UPDATE entropy_control SET daily_attempts=215').run();
    let raced = false;
    scope.DB = { ...database, prepare(sql) {
      const statement = database.prepare(sql);
      if (sql.startsWith('UPDATE entropy_control SET lease_token=') && sql.includes('daily_attempts=CASE')) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args), run = bound.run.bind(bound);
          bound.run = async () => {
            raced = true; sqlite.prepare('UPDATE entropy_control SET daily_attempts=216').run();
            return run();
          };
          return bound;
        };
      }
      return statement;
    } };
    await assert.rejects(store.runBackfill(), error => error.code === 'FRESH_DISCOVERY_RESERVE');
    assert.equal(raced, true); assert.equal(calls, 2); assert.equal(control().daily_attempts, 216);
    assert.equal(control().lease_token, null);
  } finally { scope.DB = database; Date.now = clock; }
});
test('historical auth failures pause without leaking response contents or restarting on hourly ticks', async () => {
  const clock = Date.now, base = Date.now(); let now = base;
  Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    await store.startBackfill(historicalRange(base)); now += 6000;
    let calls = 0; globalThis.fetch = async () => { calls++; return { ok: false, status: 402, json: async () => ({ secret: scope.TWITTERAPI_IO_KEY }) }; };
    const paused = await store.runBackfill(); assert.equal(paused.sync.paused, true); assert.equal(paused.sync.backfill.status, 'paused');
    assert.equal(paused.sync.backfill.requestCount, 1); assert.equal(paused.sync.backfill.lastError.code, 'CREDITS_EXHAUSTED');
    assert.ok(!JSON.stringify(paused).includes(scope.TWITTERAPI_IO_KEY)); assert.equal(control().daily_attempts, 1);
    await assert.rejects(store.runBackfill(), error => error.code === 'COLLECTOR_PAUSED');
    await store.runSync(); assert.equal(calls, 1);
  } finally { Date.now = clock; }
});
test('historical route validates bounded explicit intent before storage and exposes only a summary', async () => {
  for (const [request, status] of [
    [backfillRequest({ action: 'step' }, { 'x-entropy-update': '' }), 403],
    [backfillRequest({ action: 'step' }, { origin: 'https://evil.example' }), 403],
    [backfillRequest({ action: 'step' }, { 'content-type': 'application/json-invalid' }), 415],
    [backfillRequest(' '.repeat(2049)), 413],
    [backfillRequest('null'), 400], [backfillRequest({ action: 'step', force: true }), 400],
    [backfillRequest({ action: 'start', unexpected: true }), 400],
  ]) assert.equal((await backfill.POST(request)).status, status);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM entropy_control').get().n, 0);
  fakeKey(); let value = await store.getWorkbench(); const state = structuredClone(value.state);
  state.bans[value.dataset.authors[0].id] = { reason: 'Visible reason', internalNote: 'PRIVATE_BACKFILL_NOTE', at: new Date().toISOString() };
  value = await store.saveState(state, value.revision, 'owner'); await store.setCollector(true, value.revision);
  const started = await backfill.POST(backfillRequest({ action: 'start', ...historicalRange() })); assert.equal(started.status, 200);
  for (const result of [started, await backfill.GET()]) {
    const payload = await result.json(), text = JSON.stringify(payload);
    assert.deepEqual(Object.keys(payload).sort(), ['authors', 'connection', 'mode', 'posts', 'revision', 'sync', 'updatedAt']);
    assert.ok(payload.sync.backfill.nextStepAt); assert.ok(!text.includes(scope.TWITTERAPI_IO_KEY)); assert.ok(!text.includes('PRIVATE_BACKFILL_NOTE'));
    assert.ok(!text.includes('Visible reason')); assert.ok(!('dataset' in payload)); assert.ok(!('state' in payload));
  }
  assert.equal(control().daily_attempts, 0);
});
test('explicit cancellation works without a key, preserves progress and costs, and never enables collection', async () => {
  const clock = Date.now, base = Date.now(); let now = base;
  Date.now = () => now;
  try {
    const initial = await store.cancelBackfill(); assert.equal(initial.sync.enabled, false); assert.equal(initial.revision, 0);
    fakeKey(); let value = await store.setCollector(true, initial.revision);
    const range = historicalRange(base, 1); value = await store.startBackfill(range);
    now += 6000; globalThis.fetch = async () => emptySearchPage(); value = await store.runBackfill();
    const before = structuredClone(value.sync.backfill);
    value = await store.setCollector(false, value.revision); delete scope.TWITTERAPI_IO_KEY;
    const cancelled = await store.cancelBackfill(value.revision);
    assert.equal(cancelled.sync.enabled, false); assert.equal(cancelled.sync.backfill.status, 'cancelled');
    for (const field of ['requestCount', 'requestLimit', 'successfulPages', 'addedPosts', 'pendingWindows', 'completedRanges', 'gaps']) assert.deepEqual(cancelled.sync.backfill[field], before[field]);
    assert.equal(cancelled.sync.backfill.nextAttemptAt, null); assert.ok(cancelled.sync.backfill.cancelledAt);
    assert.equal(control().daily_attempts, 1); assert.equal(cancelled.sync.attemptBudget.count, 1);
    const again = await store.cancelBackfill(cancelled.revision); assert.equal(again.revision, cancelled.revision);
    await assert.rejects(store.cancelBackfill(value.revision), error => error.code === 'CONFLICT');
    await store.runSync(); assert.equal(control().daily_attempts, 1);
  } finally { Date.now = clock; }
});
test('cancellation respects a live lease and fences a worker after expiry without losing its reserved attempt', { timeout: 5000 }, async () => {
  const clock = Date.now, base = Date.now(); let now = base;
  Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    value = await store.startBackfill(historicalRange(base)); now += 6000;
    let release, enteredResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    globalThis.fetch = async () => { enteredResolve(); return new Promise(resolve => { release = () => resolve(emptySearchPage()); }); };
    const pending = store.runBackfill(); await entered;
    await assert.rejects(store.cancelBackfill(value.revision), error => error.code === 'SYNC_BUSY');
    assert.equal(control().daily_attempts, 1);
    sqlite.prepare('UPDATE entropy_control SET lease_until=?').run(now - 1);
    const cancelled = await store.cancelBackfill(value.revision);
    release(); await assert.rejects(pending, error => error.code === 'CONFLICT');
    const final = await store.getWorkbench(); assert.equal(final.revision, cancelled.revision); assert.equal(final.sync.backfill.status, 'cancelled');
    assert.equal(control().daily_attempts, 1); assert.equal(control().lease_token, null);
  } finally { Date.now = clock; }
});
test('method changes require cancellation and retain only five safe job summaries', async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  const range = historicalRange();
  await assert.rejects(store.startBackfill({ ...range, method: 'unknown' }), error => error.code === 'INVALID_INPUT');
  value = await store.startBackfill({ ...range, method: 'search' }); const firstId = value.sync.backfill.id;
  await assert.rejects(store.startBackfill({ ...range, method: 'mentions' }), error => error.code === 'INVALID_INPUT');
  value = await store.cancelBackfill(value.revision);
  const cancelledId = value.sync.backfill.id;
  value = await store.startBackfill({ ...range, method: 'mentions' });
  assert.equal(value.sync.backfill.method, 'mentions'); assert.notEqual(value.sync.backfill.id, firstId);
  assert.equal(value.sync.backfillHistory.length, 1); assert.equal(value.sync.backfillHistory[0].id, cancelledId);
  assert.equal(value.sync.backfillHistory[0].status, 'cancelled');
  assert.ok(!('pendingWindows' in value.sync.backfillHistory[0])); assert.ok(!('lastError' in value.sync.backfillHistory[0]));
  for (let i = 1; i <= 6; i++) {
    value = await store.cancelBackfill(value.revision);
    value = await store.startBackfill({ ...range, start: new Date(Date.parse(range.start) - i * 1000).toISOString(), method: 'mentions' });
  }
  assert.equal(value.sync.backfillHistory.length, 5); assert.equal(value.sync.enabled, true); assert.equal(control().daily_attempts, 0);
  assert.ok(value.sync.backfillHistory.every(job => job.status === 'cancelled' && Array.isArray(job.gaps)));
  const cancelled = await backfill.POST(backfillRequest({ action: 'cancel', expectedRevision: value.revision }));
  assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).sync.backfill.status, 'cancelled');
  const malformed = await backfill.POST(backfillRequest({ action: 'cancel', force: true })); assert.equal(malformed.status, 400);
});

const hourlyClockStart = () => Math.floor(Date.now() / 3600000) * 3600000 + 20 * 60000;
function discoveryTweet(now, id = '1900000000000000001', age = 60000) {
  return { id, text: 'A useful @entropyIO post.', createdAt: new Date(now - age).toISOString(),
    author: { id: '1000000000000000001', userName: 'newcreator', name: 'New Creator', followers: 10 },
    viewCount: 100, likeCount: 2, retweetCount: 0, quoteCount: 0, replyCount: 1, bookmarkCount: 0 };
}
function discoveryResponse(tweets, hasNextPage = false, cursor = '') {
  return { ok: true, status: 200, json: async () => ({ status: 'success', tweets, has_next_page: hasNextPage, next_cursor: cursor }) };
}
function assertTweetOnlySearch(url) {
  const target = new URL(url), query = target.searchParams.get('query');
  assert.equal(target.pathname, '/twitter/tweet/advanced_search');
  assert.ok(query.startsWith('@entropyIO ')); assert.ok(query.includes('-filter:replies'));
  assert.ok(query.includes('-filter:nativeretweets')); assert.match(query, /since_time:\d+ until_time:\d+/);
  assert.equal(target.searchParams.get('queryType'), 'Latest');
  return query;
}
function assertDiscoveryUnchanged(actual, expected) {
  // Maintenance deadlines derive from the latest commit's spacing, so a
  // metrics commit may move them without changing discovery checkpoints.
  const stable = ({ nextAttemptAt, catchupNextAttemptAt, ...rest }) => rest;
  assert.deepEqual(stable(actual), stable(expected));
  assert.ok(Date.parse(actual.nextAttemptAt) >= Date.parse(expected.nextAttemptAt));
  assert.equal(actual.catchupNextAttemptAt, actual.nextAttemptAt);
}
function patchSyncFixture(patch) {
  const row = sqlite.prepare('SELECT payload FROM entropy_records WHERE generation=? AND kind=? AND record_id=? AND chunk_index=0').get(control().generation, 'sync', 'main');
  const sync = { ...JSON.parse(row.payload), ...patch };
  sqlite.prepare('UPDATE entropy_records SET payload=? WHERE generation=? AND kind=? AND record_id=? AND chunk_index=0').run(JSON.stringify(sync), control().generation, 'sync', 'main');
}
test('owner link recovery accepts untagged official evidence and quarantines ambiguous Entropy posts', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision); now += 6000;
    const ids = ['1900000000000000101', '1900000000000000102', '1900000000000000103', '1900000000000000104'];
    const linked = { ...discoveryTweet(now, ids[0]), text: 'This new exchange is worth trying https://t.co/example', entities: { urls: [{ expanded_url: 'https://pro.entropy.io/?r=creator' }] } };
    const quoted = { ...discoveryTweet(now, ids[1]), text: 'A useful community announcement', quoted_tweet: { id: '2122649707138965603', author: { userName: 'entropyIO' } } };
    const pending = { ...discoveryTweet(now, ids[2]), text: 'PRIVATE_PENDING: Entropy might be early' };
    const unrelated = { ...discoveryTweet(now, ids[3]), text: 'Entropy custody news https://entropy.xyz/' };
    let calls = 0; globalThis.fetch = async () => { calls++; return discoveryResponse([linked, quoted, pending, unrelated]); };
    const noIdentity = new Request('https://entropy.example/api/repair', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://entropy.example' }, body: JSON.stringify({ ids, expectedRevision: value.revision }) });
    assert.equal((await api.POST(noIdentity, context('repair'))).status, 401);
    assert.equal((await api.POST(browserRequest('repair', { ids }), context('repair'))).status, 400);
    assert.equal((await api.POST(browserRequest('repair', { ids, expectedRevision: value.revision - 1 }), context('repair'))).status, 409);
    assert.equal(calls, 0);
    const response = await api.POST(browserRequest('repair', { ids, expectedRevision: value.revision }), context('repair'));
    assert.equal(response.status, 200); value = await response.json();
    assert.equal(calls, 1); assert.equal(value.sync.postRepair.accepted, 2); assert.equal(value.sync.postRepair.queuedForReview, 1);
    assert.equal(value.sync.postRepair.notRelevant, 1); assert.equal(value.sync.postRepair.addedPosts, 3);
    const stored = await store.getWorkbench();
    assert.equal(stored.dataset.posts.find(post => post.id === ids[2]).relevance.status, 'review');
    let publicSnapshot = await store.getCommunityPreview();
    assert.ok(publicSnapshot.public.posts.some(post => post.id === ids[0]));
    assert.ok(publicSnapshot.public.posts.some(post => post.id === ids[1]));
    assert.ok(!publicSnapshot.public.posts.some(post => [ids[2], ids[3]].includes(post.id)));
    assert.ok(!JSON.stringify(publicSnapshot).includes('PRIVATE_PENDING'));
    const reviewed = structuredClone(stored.state);
    reviewed.postRelevance[ids[2]] = { action: 'approve', authorId: pending.author.id, reason: 'Confirmed the project manually', internalNote: 'PRIVATE_REVIEW_NOTE', at: new Date(now).toISOString() };
    await store.saveState(reviewed, stored.revision, 'owner');
    publicSnapshot = await store.getCommunityPreview();
    assert.ok(publicSnapshot.public.posts.some(post => post.id === ids[2]));
    assert.ok(!JSON.stringify(publicSnapshot).includes('PRIVATE_REVIEW_NOTE'));
  } finally { Date.now = clock; }
});
test('exact-ID recovery adds only owned direct mentions, retaining moderation and hourly checkpoints', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench();
    const state = structuredClone(value.state), authorId = value.dataset.authors[0].id;
    state.bans[authorId] = { reason: 'Keep existing decision', internalNote: 'PRIVATE_REPAIR_NOTE', at: new Date(now).toISOString() };
    value = await store.saveState(state, value.revision, 'owner'); value = await store.setCollector(true, value.revision);
    const hourly = { nextRunAt: new Date(now + 3600000).toISOString(), lastSuccessAt: new Date(now - 1000).toISOString(), pendingWindows: [] };
    patchSyncFixture({ hourly }); now += 6000;
    const ids = Array.from({ length: 6 }, (_, i) => '190000000000000000' + (i + 1));
    const first = discoveryTweet(now, ids[0], 2 * 86400000);
    first.text = 'Original post about @entropyIO with the complete long body.'; first.isReply = false;
    const quote = { ...discoveryTweet(now, ids[1]), quoted_tweet: { text: 'Quoted context' }, isReply: false };
    const reply = { ...discoveryTweet(now, ids[2]), isReply: false, inReplyToId: ids[0] };
    const repost = { ...discoveryTweet(now, ids[3]), isRetweet: true };
    const unrelated = { ...discoveryTweet(now, ids[4]), text: 'A post on another topic', quoted_tweet: { text: '@entropyIO' } };
    let calls = 0;
    globalThis.fetch = async url => {
      calls++; const target = new URL(url);
      assert.equal(target.pathname, '/twitter/tweets'); assert.deepEqual(target.searchParams.get('tweet_ids').split(','), ids);
      assert.equal(control().daily_attempts, 1); assert.ok(control().lease_token);
      return discoveryResponse([first, quote, reply, repost, unrelated]);
    };
    const response = await internal.POST(internalRequest(JSON.stringify({ action: 'repair', ids })));
    assert.equal(response.status, 200); const summary = await response.json();
    assert.deepEqual(summary.sync.postRepair, { status: 'complete', requested: 6, returned: 5, matched: 2, accepted: 2, queuedForReview: 0, addedPosts: 2,
      ignoredReplies: 1, ignoredReposts: 1, notRelevant: 1, unavailable: 1,
      lastAttemptAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString(), nextAttemptAt: null, lastError: null });
    assert.equal(summary.posts, 26); assert.equal(calls, 1); assert.ok(!('dataset' in summary)); assert.ok(!('state' in summary));
    assert.ok(!JSON.stringify(summary).includes('PRIVATE_')); assert.ok(!JSON.stringify(summary).includes(scope.TWITTERAPI_IO_KEY));
    value = await store.getWorkbench();
    assert.ok(value.dataset.posts.some(post => post.id === ids[0] && post.body === first.text));
    assert.ok(value.dataset.posts.some(post => post.id === ids[1]));
    assert.ok(!value.dataset.posts.some(post => ids.slice(2).includes(post.id)));
    assert.equal(value.state.bans[authorId].internalNote, 'PRIVATE_REPAIR_NOTE'); assert.deepEqual(value.sync.hourly.pendingWindows, []);
    assert.equal(value.sync.hourly.lastSuccessAt, hourly.lastSuccessAt); assert.equal(value.sync.hourly.nextRunAt, hourly.nextRunAt);
    assert.equal(control().daily_attempts, 1); assert.equal(control().lease_token, null);
    await assert.rejects(store.runPostRepair(ids), error => error.code === 'REPAIR_NOT_DUE'); assert.equal(calls, 1);
  } finally { Date.now = clock; }
});
test('exact-ID recovery respects disabled collection, fresh reserve, and redacts provider failures', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  const ids = ['1900000000000000001'];
  try {
    await assert.rejects(store.runPostRepair([]), error => error.code === 'INVALID_INPUT');
    assert.equal(sqlite.prepare('SELECT count(*) n FROM entropy_control').get().n, 0);
    let value = await store.getWorkbench(); fakeKey();
    await assert.rejects(store.runPostRepair(ids), error => error.code === 'COLLECTOR_DISABLED');
    value = await store.setCollector(true, value.revision); now += 6000;
    sqlite.prepare('UPDATE entropy_control SET daily_date=?,daily_attempts=216').run(new Date(now).toISOString().slice(0, 10));
    await assert.rejects(store.runPostRepair(ids), error => error.code === 'FRESH_DISCOVERY_RESERVE');
    sqlite.prepare('UPDATE entropy_control SET daily_attempts=0').run();
    let calls = 0; globalThis.fetch = async () => { calls++; return { ok: false, status: 402, json: async () => ({ secret: scope.TWITTERAPI_IO_KEY }) }; };
    value = await store.runPostRepair(ids);
    assert.equal(value.sync.paused, true); assert.equal(value.sync.postRepair.lastError.code, 'CREDITS_EXHAUSTED');
    assert.equal(value.dataset.posts.length, 24); assert.equal(calls, 1); assert.equal(control().daily_attempts, 1); assert.equal(control().lease_token, null);
    assert.ok(!JSON.stringify(value).includes(scope.TWITTERAPI_IO_KEY));
    await assert.rejects(store.runPostRepair(ids), error => error.code === 'COLLECTOR_PAUSED'); assert.equal(calls, 1);
  } finally { Date.now = clock; }
});
test('exact-ID recovery classifies existing untyped replies without adding new replies or erasing moderation', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    let value = await store.getWorkbench(); const existing = value.dataset.posts[0];
    const author = value.dataset.authors.find(author => author.id === existing.authorId);
    assert.notEqual(existing.isReply, true); assert.ok(!existing.inReplyToId);
    const state = structuredClone(value.state);
    state.postExclusions[existing.id] = { authorId: existing.authorId, reason: 'Keep manual reason', at: new Date(now).toISOString() };
    value = await store.saveState(state, value.revision, 'owner');
    fakeKey(); value = await store.setCollector(true, value.revision); now += 6000;
    const newReplyId = '1900000000000000002';
    const rawExisting = { ...discoveryTweet(now, existing.id), isReply: false, inReplyToId: '1900000000000000000',
      author: { id: '1000000000000000001', userName: author.handle.replace(/^@/, ''), followers: 10 } };
    const rawNewReply = { ...discoveryTweet(now, newReplyId), isReply: true,
      author: { id: '1000000000000000002', userName: 'newreplyauthor', followers: 2 } };
    globalThis.fetch = async () => discoveryResponse([rawExisting, rawNewReply]);
    value = await store.runPostRepair([existing.id, newReplyId]);
    const classified = value.dataset.posts.find(post => post.id === existing.id);
    assert.equal(classified.isReply, true); assert.equal(classified.inReplyToId, '1900000000000000000');
    assert.equal(classified.authorId, existing.authorId); assert.equal(value.dataset.posts.length, 24);
    assert.ok(!value.dataset.posts.some(post => post.id === newReplyId));
    assert.equal(value.state.postExclusions[existing.id].reason, 'Keep manual reason');
    assert.equal(value.sync.postRepair.accepted, 0); assert.equal(value.sync.postRepair.ignoredReplies, 2);
    const restored = structuredClone(value.state); delete restored.postExclusions[existing.id];
    value = await store.saveState(restored, value.revision, 'owner');
    const snapshot = await store.getCommunityPreview();
    assert.ok(!snapshot.public.posts.some(post => post.id === existing.id));
    assert.equal(control().daily_attempts, 1);
  } finally { Date.now = clock; }
});
test('hourly discovery checks new mentions even with a metrics backlog and preserves moderation', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench();
    const state = structuredClone(value.state), authorId = value.dataset.authors[0].id;
    state.bans[authorId] = { reason: 'Existing public reason', internalNote: 'PRIVATE_STAYS_PRIVATE', at: new Date(now).toISOString() };
    value = await store.saveState(state, value.revision, 'owner'); value = await store.setCollector(true, value.revision);
    const pendingIds = value.dataset.posts.map(post => post.id);
    patchSyncFixture({ phase: 'refresh', refresh: { pendingIds, cycleStartedAt: new Date(now).toISOString() } });
    let calls = 0;
    globalThis.fetch = async url => {
      calls++; const query = assertTweetOnlySearch(url);
      assert.ok(Number(query.match(/until_time:(\d+)/)[1]) * 1000 <= now);
      return discoveryResponse([discoveryTweet(now)]);
    };
    const result = await store.runSync(undefined, true);
    assert.equal(calls, 1); assert.equal(result.dataset.posts.length, 25); assert.deepEqual(result.sync.refresh.pendingIds, pendingIds);
    assert.equal(result.state.bans[authorId].reason, 'Existing public reason');
    assert.equal(result.state.bans[authorId].internalNote, 'PRIVATE_STAYS_PRIVATE');
    assert.equal(result.sync.collectionHealth.policy, 'new-mentions-first'); assert.equal(result.sync.collectionHealth.freshness, 'partial');
    assert.equal(result.sync.hourly.lastSuccessAt, new Date(now).toISOString());
    now += 2 * 3600000; assert.equal((await store.getStatus()).sync.collectionHealth.freshness, 'stale');
  } finally { Date.now = clock; }
});
test('catch-up durably reserves one continuation page without moving the next hourly discovery deadline', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    globalThis.fetch = async () => discoveryResponse([discoveryTweet(now)], true, 'next-A');
    const latest = await store.runSync(undefined, true), nextRun = latest.sync.hourly.nextRunAt;
    assert.ok(latest.sync.hourly.pendingWindows.length); const lastSuccess = latest.sync.hourly.lastSuccessAt;
    let calls = 0;
    globalThis.fetch = async url => {
      calls++; assert.equal(new URL(url).searchParams.get('cursor'), 'next-A');
      assert.equal(control().daily_attempts, 2); assert.ok(control().lease_token);
      return discoveryResponse([discoveryTweet(now, '1900000000000000002', 180000)]);
    };
    const early = await store.runHourlyCatchup(); assert.equal(early.revision, latest.revision); assert.equal(calls, 0);
    now += 6000; const result = await store.runHourlyCatchup();
    assert.equal(calls, 1); assert.equal(result.dataset.posts.length, 26);
    assert.ok(!result.sync.hourly.pendingWindows.some(window => window.cursor === 'next-A'));
    assert.equal(result.sync.hourly.nextRunAt, nextRun); assert.equal(result.sync.nextRunAt, nextRun);
    assert.equal(result.sync.hourly.lastSuccessAt, lastSuccess); assert.ok(result.sync.hourly.catchupLastSuccessAt);
    assert.equal(control().lease_token, null); assert.equal(control().daily_attempts, 2);
    const after = await store.getWorkbench(); assert.equal(after.sync.hourly.nextRunAt, nextRun);
  } finally { Date.now = clock; }
});
test('catch-up serializes with new discovery and never exposes its lease token', { timeout: 5000 }, async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    globalThis.fetch = async () => discoveryResponse([discoveryTweet(now)], true, 'next-A');
    value = await store.runSync(undefined, true); now += 6000;
    let release, enteredResolve; const entered = new Promise(resolve => { enteredResolve = resolve; });
    globalThis.fetch = async () => { enteredResolve(); return new Promise(resolve => { release = () => resolve(discoveryResponse([])); }); };
    const pending = store.runHourlyCatchup(); await entered;
    const status = await store.getStatus(); assert.ok(Date.parse(status.sync.collectorBusyUntil) > now);
    assert.ok(!JSON.stringify(status).includes(control().lease_token));
    await assert.rejects(store.runSync(undefined, true), error => error.code === 'SYNC_BUSY');
    await assert.rejects(store.saveState(value.state, value.revision, 'owner'), error => error.code === 'SYNC_BUSY');
    release(); await pending; assert.equal(control().lease_token, null); assert.equal(control().daily_attempts, 2);
  } finally { Date.now = clock; }
});
test('maintenance preserves a daily allowance for fresh discovery and cannot take its due slot', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    globalThis.fetch = async () => discoveryResponse([discoveryTweet(now)], true, 'next-A');
    value = await store.runSync(undefined, true); now += 6000;
    sqlite.prepare('UPDATE entropy_control SET daily_date=?,daily_attempts=216').run(new Date(now).toISOString().slice(0, 10));
    let calls = 0; globalThis.fetch = async () => { calls++; return discoveryResponse([]); };
    await assert.rejects(store.runHourlyCatchup(), error => error.code === 'FRESH_DISCOVERY_RESERVE');
    await assert.rejects(store.runMetricsRefresh(), error => error.code === 'FRESH_DISCOVERY_RESERVE');
    assert.equal(calls, 0); assert.equal(control().daily_attempts, 216);
    const fresh = await store.runSync(undefined, true); assert.equal(calls, 1); assert.equal(control().daily_attempts, 217);
    now = Date.parse(fresh.sync.hourly.nextRunAt) + 1000;
    const before = control().daily_attempts; await store.runHourlyCatchup(); await store.runMetricsRefresh();
    assert.equal(calls, 1); assert.equal(control().daily_attempts, before);
  } finally { Date.now = clock; }
});
test('metrics maintenance adapts failed batches and keeps every queued ID without delaying fresh discovery', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    const ids = new Set(value.dataset.posts.map(post => post.id)), requestedSizes = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      globalThis.fetch = async url => { assertTweetOnlySearch(url); return discoveryResponse([]); };
      value = await store.runSync(undefined, true);
      const latest = structuredClone(value.sync.hourly), nextRun = value.sync.nextRunAt; now += 6000;
      globalThis.fetch = async url => {
        const target = new URL(url); assert.equal(target.pathname, '/twitter/tweets');
        requestedSizes.push(target.searchParams.get('tweet_ids').split(',').length);
        throw new DOMException('Do not expose provider text or the key', 'TimeoutError');
      };
      value = await store.runMetricsRefresh();
      assert.equal(value.sync.metricsRefresh.lastError.diagnosticCode, 'REQUEST_TIMEOUT');
      assert.equal(value.sync.metricsRefresh.batchSize, attempt ? 5 : 10);
      assert.equal(value.sync.metricsRefresh.pendingCount, ids.size);
      assert.deepEqual(new Set(value.sync.refresh.pendingIds), ids); assertDiscoveryUnchanged(value.sync.hourly, latest);
      assert.equal(value.sync.nextRunAt, nextRun); assert.equal(value.dataset.posts.length, ids.size);
      assert.equal(value.sync.paused, false); assert.ok(!JSON.stringify(value).includes(scope.TWITTERAPI_IO_KEY));
      // Fresh collection is aligned to :35; metrics retain their separate retry
      // deadline, so the second batch must wait for both to become eligible.
      now = Math.max(Date.parse(value.sync.hourly.nextRunAt), Date.parse(value.sync.metricsRefresh.nextRunAt) || 0) + 1000;
    }
    assert.deepEqual(requestedSizes, [20, 10]);
  } finally { Date.now = clock; }
});
test('metrics maintenance prunes saved reply and repost IDs from its queue while retaining original and quote posts', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    let value = await store.getWorkbench(), dataset = structuredClone(value.dataset);
    dataset.posts[0].isReply = true;
    dataset.posts[1].isReply = false; dataset.posts[1].inReplyToId = '1900000000000000000';
    dataset.posts[2].isRepost = true;
    dataset.posts[3].isQuote = true;
    const ignored = new Set(dataset.posts.slice(0, 3).map(post => post.id)), quoteId = dataset.posts[3].id;
    value = await store.importWorkbench({ dataset, expectedRevision: value.revision });
    fakeKey(); value = await store.setCollector(true, value.revision);
    globalThis.fetch = async () => discoveryResponse([]); value = await store.runSync(undefined, true);
    patchSyncFixture({ refresh: { pendingIds: value.dataset.posts.map(post => post.id) } }); now += 6000;
    let requested;
    globalThis.fetch = async url => {
      const target = new URL(url); assert.equal(target.pathname, '/twitter/tweets');
      requested = target.searchParams.get('tweet_ids').split(','); return discoveryResponse([]);
    };
    value = await store.runMetricsRefresh();
    assert.equal(requested.length, 20); assert.ok(requested.includes(quoteId));
    assert.ok(requested.every(id => !ignored.has(id)));
    assert.ok(value.sync.refresh.pendingIds.every(id => !ignored.has(id)));
    assert.equal(value.sync.metricsRefresh.pendingCount, 1); assert.equal(value.dataset.posts.length, 24);
    assert.equal(value.dataset.posts.find(post => post.id === dataset.posts[0].id).isReply, true);
    assert.equal(control().daily_attempts, 2);
  } finally { Date.now = clock; }
});
test('private maintenance actions remain disabled without collection and whitelist response contents', async () => {
  fakeKey(); let value = await store.getWorkbench(); const state = structuredClone(value.state);
  state.bans[value.dataset.authors[0].id] = { reason: 'Public decision', internalNote: 'MAINTENANCE_PRIVATE_NOTE', at: new Date().toISOString() };
  await store.saveState(state, value.revision, 'owner');
  for (const action of ['catchup', 'metrics']) {
    const response = await internal.POST(internalRequest(JSON.stringify({ action }))); assert.equal(response.status, 200);
    const payload = await response.json(), text = JSON.stringify(payload); assert.equal(payload.sync.enabled, false);
    assert.ok(!text.includes('MAINTENANCE_PRIVATE_NOTE')); assert.ok(!text.includes(scope.TWITTERAPI_IO_KEY));
    assert.ok(!('dataset' in payload)); assert.ok(!('state' in payload));
  }
  assert.equal(control().daily_attempts, 0);
});
test('successful metrics maintenance advances only its selected IDs and preserves the hourly discovery status', async () => {
  const clock = Date.now; let now = hourlyClockStart(); Date.now = () => now;
  try {
    fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
    globalThis.fetch = async () => discoveryResponse([]); value = await store.runSync(undefined, true);
    const hourly = structuredClone(value.sync.hourly), nextRun = value.sync.nextRunAt, before = structuredClone(value.dataset);
    now += 6000;
    globalThis.fetch = async url => {
      const target = new URL(url); assert.equal(target.pathname, '/twitter/tweets');
      assert.equal(target.searchParams.get('tweet_ids').split(',').length, 20);
      return discoveryResponse([]);
    };
    const result = await store.runMetricsRefresh();
    assert.equal(result.sync.metricsRefresh.lastSuccessAt, new Date(now).toISOString());
    assert.equal(result.sync.metricsRefresh.lastError, null); assert.equal(result.sync.metricsRefresh.pendingCount, 4);
    assert.equal(result.sync.refresh.pendingIds.length, 4); assertDiscoveryUnchanged(result.sync.hourly, hourly);
    assert.equal(result.sync.nextRunAt, nextRun); assert.equal(result.dataset.posts.length, before.posts.length);
    for (const post of before.posts) assert.deepEqual(result.dataset.posts.find(value => value.id === post.id).metrics, post.metrics);
    // A second call this hour is a read/no-op rather than another paid batch.
    const attempts = control().daily_attempts; now += 6000; await store.runMetricsRefresh(); assert.equal(control().daily_attempts, attempts);
  } finally { Date.now = clock; }
});

const queryLane = query => query.startsWith('@entropyIO ') ? 'direct' : query.startsWith('(url:entropy.io ') ? 'evidence' : 'context';
function cycleTweet(now, lane, index = 0) {
  const id = String(1900000000000010000n + BigInt((lane === 'direct' ? 0 : lane === 'evidence' ? 100 : 200) + index));
  return { ...discoveryTweet(now, id, (index + 1) * 60000),
    text: lane === 'direct' ? 'Useful @entropyIO research.' : lane === 'evidence' ? 'Useful product research https://t.co/product' : 'Entropy HIP-3 perpetual markets built on Hyperliquid.',
    ...(lane === 'evidence' ? { entities: { urls: [{ expanded_url: 'https://entropy.io/' }] } } : {}) };
}
test('unattended MCP cycle checks all fresh lanes before pagination despite old contextual history', async () => withCycleClock(async ({ now }) => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  const oldStart = new Date(now() - 86400000).toISOString(), oldEnd = new Date(now() - 80000000).toISOString();
  patchSyncFixture({ hourly: { queryPolicy: 'entropy-context-v1', lanes: {}, pendingWindows: [
    { id: 'old-context-history', discoveryLane: 'context', queryPolicy: 'entropy-context-v1', method: 'search', kind: 'audit', audit: true,
      query: 'Entropy -filter:replies -filter:nativeretweets since_time:1 until_time:2', start: oldStart, endExclusive: oldEnd, cursor: 'OLD-HISTORY-CURSOR', seenCursors: [] },
  ] } });
  const requests = [];
  globalThis.fetch = async url => {
    const target = new URL(url), query = target.searchParams.get('query'), lane = queryLane(query), cursor = target.searchParams.get('cursor');
    requests.push({ lane, cursor }); assert.notEqual(cursor, 'OLD-HISTORY-CURSOR');
    assert.ok(query.includes('-filter:replies')); assert.ok(query.includes('-filter:nativeretweets'));
    return discoveryResponse([cycleTweet(now(), lane, cursor ? 2 : 0)], !cursor, cursor ? '' : 'fresh-' + lane);
  };
  const response = await mcp.POST(new Request('https://entropy.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'entropy_sync', arguments: {} } }) }));
  const result = (await response.json()).result.structuredContent;
  assert.deepEqual(requests.map(value => value.lane), ['direct', 'evidence', 'context', 'direct', 'evidence', 'context']);
  assert.equal(result.sync.hourly.cycle.requestCount, 6); assert.equal(result.sync.hourly.cycle.source, 'mcp');
  assert.equal(result.sync.hourly.cycle.status, 'complete'); assert.ok(result.sync.hourly.cycle.finishedAt);
  assert.equal(result.sync.collectionHealth.allLanesCurrent, true); assert.equal(result.sync.collectionHealth.freshness, 'current');
  assert.ok(result.sync.hourly.pendingWindows.some(window => window.id === 'old-context-history'));
  const publicSnapshot = await store.getCommunityPreview();
  for (const lane of ['direct', 'evidence', 'context']) assert.ok(publicSnapshot.public.posts.some(post => post.id === cycleTweet(now(), lane).id));
  assert.equal(control().daily_attempts, 6); assert.equal(control().lease_token, null);
}));
test('busy fresh pagination is fair and bounded while every primary lane gets a slot', async () => withCycleClock(async ({ now }) => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  const requests = [], pages = { direct: 0, evidence: 0, context: 0 };
  globalThis.fetch = async url => {
    const target = new URL(url), lane = queryLane(target.searchParams.get('query'));
    requests.push(lane); const page = pages[lane]++;
    return discoveryResponse([cycleTweet(now(), lane, page)], true, lane + '-page-' + page);
  };
  value = await store.runHourlyCycle('service');
  assert.equal(requests.length, 9); assert.deepEqual(requests.slice(0, 3), ['direct', 'evidence', 'context']);
  assert.deepEqual(pages, { direct: 3, evidence: 3, context: 3 });
  assert.equal(value.sync.hourly.cycle.status, 'partial'); assert.equal(value.sync.hourly.cycle.stopCode, 'REQUEST_LIMIT');
  assert.equal(control().daily_attempts, 9); assert.equal(value.sync.collectionHealth.allLanesCurrent, true);
  assert.ok(['direct', 'evidence', 'context'].every(lane => value.sync.hourly.cycle.lanes[lane].pendingFreshWindows > 0));
}));
test('fresh pagination cannot consume the reserved first-page allowance for later hourly lanes', async () => withCycleClock(async ({ now, advance }) => {
  const day = Math.floor(now() / 86400000) * 86400000;
  advance(day + 13 * 3600000 + 5 * 60000 - now());
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  patchSyncFixture({ nextRunAt: new Date(now()).toISOString() });
  const limit = value.sync.collectionHealth.freshPaginationDailyLimit;
  sqlite.prepare('UPDATE entropy_control SET daily_date=?,daily_attempts=?').run(new Date(now()).toISOString().slice(0, 10), limit);
  const requests = [];
  globalThis.fetch = async url => { const lane = queryLane(new URL(url).searchParams.get('query')); requests.push(lane); return discoveryResponse([cycleTweet(now(), lane)], true, 'fresh-' + lane); };
  value = await store.runHourlyCycle('service');
  assert.deepEqual(requests, ['direct', 'evidence', 'context']); assert.equal(control().daily_attempts, limit + 3);
  assert.equal(value.sync.hourly.cycle.status, 'partial'); assert.equal(value.sync.hourly.cycle.stopCode, 'FRESH_DISCOVERY_RESERVE');
  assert.equal(value.sync.collectionHealth.freshDiscoveryReserve, 72); assert.equal(value.sync.collectionHealth.catchupDailyLimit, 216);
  assert.equal(value.sync.collectionHealth.freshPaginationReserve, 33); assert.equal(value.sync.collectionHealth.freshPaginationDailyLimit, 255);
}));
test('fresh pagination reserve follows the remaining :35 slots and resets at UTC midnight', async () => withCycleClock(async ({ now, advance }) => {
  const day = Math.floor(now() / 86400000) * 86400000;
  const cases = [
    [5 * 60000, 72, 216],
    [13 * 3600000 + 5 * 60000, 33, 255],
    [13 * 3600000 + 36 * 60000, 30, 258],
    [23 * 3600000 + 34 * 60000, 3, 285],
    [23 * 3600000 + 36 * 60000, 0, 288],
    [86400000 + 5 * 60000, 72, 216],
  ];
  for (const [offset, reserve, limit] of cases) {
    advance(day + offset - now());
    const status = await store.getStatus();
    assert.equal(status.sync.collectionHealth.freshPaginationReserve, reserve);
    assert.equal(status.sync.collectionHealth.freshPaginationDailyLimit, limit);
    assert.equal(reserve + limit, 288); assert.equal(status.sync.collectionHealth.catchupDailyLimit, 216);
  }
  assert.equal(control().daily_attempts, 0);
}));
test('221 spent requests still allow afternoon fresh pages without reopening historical maintenance', async () => withCycleClock(async ({ now, advance }) => {
  const day = Math.floor(now() / 86400000) * 86400000;
  advance(day + 13 * 3600000 + 5 * 60000 - now());
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  patchSyncFixture({ nextRunAt: new Date(now()).toISOString() });
  sqlite.prepare('UPDATE entropy_control SET daily_date=?,daily_attempts=221').run(new Date(now()).toISOString().slice(0, 10));
  const requests = [];
  globalThis.fetch = async url => {
    const target = new URL(url), lane = queryLane(target.searchParams.get('query')), cursor = target.searchParams.get('cursor');
    requests.push(lane); return discoveryResponse([cycleTweet(now(), lane, cursor ? 2 : 0)], !cursor, cursor ? '' : 'fresh-' + lane);
  };
  value = await store.runHourlyCycle('service');
  assert.deepEqual(requests, ['direct', 'evidence', 'context', 'direct', 'evidence', 'context']);
  assert.equal(control().daily_attempts, 227); assert.equal(value.sync.hourly.cycle.status, 'complete');
  assert.equal(value.sync.collectionHealth.freshPaginationDailyLimit, 255);
  assert.equal(value.sync.collectionHealth.freshPaginationReserve, 33);
  advance(6000);
  await assert.rejects(store.runHourlyCatchup(), error => error.code === 'FRESH_DISCOVERY_RESERVE');
  await assert.rejects(store.runMetricsRefresh(), error => error.code === 'FRESH_DISCOVERY_RESERVE');
  await assert.rejects(store.runPostRepair([value.dataset.posts[0].id]), error => error.code === 'FRESH_DISCOVERY_RESERVE');
  assert.equal(requests.length, 6); assert.equal(control().daily_attempts, 227);
}));
test('zero late-night reserve never raises the 288 hard cap and the next UTC day gets its own allowance', async () => withCycleClock(async ({ now, advance }) => {
  const day = Math.floor(now() / 86400000) * 86400000;
  advance(day + 23 * 3600000 + 36 * 60000 - now());
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  sqlite.prepare('UPDATE entropy_control SET daily_date=?,daily_attempts=288').run(new Date(now()).toISOString().slice(0, 10));
  let requests = 0; globalThis.fetch = async () => { requests++; return emptyProvider(); };
  await assert.rejects(store.runHourlyCycle('service'), error => error.code === 'DAILY_LIMIT');
  let status = await store.getStatus();
  assert.equal(status.sync.collectionHealth.freshPaginationReserve, 0); assert.equal(status.sync.collectionHealth.freshPaginationDailyLimit, 288);
  assert.equal(status.sync.attemptBudget.count, 288); assert.equal(requests, 0);
  advance(day + 86400000 + 5 * 60000 - now());
  status = await store.getStatus();
  assert.equal(status.sync.attemptBudget.count, 0); assert.equal(status.sync.collectionHealth.freshPaginationReserve, 72);
  value = await store.runHourlyCycle('mcp');
  assert.equal(requests, 3); assert.equal(control().daily_attempts, 3); assert.equal(value.sync.attemptBudget.count, 3);
  assert.equal(control().daily_date, new Date(now()).toISOString().slice(0, 10));
  assert.equal(value.sync.collectionHealth.freshPaginationDailyLimit, 216); assert.equal(value.sync.hourly.cycle.status, 'complete');
}));
test('one transient lane failure remains visible while other fresh lanes are checked', async () => withCycleClock(async ({ now }) => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  const requests = [];
  globalThis.fetch = async url => {
    const lane = queryLane(new URL(url).searchParams.get('query')); requests.push(lane);
    return lane === 'direct' ? { ok: false, status: 500 } : discoveryResponse([cycleTweet(now(), lane)]);
  };
  value = await store.runHourlyCycle('service');
  assert.deepEqual(requests, ['direct', 'evidence', 'context']); assert.equal(control().daily_attempts, 3);
  assert.equal(value.sync.hourly.cycle.status, 'partial'); assert.ok(value.sync.hourly.cycle.lanes.direct.primaryError);
  assert.equal(value.sync.collectionHealth.lanes.direct.freshness, 'error');
  assert.equal(value.sync.collectionHealth.lanes.context.freshness, 'current');
  assert.equal(value.sync.collectionHealth.freshness, 'error'); assert.equal(value.sync.collectionHealth.allLanesCurrent, false);
}));
test('failed contextual first page cannot stall healthy fresh continuations behind its retry deadline', async () => withCycleClock(async ({ now }) => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  const requests = [];
  globalThis.fetch = async url => {
    const target = new URL(url), lane = queryLane(target.searchParams.get('query')), cursor = target.searchParams.get('cursor');
    requests.push(lane);
    if (lane === 'context') return { ok: false, status: 503 };
    return discoveryResponse([cycleTweet(now(), lane, cursor ? 2 : 0)], !cursor, cursor ? '' : 'fresh-' + lane);
  };
  const started = now(); value = await store.runHourlyCycle('service');
  assert.deepEqual(requests, ['direct', 'evidence', 'context', 'direct', 'evidence']);
  assert.equal(control().daily_attempts, 5); assert.equal(value.sync.hourly.cycle.requestCount, 5);
  assert.equal(value.sync.hourly.cycle.status, 'partial'); assert.ok(value.sync.hourly.cycle.lanes.context.primaryError);
  assert.equal(value.sync.hourly.cycle.lanes.direct.pendingFreshWindows, 0);
  assert.equal(value.sync.hourly.cycle.lanes.evidence.pendingFreshWindows, 0);
  assert.ok(now() - started < 40000, 'a lane retry must not turn into a no-op spin');
}));
test('a new cycle first page honors durable spacing after the previous data commit', async () => withCycleClock(async ({ now }) => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  const committedAt = Date.parse(value.updatedAt), attempts = [];
  globalThis.fetch = async () => { attempts.push(now()); return emptyProvider(); };
  value = await store.runHourlyCycle('service');
  assert.equal(attempts.length, 3); assert.ok(attempts[0] - committedAt >= 5100);
  assert.ok(attempts[1] - attempts[0] >= 5100); assert.ok(attempts[2] - attempts[1] >= 5100);
  assert.equal(value.sync.hourly.cycle.status, 'complete');
}));
test('a manual early-hour cycle preserves the upcoming :35 automatic slot for every lane', async () => withCycleClock(async ({ now, advance }) => {
  const hour = Math.floor(now() / 3600000) * 3600000 + 3600000;
  advance(hour + 5 * 60000 - now());
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  const requests = [];
  globalThis.fetch = async url => { requests.push({ lane: queryLane(new URL(url).searchParams.get('query')), at: now() }); return emptyProvider(); };
  value = await store.runHourlyCycle('service');
  const upcoming = new Date(hour + 35 * 60000).toISOString();
  assert.equal(requests.length, 3);
  for (const lane of ['direct', 'evidence', 'context']) assert.equal(value.sync.hourly.lanes[lane].latestNextRunAt, upcoming);
  assert.equal(value.sync.hourly.nextRunAt, upcoming); assert.equal(value.sync.nextRunAt, upcoming);
  const manualRevision = value.revision;
  value = await store.runHourlyCycle('mcp');
  assert.equal(requests.length, 3); assert.equal(value.revision, manualRevision);
  advance(hour + 35 * 60000 + 1000 - now());
  value = await store.runHourlyCycle('mcp');
  assert.deepEqual(requests.map(request => request.lane), ['direct', 'evidence', 'context', 'direct', 'evidence', 'context']);
  assert.ok(requests.slice(3).every(request => request.at >= hour + 35 * 60000));
  const nextHour = new Date(hour + 3600000 + 35 * 60000).toISOString();
  for (const lane of ['direct', 'evidence', 'context']) assert.equal(value.sync.hourly.lanes[lane].latestNextRunAt, nextHour);
  assert.equal(value.sync.hourly.nextRunAt, nextHour); assert.equal(value.sync.nextRunAt, nextHour);
  const automaticRevision = value.revision;
  value = await store.runHourlyCycle('mcp');
  assert.equal(requests.length, 6); assert.equal(control().daily_attempts, 6); assert.equal(value.revision, automaticRevision);
}));
test('failed primary scheduling and provider cooldown are not shortened to the next :35 boundary', async () => withCycleClock(async ({ now, advance }) => {
  const hour = Math.floor(now() / 3600000) * 3600000 + 3600000;
  advance(hour + 5 * 60000 - now());
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  let requests = 0; globalThis.fetch = async () => { requests++; return { ok: false, status: 429 }; };
  value = await store.runHourlyCycle('service');
  const lane = value.sync.hourly.lanes.direct;
  assert.ok(lane.latestError); assert.ok(Date.parse(lane.latestNextRunAt) >= hour + 3600000);
  assert.notEqual(lane.latestNextRunAt, new Date(hour + 35 * 60000).toISOString());
  assert.equal(lane.latestNextAttemptAt, value.sync.hourly.providerNextAttemptAt);
  assert.ok(Date.parse(value.sync.hourly.providerNextAttemptAt) > now());
  const deadlines = [lane.latestNextRunAt, lane.latestNextAttemptAt, value.sync.hourly.providerNextAttemptAt];
  const revision = value.revision; value = await store.runHourlyCycle('mcp');
  assert.deepEqual([value.sync.hourly.lanes.direct.latestNextRunAt, value.sync.hourly.lanes.direct.latestNextAttemptAt, value.sync.hourly.providerNextAttemptAt], deadlines);
  assert.equal(requests, 1); assert.equal(control().daily_attempts, 1); assert.equal(value.revision, revision);
}));
test('provider rate cooldown stops a cycle and a repeated invocation spends no further allowance', async () => withCycleClock(async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  let calls = 0; globalThis.fetch = async () => { calls++; return { ok: false, status: 429 }; };
  value = await store.runHourlyCycle('service');
  assert.equal(calls, 1); assert.equal(control().daily_attempts, 1); assert.equal(value.sync.hourly.cycle.status, 'partial');
  assert.equal(value.sync.hourly.cycle.stopCode, 'PROVIDER_COOLDOWN'); const revision = value.revision;
  value = await store.runHourlyCycle('mcp'); assert.equal(calls, 1); assert.equal(value.revision, revision);
  assert.equal(control().daily_attempts, 1); assert.equal(control().lease_token, null);
}));
test('status reads of due multi-lane collection never trigger or write a cycle', async () => withCycleClock(async () => {
  fakeKey(); let value = await store.getWorkbench(); value = await store.setCollector(true, value.revision);
  const revision = value.revision; let calls = 0; globalThis.fetch = async () => { calls++; return emptyProvider(); };
  const response = await internal.GET(); assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, revision); assert.equal((await store.getStatus()).revision, revision);
  assert.equal(calls, 0); assert.equal(control().daily_attempts, 0); assert.equal(control().revision, revision);
}));
