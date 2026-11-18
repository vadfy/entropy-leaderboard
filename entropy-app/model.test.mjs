import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
require('./scoring.js');
const M = require('./model.js');
const data = M.validateDataset(JSON.parse(readFileSync(new URL('./seed.json', import.meta.url), 'utf8')));
const period = M.periodFor('sample', data);
const author = data.authors.find(a => a.handle === 'louisdives');
test('historical data stays partial: exact zeros, missing API counts and numeric string IDs', () => {
  assert.equal(data.posts.length, 24);
  assert.equal(data.posts.reduce((s,p)=>s+p.metrics.impressions,0),80786);
  const g = data.posts.find(p=>p.authorHandle==='gyanxbt');
  assert.equal(g.metrics.likes,0); assert.equal(g.metrics.reposts,null); assert.equal(typeof g.id,'string');
  const a=M.aggregateAuthor(data,M.initialState(),author,period);
  assert.equal(a.score.status,'incomplete'); assert.equal(a.score.score,null); assert.equal(a.metrics.impressions,34560);
});
test('excluding a post recalculates totals, ban survives periods, restoration is reversible', () => {
  let s=M.initialState();
  const p=data.posts.find(p=>p.authorId===author.id);
  s=M.decision(s,{type:'exclude-post',authorId:author.id,postId:p.id,periodKey:'sample',reason:'Тестове виключення'},'2026-11-17T12:00:00Z');
  let a=M.aggregateAuthor(data,s,author,period); assert.equal(a.posts.length,4); assert.equal(a.metrics.impressions,18763);
  s=M.decision(s,{type:'ban',authorId:author.id,periodKey:'sample',reason:'Тестовий бан'},'2026-11-17T12:01:00Z');
  assert.equal(M.aggregateAuthor(data,s,author,M.periodFor('2026-11',data)).status,'banned');
  s=M.decision(s,{type:'restore-ban',authorId:author.id,periodKey:'sample'},'2026-11-17T12:02:00Z');
  assert.equal(M.aggregateAuthor(data,s,author,period).status,'active');
});
test('period exclusions do not become permanent bans', () => {
  const s=M.decision(M.initialState(),{type:'exclude-period',authorId:author.id,periodKey:'2026-11',reason:'Тест за період'},'2026-11-17T12:00:00Z');
  assert.equal(M.aggregateAuthor(data,s,author,M.periodFor('2026-11',data)).status,'excluded');
  assert.equal(M.aggregateAuthor(data,s,author,period).status,'active');
});
test('creator-facing record never exposes private notes or another author', () => {
  const s=M.decision(M.initialState(),{type:'ban',authorId:author.id,periodKey:'sample',reason:'Видима причина',internalNote:'INTERNAL_PRIVATE_NOTE'},'2026-11-17T12:00:00Z');
  const v=M.creatorView(data,s,author.id,period); const text=JSON.stringify(v);
  assert.equal(v.includedPosts,0);assert.ok(text.includes('Видима причина'));assert.ok(!text.includes('INTERNAL_PRIVATE_NOTE'));assert.ok(!text.includes('linie_oo'));
});
test('all excluded posts means no included work; source dataset remains intact', () => {
  let s=M.initialState();for(const p of data.posts.filter(p=>p.authorId===author.id)) s=M.decision(s,{type:'exclude-post',authorId:author.id,postId:p.id,periodKey:'sample',reason:'Тест виключення'},'2026-11-17T12:00:00Z');
  const a=M.aggregateAuthor(data,s,author,period);assert.equal(a.status,'excluded');assert.equal(a.posts.length,0);assert.equal(a.metrics.impressions,0);assert.equal(data.posts.length,24);
});
test('unsafe sources and duplicated IDs are rejected on import', () => {
  const bad=structuredClone(data);bad.posts[0].url='javascript:alert(1)';assert.throws(()=>M.validateDataset(bad));
  const duplicate=structuredClone(data);duplicate.posts.push(duplicate.posts[0]);assert.throws(()=>M.validateDataset(duplicate));
});
test('broken backup state is rejected before any caller commits it', () => {
  const badAudit=M.initialState();badAudit.audit=[null];assert.throws(()=>M.validateState(badAudit));
  const badReview=M.initialState();badReview.accountReviews={x:null};assert.throws(()=>M.validateState(badReview));
  const badUi=M.initialState();badUi.ui.period='2026-99';assert.throws(()=>M.validateState(badUi));
  assert.deepEqual(M.validateState(M.initialState()),M.initialState());
  const unsafe=structuredClone(data);unsafe.authors[0].id='__proto__';assert.throws(()=>M.validateDataset(unsafe));
});
test('thread parts share one work for eligibility and posting boost', () => {
  const d=structuredClone(data);d.posts=d.posts.filter(p=>p.authorId===author.id).slice(0,2);d.posts.forEach(p=>p.workId='thread:one');
  const a=M.aggregateAuthor(d,M.initialState(),author,period);
  assert.equal(a.posts.length,2);assert.equal(a.works.length,1);assert.equal(a.score.status,'ineligible');
});
function tweetPolicyFixture() {
  const d = structuredClone(data), base = d.posts.find(p => p.authorId === author.id);
  const make = (id, facts = {}) => ({ ...base, id, workId: id, date: '2026-11-10',
    url: 'https://x.com/louisdives/status/' + id, body: id + ' saved body',
    metrics: { impressions: 1000, likes: 10, reposts: 2, uiReposts: 2, quotes: 1, replies: 5, bookmarks: 0 }, ...facts });
  d.posts = [
    make('root', { conversationId: 'different-legacy-conversation' }),
    make('quote', { isQuote: true, isReply: false, inReplyToId: null }),
    make('reply', { isReply: true }),
    make('self-reply', { isReply: false, inReplyToId: 'root', workId: 'root' }),
    make('reply-quote', { isQuote: true, inReplyToId: 'root' }),
    make('repost', { isRetweet: true }),
  ];
  d.accounts = []; d.followRelations = [];
  d.interactions = [
    { authorId: author.id, postId: 'root', accountId: 'root-respondent', type: 'reply', meaningful: true, occurredAt: '2026-11-10T12:00:00Z' },
    { authorId: author.id, postId: 'reply', accountId: 'ignored-respondent', type: 'quote', meaningful: true, occurredAt: '2026-11-10T12:00:00Z' },
  ];
  return M.validateDataset(d);
}
test('only original and top-level quote tweets contribute metrics, work counts, ER and smart engagement', () => {
  const d = tweetPolicyFixture(), before = structuredClone(d), state = M.initialState();
  // Even missing or extreme counters on ignored records cannot poison ranking.
  d.posts.find(p => p.id === 'reply').metrics.impressions = null;
  d.posts.find(p => p.id === 'self-reply').metrics.likes = 999999;
  const a = M.aggregateAuthor(d, state, author, period);
  assert.deepEqual(a.posts.map(p => p.id), ['root', 'quote']);
  assert.equal(a.allPosts.length, 6); assert.equal(a.eligiblePosts.length, 2); assert.equal(a.ignoredPosts.length, 4);
  assert.equal(a.works.length, 2); assert.equal(a.metrics.impressions, 2000); assert.equal(a.metrics.likes, 20);
  assert.equal(a.metrics.replies, 10); assert.equal(a.score.components.ERpercent, 1.3);
  assert.deepEqual(a.smart.engagement.unknownAccountIds, ['root-respondent']);
  const clean = { ...d, posts: d.posts.filter(p => ['root', 'quote'].includes(p.id)) };
  assert.deepEqual(a.score, M.aggregateAuthor(clean, state, author, period).score);
  assert.deepEqual(state, M.initialState());
  assert.deepEqual(d.posts.map(p => p.id), before.posts.map(p => p.id));
});
test('positive reply or repost facts override false flags without inferring missing legacy facts', () => {
  for (const facts of [{ isReply: true }, { isReply: false, inReplyToId: '123' }, { inReplyToId: 123 }, { isQuote: true, inReplyToId: '123' }]) {
    assert.deepEqual(M.postEligibility(facts), { eligible: false, reason: 'reply' });
  }
  for (const facts of [{ isRetweet: true }, { isRepost: true }, { retweeted_tweet: {} }, { retweetedTweetId: '123' }, { repostedTweetId: '123' }]) {
    assert.deepEqual(M.postEligibility(facts), { eligible: false, reason: 'repost' });
  }
  for (const facts of [{}, { isReply: false, inReplyToId: '' }, { id: '123', conversationId: '456' }, { isQuote: true }]) {
    assert.deepEqual(M.postEligibility(facts), { eligible: true, reason: null });
  }
});
test('replies cannot satisfy the two-work requirement or be reinstated by manual restoration', () => {
  const d = tweetPolicyFixture(); d.posts = d.posts.filter(p => ['root', 'self-reply'].includes(p.id));
  let state = M.decision(M.initialState(), { type: 'exclude-post', authorId: author.id, postId: 'self-reply', reason: 'Older manual decision' }, '2026-11-17T12:00:00Z');
  state = M.decision(state, { type: 'restore-post', authorId: author.id, postId: 'self-reply' }, '2026-11-17T12:01:00Z');
  let a = M.aggregateAuthor(d, state, author, period);
  assert.equal(a.posts.length, 1); assert.equal(a.works.length, 1); assert.equal(a.score.status, 'ineligible');
  d.posts = d.posts.filter(p => p.id === 'self-reply');
  a = M.aggregateAuthor(d, state, author, period);
  assert.equal(a.status, 'no-posts'); assert.equal(a.participates, false); assert.equal(a.metrics.impressions, 0);
  assert.equal(a.allPosts.length, 1); assert.equal(state.audit.length, 2);
  state = M.decision(state, { type: 'ban', authorId: author.id, reason: 'Existing author ban' }, '2026-11-17T12:02:00Z');
  assert.equal(M.aggregateAuthor(d, state, author, period).status, 'banned');
});
test('dataset imports and backups retain reply history and decisions without reintroducing it to creator-facing records', () => {
  const d = tweetPolicyFixture();
  const state = M.decision(M.initialState(), { type: 'exclude-post', authorId: author.id, postId: 'reply', reason: 'Reply history reason', internalNote: 'PRIVATE_REPLY_NOTE' }, '2026-11-17T12:00:00Z');
  const restored = JSON.parse(JSON.stringify({ dataset: d, state }));
  const imported = M.validateDataset(restored.dataset), importedState = M.validateState(restored.state);
  const reconciled = M.reconcileImport(d, imported, importedState);
  const a = M.aggregateAuthor(imported, reconciled, author, period);
  assert.equal(a.posts.length, 2); assert.equal(a.allPosts.length, 6);
  assert.equal(reconciled.postExclusions.reply.reason, 'Reply history reason');
  assert.equal(reconciled.audit.length, 1);
  const publicView = M.creatorView(imported, reconciled, author.id, period);
  assert.equal(publicView.includedPosts, 2); assert.deepEqual(publicView.excludedPosts, []);
  assert.ok(!JSON.stringify(publicView).includes('Reply history reason')); assert.ok(!JSON.stringify(publicView).includes('PRIVATE_REPLY_NOTE'));
});
test('a completeness flag does not hide a missing follower population', () => {
  const d=structuredClone(data);const a=d.authors.find(a=>a.id===author.id);a.followers=10000;a.smartFollowersComplete=true;
  const row=M.aggregateAuthor(d,M.initialState(),a,period);assert.equal(row.smartFollowersComplete,false);
});

const canonicalId = '1234567890123456789';
function canonicalCopy(source = data) {
  const next = structuredClone(source);
  next.authors.find(a => a.id === author.id).id = canonicalId;
  next.posts.filter(p => p.authorId === author.id).forEach(p => { p.authorId = canonicalId; });
  return next;
}
function moderatedState() {
  let state = M.initialState();
  const common = { authorId: author.id, periodKey: '2026-11', reason: 'Видима причина рішення', internalNote: 'PRIVATE_MIGRATION_NOTE' };
  for (const type of ['ban', 'exclude-period', 'exclude-post']) {
    state = M.decision(state, { ...common, type, postId: data.posts.find(p => p.authorId === author.id).id }, '2026-11-17T12:00:00Z');
  }
  return state;
}
test('post-backed sample identity upgrade preserves all decisions, privacy and bans on new work', () => {
  const next = canonicalCopy();
  const first = next.posts.find(p => p.authorId === canonicalId);
  next.posts.push({ ...first, id: '2999999999999999999', url: 'https://x.com/louisdives/status/2999999999999999999' });
  const before = moderatedState();
  const untouched = structuredClone(before);
  const state = M.reconcileImport(data, next, before);
  assert.deepEqual(before, untouched);
  assert.equal(state.bans[author.id], undefined);
  assert.equal(state.bans[canonicalId].reason, 'Видима причина рішення');
  assert.equal(state.bans[canonicalId].internalNote, 'PRIVATE_MIGRATION_NOTE');
  assert.equal(state.periodDecisions['2026-11|' + canonicalId].internalNote, 'PRIVATE_MIGRATION_NOTE');
  assert.equal(state.postExclusions[first.id].authorId, canonicalId);
  assert.ok(state.audit.every(event => event.authorId === canonicalId));
  const row = M.aggregateAuthor(M.validateDataset(next), state, next.authors.find(a => a.id === canonicalId), M.periodFor('2026-11', next));
  assert.equal(row.status, 'banned');
  assert.ok(row.allPosts.some(p => p.id === '2999999999999999999'));
  const publicView = JSON.stringify(M.creatorView(M.validateDataset(next), state, canonicalId, M.periodFor('2026-11', next)));
  assert.ok(publicView.includes('Видима причина рішення'));
  assert.ok(!publicView.includes('PRIVATE_MIGRATION_NOTE'));
});
test('a handle match cannot silently lift a moderated sample author restriction', () => {
  const next = canonicalCopy();
  next.posts = next.posts.filter(p => p.authorId !== canonicalId);
  const first = data.posts.find(p => p.authorId === author.id);
  next.posts.push({ ...first, authorId: canonicalId, id: '2999999999999999999', url: 'https://x.com/louisdives/status/2999999999999999999' });
  next.authors.find(a => a.id === canonicalId).handle = '@LOUISDIVES';
  const before = moderatedState();
  const untouched = structuredClone(before);
  assert.throws(() => M.reconcileImport(data, next, before), /спільним ID поста/);
  assert.deepEqual(before, untouched);
});
test('ambiguous post identity and existing target history reject the entire import', () => {
  const state = moderatedState();
  const untouched = structuredClone(state);
  const split = canonicalCopy();
  split.authors.push({ ...author, id: '9876543210987654321', handle: 'other_account' });
  split.posts.find(p => p.authorId === canonicalId).authorId = '9876543210987654321';
  assert.throws(() => M.reconcileImport(data, split, state), /кількома X User ID/);
  const occupied = moderatedState();
  occupied.bans[canonicalId] = { ...occupied.bans[author.id], reason: 'Окрема попередня причина' };
  assert.throws(() => M.reconcileImport(data, canonicalCopy(), occupied), /окрему історію/);
  const merged = canonicalCopy();
  const other = data.authors.find(a => a.id !== author.id);
  merged.authors = merged.authors.filter(a => a.id !== other.id);
  merged.posts.filter(p => p.authorId === other.id).forEach(p => { p.authorId = canonicalId; });
  assert.throws(() => M.reconcileImport(data, merged, state), /Кілька тимчасових авторів/);
  const duplicateIdentity = canonicalCopy();
  duplicateIdentity.authors.push({ ...author });
  assert.throws(() => M.reconcileImport(data, duplicateIdentity, state), /тимчасовий, і справжній/);
  assert.deepEqual(state, untouched);
});
test('canonical post ownership is immutable, even when the handle is unchanged', () => {
  const previous = canonicalCopy();
  const next = structuredClone(previous);
  next.authors.find(a => a.id === canonicalId).id = '9876543210987654321';
  next.posts.filter(p => p.authorId === canonicalId).forEach(p => { p.authorId = '9876543210987654321'; });
  assert.throws(() => M.reconcileImport(previous, next, M.initialState()), /Один пост/);
});
test('absent authors keep historical restrictions and unchanged canonical identities keep theirs', () => {
  const before = moderatedState();
  const absent = structuredClone(data);
  absent.authors = absent.authors.filter(a => a.id !== author.id);
  absent.posts = absent.posts.filter(p => p.authorId !== author.id);
  const absentState = M.reconcileImport(data, absent, before);
  assert.deepEqual(absentState.bans, before.bans);
  assert.deepEqual(absentState.periodDecisions, before.periodDecisions);
  assert.deepEqual(absentState.postExclusions, before.postExclusions);
  assert.deepEqual(absentState.audit, before.audit);
  assert.equal(absentState.identityEvidence[author.id].handle, author.handle);
  const canonical = canonicalCopy();
  const state = M.reconcileImport(data, canonical, before);
  canonical.authors.find(a => a.id === canonicalId).handle = 'new_handle';
  assert.deepEqual(M.reconcileImport(canonical, canonical, state), state);
});
test('audience reviews migrate only under the same post-backed identity mapping', () => {
  const state = M.initialState();
  state.accountReviews[author.id] = { id: author.id, handle: author.handle, trust: 1, reason: 'Перевірено вручну', evidence: [{ url: 'https://x.com/louisdives', note: 'Профіль автора' }], reviewedAt: '2026-11-17T12:00:00Z' };
  state.accountReviews['independent-account'] = { id: 'independent-account', handle: author.handle, trust: 0, reason: 'Окрема перевірка', evidence: [{ url: 'https://x.com/louisdives' }] };
  state.audit.push({ id: 'review:1', type: 'account-review', accountId: author.id, reason: 'Перевірено вручну', at: '2026-11-17T12:00:00Z' });
  const migrated = M.reconcileImport(data, canonicalCopy(), state);
  assert.equal(migrated.accountReviews[author.id], undefined);
  assert.equal(migrated.accountReviews[canonicalId].id, canonicalId);
  assert.equal(migrated.accountReviews[canonicalId].trust, 1);
  assert.deepEqual(migrated.accountReviews['independent-account'], state.accountReviews['independent-account']);
  assert.equal(migrated.audit[0].accountId, canonicalId);
  const unchanged = M.reconcileImport(data, data, state);
  assert.deepEqual(unchanged.accountReviews, state.accountReviews);
  assert.deepEqual(unchanged.audit, state.audit);
});
test('identity evidence survives an absent dataset and later post-backed upgrade', () => {
  const empty = { meta: {}, authors: [], posts: [] };
  const original = moderatedState();
  const absent = M.reconcileImport(data, empty, original);
  assert.deepEqual(absent.identityEvidence[author.id].postIds, data.posts.filter(p => p.authorId === author.id).map(p => p.id));
  assert.deepEqual(Object.keys(absent.identityEvidence[author.id]).sort(), ['handle', 'id', 'postIds']);
  const reappeared = M.reconcileImport(empty, canonicalCopy(), absent);
  assert.equal(reappeared.bans[canonicalId].reason, original.bans[author.id].reason);
  assert.equal(reappeared.bans[author.id], undefined);
  assert.equal(reappeared.identityEvidence[author.id], undefined);
  assert.equal(reappeared.identityEvidence[canonicalId].id, canonicalId);
  assert.equal(M.aggregateAuthor(M.validateDataset(canonicalCopy()), reappeared, canonicalCopy().authors.find(a => a.id === canonicalId), period).status, 'banned');
  assert.deepEqual(original.identityEvidence, {});
});
test('a gap does not erase the need for post evidence when a moderated handle reappears', () => {
  const empty = { meta: {}, authors: [], posts: [] };
  const absent = M.reconcileImport(data, empty, moderatedState());
  const next = canonicalCopy();
  next.posts = next.posts.filter(p => p.authorId !== canonicalId);
  const first = data.posts.find(p => p.authorId === author.id);
  next.posts.push({ ...first, authorId: canonicalId, id: '2999999999999999999', url: 'https://x.com/louisdives/status/2999999999999999999' });
  const untouched = structuredClone(absent);
  assert.throws(() => M.reconcileImport(empty, next, absent), /спільним ID поста/);
  assert.deepEqual(absent, untouched);
});
test('canonical bans survive disappearance and stable reappearance; retained ownership rejects changes', () => {
  const empty = { meta: {}, authors: [], posts: [] };
  const canonical = canonicalCopy();
  const state = M.reconcileImport(data, canonical, moderatedState());
  const absent = M.reconcileImport(canonical, empty, state);
  const returned = M.reconcileImport(empty, canonical, absent);
  assert.deepEqual(returned.bans[canonicalId], state.bans[canonicalId]);
  assert.equal(M.aggregateAuthor(M.validateDataset(canonical), returned, canonical.authors.find(a => a.id === canonicalId), period).status, 'banned');
  const changed = structuredClone(canonical);
  changed.authors.find(a => a.id === canonicalId).id = '9876543210987654321';
  changed.posts.filter(p => p.authorId === canonicalId).forEach(p => { p.authorId = '9876543210987654321'; });
  assert.throws(() => M.reconcileImport(empty, changed, absent), /Один пост/);
});
test('identity evidence validation is bounded, detached and backward compatible', () => {
  const legacy = M.initialState();
  delete legacy.identityEvidence;
  assert.deepEqual(M.validateState(legacy).identityEvidence, {});
  const state = M.reconcileImport(data, { meta: {}, authors: [], posts: [] }, moderatedState());
  const validated = M.validateState(state);
  validated.identityEvidence[author.id].postIds.push('another-post');
  assert.ok(!state.identityEvidence[author.id].postIds.includes('another-post'));
  const malformed = structuredClone(state);
  malformed.identityEvidence[author.id].postIds.push('__proto__');
  assert.throws(() => M.validateState(malformed), /доказ ідентичності/);
  const ownership = structuredClone(state);
  ownership.identityEvidence['other-author'] = { id: 'other-author', handle: 'other', postIds: [state.identityEvidence[author.id].postIds[0]] };
  assert.throws(() => M.validateState(ownership), /кількох авторів/);
  const oversized = M.initialState();
  oversized.identityEvidence.large = { id: 'large', handle: 'large', postIds: Array.from({ length: 100001 }, (_, n) => String(n)) };
  assert.throws(() => M.validateState(oversized), /завеликий/);
});

function contextFixture() {
  const base = data.posts.find(post => post.authorId === author.id);
  const relevance = status => ({ version: 'entropy-context-v1', status, reasonCodes: [status === 'accepted' ? 'OFFICIAL_DOMAIN' : status === 'review' ? 'AMBIGUOUS_ENTROPY' : 'OTHER_PROJECT'], signals: [status === 'accepted' ? 'official_domain' : 'brand_name'] });
  return M.validateDataset({ ...data, authors: [author], posts: [
    { ...base, id: 'context-confirmed', date: '2026-11-15', relevance: relevance('accepted'), metrics: { impressions: 1000, likes: 10, reposts: 2, quotes: 1, replies: 9 } },
    { ...base, id: 'context-pending', date: '2026-11-16', body: 'Entropy is early', relevance: relevance('review'), metrics: { impressions: 9000, likes: 300, reposts: 20, quotes: 10, replies: 50 } },
    { ...base, id: 'context-other', date: '2026-11-17', relevance: relevance('rejected'), metrics: { impressions: 99999, likes: 999, reposts: 99, quotes: 99, replies: 99 } },
    { ...base, id: 'context-reply', date: '2026-11-18', isReply: true, relevance: relevance('review'), metrics: { impressions: 100000, likes: 9000, reposts: 99, quotes: 99, replies: 99 } },
  ] });
}
test('pending and rejected Entropy contexts cannot enter any aggregate or satisfy eligibility', () => {
  const source = contextFixture(), state = M.initialState(), month = M.periodFor('2026-11', source);
  const aggregate = M.aggregateAuthor(source, state, author, month);
  assert.deepEqual(aggregate.posts.map(post => post.id), ['context-confirmed']);
  assert.equal(aggregate.metrics.impressions, 1000); assert.equal(aggregate.metrics.likes, 10); assert.equal(aggregate.metrics.replies, 9);
  assert.equal(aggregate.score.components.ERpercent, 1.3); assert.equal(aggregate.works.length, 1);
  assert.equal(aggregate.score.status, 'ineligible');
  assert.deepEqual(M.relevanceQueue(source, state).map(post => post.id), ['context-pending']);
  assert.equal(M.relevanceQueue(source, state, 'early').length, 1); assert.equal(M.relevanceQueue(source, state, 'absent').length, 0);
  assert.equal(M.postEligibility(source.posts[1]).eligible, true, 'collector type policy remains independent');
});
test('manual context approval is auditable while reply type and other moderation still win', () => {
  const source = contextFixture(), month = M.periodFor('2026-11', source);
  let state = M.decision(M.initialState(), { type: 'approve-relevance', authorId: author.id, postId: 'context-pending', reason: 'Verified against project announcement', internalNote: 'PRIVATE_CONTEXT_NOTE' }, '2026-11-18T12:00:00Z');
  state = M.decision(state, { type: 'approve-relevance', authorId: author.id, postId: 'context-reply', reason: 'Cannot override reply policy' }, '2026-11-18T12:01:00Z');
  assert.deepEqual(M.aggregateAuthor(source, state, author, month).posts.map(post => post.id), ['context-confirmed', 'context-pending']);
  assert.equal(M.aggregateAuthor(source, state, author, month).metrics.impressions, 10000);
  assert.equal(M.countablePost(source.posts[3], state).eligible, false);
  assert.equal(M.relevanceQueue(source, state).length, 0); assert.equal(state.audit[1].type, 'approve-relevance');
  state = M.decision(state, { type: 'exclude-post', authorId: author.id, postId: 'context-pending', reason: 'Independent exclusion persists' }, '2026-11-18T12:02:00Z');
  assert.equal(M.aggregateAuthor(source, state, author, month).posts.length, 1);
  state = M.decision(state, { type: 'ban', authorId: author.id, reason: 'Separate creator decision' }, '2026-11-18T12:03:00Z');
  assert.equal(M.aggregateAuthor(source, state, author, month).participates, false);
  assert.ok(!JSON.stringify(M.creatorView(source, state, author.id, month)).includes('PRIVATE_CONTEXT_NOTE'));
});
test('manual context rejection survives later accepted classification until explicitly restored', () => {
  const source = contextFixture(); let state = M.decision(M.initialState(), { type: 'reject-relevance', authorId: author.id, postId: 'context-pending', reason: 'This is a different project' }, '2026-11-18T12:00:00Z');
  source.posts[1].relevance = structuredClone(source.posts[0].relevance);
  assert.equal(M.countablePost(source.posts[1], state).eligible, false);
  state = M.decision(state, { type: 'restore-relevance', authorId: author.id, postId: 'context-pending' }, '2026-11-18T12:01:00Z');
  assert.equal(M.countablePost(source.posts[1], state).eligible, true);
  assert.equal(state.audit.length, 2); assert.equal(state.postRelevance['context-pending'], undefined);
});
test('context decisions migrate by immutable post ownership and survive an absent dataset', () => {
  const source = contextFixture(), state = M.decision(M.initialState(), { type: 'reject-relevance', authorId: author.id, postId: 'context-pending', reason: 'Different Entropy', internalNote: 'PRIVATE_MIGRATION_NOTE' }, '2026-11-18T12:00:00Z');
  const next = structuredClone(source); next.authors[0].id = canonicalId; next.posts.forEach(post => { post.authorId = canonicalId; });
  const absent = M.reconcileImport(source, { meta: {}, authors: [], posts: [] }, state);
  const migrated = M.reconcileImport({ meta: {}, authors: [], posts: [] }, next, absent);
  assert.equal(migrated.postRelevance['context-pending'].authorId, canonicalId);
  assert.equal(migrated.postRelevance['context-pending'].internalNote, 'PRIVATE_MIGRATION_NOTE');
  assert.equal(migrated.audit[0].authorId, canonicalId);
});
test('legacy state is readable, but malformed context decisions and unsupported automatic proof fail closed', () => {
  const legacy = M.initialState(); delete legacy.postRelevance;
  assert.deepEqual(M.validateState(legacy).postRelevance, {});
  const malformed = M.initialState(); malformed.postRelevance.bad = { action: 'approve', authorId: author.id, reason: 'x', at: '2026-11-18T12:00:00Z' };
  assert.throws(() => M.validateState(malformed), /рішення перевірки/);
  for (const relevance of [
    { version: 'future-unknown', status: 'accepted', reasonCodes: [], signals: [] },
    { version: 'entropy-context-v1', status: 'accepted', reasonCodes: [], signals: [] },
    { version: 'entropy-context-v1', status: 'accepted', reasonCodes: ['OFFICIAL_DOMAIN'], signals: ['brand_name'] },
  ]) {
    const source = contextFixture(); source.posts[1].relevance = relevance;
    assert.throws(() => M.validateDataset(source), /належність поста/);
  }
  const source = contextFixture(); delete source.posts[0].relevance;
  assert.equal(M.countablePost(source.posts[0], M.initialState()).eligible, true, 'legacy observations are not silently reclassified');
});
test('creator-facing records omit unconfirmed context even when it has an older post exclusion', () => {
  const source = contextFixture(), state = M.decision(M.initialState(), { type: 'exclude-post', authorId: author.id, postId: 'context-pending', reason: 'PRIVATE_PENDING_REASON' }, '2026-11-18T12:00:00Z');
  const view = M.creatorView(source, state, author.id, M.periodFor('2026-11', source));
  assert.equal(view.includedPosts, 1); assert.deepEqual(view.excludedPosts, []);
  assert.ok(!JSON.stringify(view).includes('context-pending')); assert.ok(!JSON.stringify(view).includes('PRIVATE_PENDING_REASON'));
});
