import Model from './model.js';
import { normalizeTweets } from './twitterapi.mjs';
import { validatedRelevance } from './relevance.mjs';

const TARGET = 'entropyIO';
const DAY = 86400000;
const INTERVAL = 300000;
const METRICS = ['impressions', 'likes', 'reposts', 'uiReposts', 'quotes', 'replies', 'bookmarks'];
const copy = value => JSON.parse(JSON.stringify(value));
const numericId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
export const DISCOVERY_QUERY_POLICY = 'entropy-context-v1';
export const DISCOVERY_LANES = Object.freeze(['direct', 'evidence', 'context']);
export function discoveryTerms(lane = 'direct', policy = DISCOVERY_QUERY_POLICY) {
  if (!DISCOVERY_LANES.includes(lane)) throw new Error('Invalid discovery lane.');
  if (policy !== DISCOVERY_QUERY_POLICY || lane === 'direct') return '@' + TARGET;
  return lane === 'evidence' ? '(url:entropy.io OR "entropy.io" OR url:x.com/entropyIO OR url:twitter.com/entropyIO)' : 'Entropy';
}
export function discoveryQuery(start, endExclusive, policy = DISCOVERY_QUERY_POLICY, lane = 'direct') {
  const filters = [DISCOVERY_QUERY_POLICY, 'original-tweets-v1'].includes(policy) ? ' -filter:replies -filter:nativeretweets' : '';
  return discoveryTerms(lane, policy) + filters + ' since_time:' + Math.floor(Date.parse(start) / 1000) + ' until_time:' + Math.floor(Date.parse(endExclusive) / 1000);
}

function mergedRelevance(previous, incoming, body) {
  const before = validatedRelevance(previous), after = validatedRelevance(incoming);
  // Missing quote/link fields in a metrics response cannot erase saved proof.
  if (before?.status === 'accepted' && after?.status !== 'accepted') return before;
  if (before?.status === 'review' && (!after || after.status === 'rejected')) return before;
  if ((!body || !body.trim()) && after?.status === 'rejected') return before;
  return after || before;
}

function mergeDefined(oldValue, newValue) {
  const result = { ...(oldValue || {}) };
  for (const [key, value] of Object.entries(newValue || {})) if (value !== null && value !== undefined) result[key] = value;
  return result;
}

function observation(post, field, fallback) {
  return timestamp(post.metricsObservedAt?.[field]) || timestamp(post.metricsAsOf) || timestamp(fallback);
}

function mergePost(previous, incoming, oldAsOf, newAsOf) {
  if (!previous) {
    const metricsObservedAt = {};
    for (const key of METRICS) if (known(incoming.metrics[key])) metricsObservedAt[key] = observation(incoming, key, newAsOf);
    return { ...incoming, metricsObservedAt, lastCheckedAt: timestamp(newAsOf), availability: { status: 'available', lastSeenAt: timestamp(newAsOf) } };
  }
  if (previous.authorId !== incoming.authorId) throw new Error('Post ownership conflict.');
  if (previous.publishedAt && incoming.publishedAt && Date.parse(previous.publishedAt) !== Date.parse(incoming.publishedAt)) throw new Error('Post publication time conflict.');
  const metrics = {}, metricsObservedAt = {}, corrections = [...(previous.metricCorrections || [])];
  const missingInLatest = [];
  for (const key of METRICS) {
    const before = previous.metrics[key], after = incoming.metrics[key];
    const beforeAt = observation(previous, key, oldAsOf), afterAt = observation(incoming, key, newAsOf);
    const isNewer = !beforeAt || !afterAt || Date.parse(afterAt) >= Date.parse(beforeAt);
    if (known(after) && isNewer) {
      metrics[key] = after; metricsObservedAt[key] = afterAt;
      if (known(before) && after < before) corrections.push({ field: key, previous: before, current: after, observedAt: afterAt });
    } else {
      metrics[key] = before ?? null; metricsObservedAt[key] = known(before) ? beforeAt : null;
      if (!known(after)) missingInLatest.push(key);
    }
  }
  const times = Object.values(metricsObservedAt).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { ...mergeDefined(previous, incoming), authorId: incoming.authorId,
    relevance: mergedRelevance(previous.relevance, incoming.relevance, incoming.body),
    discoveryLanes: [...new Set([...(previous.discoveryLanes || []), ...(incoming.discoveryLanes || [])])].filter(lane => DISCOVERY_LANES.includes(lane)),
    // A partial provider observation cannot erase positive reply evidence.
    isReply: previous.isReply === true || incoming.isReply === true ? true : incoming.isReply ?? previous.isReply ?? null,
    inReplyToId: previous.inReplyToId || incoming.inReplyToId || null,
    isRepost: Model.postEligibility({ ...previous, isReply: false, inReplyToId: null }).reason === 'repost' ||
      Model.postEligibility({ ...incoming, isReply: false, inReplyToId: null }).reason === 'repost' ? true : incoming.isRepost ?? previous.isRepost ?? null,
    workId: previous.workId || incoming.workId || null,
    metrics, metricsObservedAt,
    // The oldest field timestamp prevents a partial refresh from relabelling old counts as fresh.
    metricsAsOf: times[0] || null, lastCheckedAt: timestamp(newAsOf), missingInLatest,
    metricCorrections: corrections.slice(-20), availability: { status: 'available', lastSeenAt: timestamp(newAsOf) } };
}

/** Incremental union. Ingestion owns source observations, never moderation or trust. */
export function mergeDataset(previousRaw, incomingRaw) {
  const previous = Model.validateDataset(previousRaw), incoming = Model.validateDataset(incomingRaw);
  const oldPosts = new Map(previous.posts.map(p => [p.id, p]));
  const aliases = new Map(), targets = new Map();
  for (const post of incoming.posts) {
    const old = oldPosts.get(post.id);
    if (!old || old.authorId === post.authorId) continue;
    if (!old.authorId.startsWith('sample:') || !numericId(post.authorId)) throw new Error('Post ownership conflict.');
    if (aliases.has(old.authorId) && aliases.get(old.authorId) !== post.authorId) throw new Error('Ambiguous sample identity.');
    if (targets.has(post.authorId) && targets.get(post.authorId) !== old.authorId) throw new Error('Merged sample identities.');
    if (previous.authors.some(a => a.id === post.authorId)) throw new Error('Target identity already exists.');
    aliases.set(old.authorId, post.authorId); targets.set(post.authorId, old.authorId);
  }
  const remap = id => aliases.get(id) || id;
  const authors = new Map(previous.authors.map(a => [remap(a.id), { ...a, id: remap(a.id) }]));
  for (const author of incoming.authors) {
    const old = authors.get(author.id);
    const merged = mergeDefined(old, author);
    if (old && incoming.meta.source === 'twitterapi.io') {
      merged.smartFollowersComplete = old.smartFollowersComplete;
      merged.smartEngagementComplete = old.smartEngagementComplete;
    }
    authors.set(author.id, merged);
  }
  const posts = new Map(previous.posts.map(p => [p.id, { ...p, authorId: remap(p.authorId) }]));
  for (const post of incoming.posts) posts.set(post.id, mergePost(posts.get(post.id), post, previous.meta.asOf, incoming.meta.asOf));
  const accounts = new Map(previous.accounts.map(a => [remap(a.id), { ...a, id: remap(a.id) }]));
  for (const account of incoming.accounts) {
    const id = remap(account.id), old = accounts.get(id);
    // Provider ingestion cannot lower an already reviewed identity to unreviewed.
    accounts.set(id, old?.trust !== null && old?.trust !== undefined ? { ...account, ...old } : mergeDefined(old, { ...account, id }));
  }
  const relations = new Map();
  for (const value of [...previous.followRelations, ...incoming.followRelations]) {
    const record = { ...value, authorId: remap(value.authorId), accountId: remap(value.accountId) };
    relations.set(record.authorId + '|' + record.accountId, mergeDefined(relations.get(record.authorId + '|' + record.accountId), record));
  }
  const interactions = new Map();
  for (const value of [...previous.interactions, ...incoming.interactions]) {
    const record = { ...value, authorId: remap(value.authorId), accountId: remap(value.accountId) };
    const key = record.id || [record.authorId, record.accountId, record.postId, record.type, record.occurredAt].join('|');
    interactions.set(key, mergeDefined(interactions.get(key), record));
  }
  const starts = [previous.meta.periodStart, incoming.meta.periodStart].filter(Boolean).sort();
  const ends = [previous.meta.periodEndExclusive, incoming.meta.periodEndExclusive].filter(Boolean).sort();
  return Model.validateDataset({ meta: { ...previous.meta, ...incoming.meta, coverage: 'partial',
      periodStart: starts[0], periodEndExclusive: ends.at(-1), metricsAreMixedAge: true,
      sourceNote: 'Incremental twitterapi.io observations. Counts are cumulative, of mixed age, and not verified organic reach.',
      limitations: [...new Set([...(previous.meta.limitations || []), ...(incoming.meta.limitations || [])])] },
    authors: [...authors.values()], posts: [...posts.values()], accounts: [...accounts.values()],
    followRelations: [...relations.values()], interactions: [...interactions.values()] });
}

function instant(input) {
  const value = typeof input === 'function' ? input() : input ?? new Date();
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Invalid sync time.');
  // Keep scheduler precision. Provider query bounds are rounded separately;
  // flooring here can make an immediate nextRunAt look falsely in the future.
  return time;
}
function windowsBetween(start, end) {
  const windows = [];
  // A long outage is recovered in bounded chunks, without dropping the rest of the backlog.
  const chunkEnd = Math.min(end, start + 32 * DAY);
  for (let current = start; current < chunkEnd;) {
    const nextMidnight = Date.parse(new Date(current).toISOString().slice(0, 10) + 'T00:00:00Z') + DAY;
    const until = Math.min(nextMidnight, chunkEnd);
    windows.push({ start: new Date(current).toISOString(), endExclusive: new Date(until).toISOString(), cursor: '', previousOldest: null, seenCursors: [] });
    current = until;
  }
  return windows;
}
function initialSync(raw, nowMs) {
  const sync = copy(raw || {});
  sync.version = 1; sync.source = 'twitterapi.io'; sync.target = TARGET;
  sync.enabled = sync.enabled === true; sync.paused = sync.paused === true;
  sync.intervalMs = Number.isInteger(sync.intervalMs) && sync.intervalMs >= INTERVAL ? sync.intervalMs : INTERVAL;
  sync.requestCount = Number.isInteger(sync.requestCount) && sync.requestCount >= 0 ? sync.requestCount : 0;
  sync.consecutiveFailures = Number.isInteger(sync.consecutiveFailures) && sync.consecutiveFailures >= 0 ? sync.consecutiveFailures : 0;
  sync.phase = sync.phase === 'refresh' ? 'refresh' : 'discovery';
  sync.gaps = Array.isArray(sync.gaps) ? sync.gaps.slice(-50) : [];
  sync.discovery ||= { pendingWindows: [], coveredThrough: null };
  sync.discovery.pendingWindows = Array.isArray(sync.discovery.pendingWindows) ? sync.discovery.pendingWindows : [];
  sync.discovery.recentWindow ||= null;
  sync.discovery.recentFrom = timestamp(sync.discovery.recentFrom);
  sync.discovery.recentThrough = timestamp(sync.discovery.recentThrough);
  // Resume an existing legacy cursor before switching to the new recent lane.
  sync.discovery.nextLane = ['recent', 'backfill'].includes(sync.discovery.nextLane)
    ? sync.discovery.nextLane : sync.discovery.pendingWindows[0]?.cursor ? 'backfill' : 'recent';
  sync.refresh ||= { pendingIds: [], cycleStartedAt: null };
  sync.refresh.pendingIds = Array.isArray(sync.refresh.pendingIds) ? sync.refresh.pendingIds.filter(numericId) : [];
  sync.lastAttemptAt ||= null; sync.lastSuccessAt ||= null; sync.lastDataAt ||= null; sync.lastError ||= null;
  sync.nextRunAt ||= new Date(nowMs).toISOString();
  return sync;
}
function addGap(sync, gap) { sync.gaps = [...sync.gaps, gap].slice(-50); }
function promoteRecentCoverage(discovery) {
  const covered = timestamp(discovery.coveredThrough);
  if (covered && discovery.recentFrom && discovery.recentThrough &&
    Date.parse(discovery.recentFrom) <= Date.parse(covered) && Date.parse(discovery.recentThrough) > Date.parse(covered)) {
    discovery.coveredThrough = discovery.recentThrough;
  }
}
function prepareDiscovery(sync, nowMs, nowIso) {
  const discovery = sync.discovery;
  const checkpoint = timestamp(discovery.coveredThrough);
  // A completed recent lane covers ordinary polling. Only create a historical
  // queue at startup or after a substantial outage; do not duplicate every poll.
  if (!discovery.pendingWindows.length && (!checkpoint || nowMs - Date.parse(checkpoint) > DAY)) {
    const monthStart = Date.parse(nowIso.slice(0, 7) + '-01T00:00:00Z');
    const from = checkpoint ? Math.min(nowMs, Date.parse(checkpoint) - INTERVAL) : monthStart;
    discovery.pendingWindows = windowsBetween(from, nowMs);
  }
  if (!discovery.recentWindow) {
    const recent = timestamp(discovery.recentThrough);
    const nearCheckpoint = checkpoint && nowMs - Date.parse(checkpoint) <= DAY ? checkpoint : null;
    const from = recent || nearCheckpoint;
    const monthStart = Date.parse(nowIso.slice(0, 7) + '-01T00:00:00Z');
    const since = from ? Math.min(nowMs, Date.parse(from) - INTERVAL) : Math.max(monthStart, nowMs - 6 * INTERVAL);
    if (since < nowMs) discovery.recentWindow = { start: new Date(since).toISOString(), endExclusive: nowIso,
      cursor: '', previousOldest: null, seenCursors: [] };
  }
  return discovery.nextLane === 'backfill' && discovery.pendingWindows.length ? 'backfill'
    : discovery.recentWindow ? 'recent' : discovery.pendingWindows.length ? 'backfill' : null;
}
function directlyMentioned(tweet) {
  return /(^|[^A-Za-z0-9_])@entropyIO(?![A-Za-z0-9_])/i.test(typeof tweet.text === 'string' ? tweet.text : '') ||
    Array.isArray(tweet.entities?.user_mentions) && tweet.entities.user_mentions.some(m => typeof m?.screen_name === 'string' && m.screen_name.toLowerCase() === TARGET.toLowerCase());
}
function formatEligible(post) { return !['reply', 'repost'].includes(Model.postEligibility(post).reason); }
export function matchesDiscoveryLane(post, lane = 'direct') {
  if (!DISCOVERY_LANES.includes(lane)) return false;
  if (Array.isArray(post.discoveryLanes) && post.discoveryLanes.includes(lane)) return true;
  if (lane === 'direct') return directlyMentioned({ text: post.body }) || validatedRelevance(post.relevance)?.signals.includes('direct_mention') === true;
  const relevance = validatedRelevance(post.relevance);
  if (lane === 'evidence') return relevance?.signals.some(value => ['official_domain', 'official_post_link'].includes(value)) === true;
  return /\bentropy\b/i.test(post.body || '');
}
function normalizedPage(tweets, nowIso, window = null) {
  const data = normalizeTweets(tweets, { observedAt: nowIso, query: window?.query || '@' + TARGET });
  if (window) {
    const from = Date.parse(window.start), until = Date.parse(window.endExclusive);
    data.posts = data.posts.filter(p => formatEligible(p) && ['accepted', 'review'].includes(p.relevance?.status) && p.authorHandle.toLowerCase() !== TARGET.toLowerCase() && Date.parse(p.publishedAt) >= from && Date.parse(p.publishedAt) < until)
      .map(post => ({ ...post, discoveryLanes: [window.discoveryLane || 'direct'] }));
    const authors = new Set(data.posts.map(p => p.authorId));
    data.authors = data.authors.filter(a => authors.has(a.id));
    data.meta.periodStart = window.start.slice(0, 10);
    data.meta.periodEndExclusive = new Date(Math.ceil(until / DAY) * DAY).toISOString().slice(0, 10);
  }
  return data;
}
/** Shared discovery/repair defense. Ambiguous matches remain private review records. */
export function normalizeDiscoveryPage(tweets, observedAt, window = null) {
  const data = normalizedPage(tweets, observedAt, window);
  data.posts = data.posts.filter(post => formatEligible(post) && ['accepted', 'review'].includes(post.relevance?.status) && post.authorHandle.toLowerCase() !== TARGET.toLowerCase());
  const authors = new Set(data.posts.map(post => post.authorId));
  data.authors = data.authors.filter(author => authors.has(author.id));
  return data;
}
// Emit only fixed diagnostic identifiers. Never persist provider text, IDs,
// response bodies, stack traces or credentials while classifying failures.
export function classifySyncError(error) {
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return { diagnosticCode: 'REQUEST_TIMEOUT' };
  const message = typeof error?.message === 'string' ? error.message : '';
  const exact = {
    'Post ownership conflict.': 'POST_OWNERSHIP_CONFLICT',
    'Post publication time conflict.': 'PUBLICATION_TIME_CONFLICT',
    'Ambiguous sample identity.': 'SAMPLE_IDENTITY_CONFLICT',
    'Merged sample identities.': 'SAMPLE_IDENTITY_CONFLICT',
    'Target identity already exists.': 'SAMPLE_IDENTITY_CONFLICT',
    'Суперечливі дублікати X Post ID.': 'DUPLICATE_POST',
    'Суперечливі імена одного автора у знімку.': 'AUTHOR_HANDLE_CONFLICT',
    'Некоректний текст поста.': 'INVALID_TWEET_TEXT',
    'Invalid checkpoint.': 'INVALID_CHECKPOINT',
    'Invalid discovery response.': 'INVALID_DISCOVERY_RESPONSE',
    'Invalid metrics response.': 'INVALID_METRICS_RESPONSE',
    'Unrequested post in refresh.': 'UNREQUESTED_POST',
  };
  if (Object.hasOwn(exact, message)) return { diagnosticCode: exact[message] };
  for (const field of ['viewCount', 'likeCount', 'retweetCount', 'quoteCount', 'replyCount', 'bookmarkCount', 'followers']) {
    if (message === 'Некоректний лічильник ' + field + '.') return { diagnosticCode: 'INVALID_COUNT', diagnosticField: field };
  }
  if (/^У tweets за індексом \d+ потрібен точний текстовий ID\.$/u.test(message)) return { diagnosticCode: 'INVALID_TWEET_ID' };
  if (/^Некоректний автор у tweets за індексом \d+\.$/u.test(message)) return { diagnosticCode: 'INVALID_AUTHOR' };
  if (/^Для часу (публікації|спостереження) потрібен часовий пояс\.$/u.test(message)) return { diagnosticCode: 'MISSING_TIMEZONE' };
  if (/^(Відсутній час|Некоректний час|Некоректна дата) (публікації|спостереження)\.$/u.test(message)) return { diagnosticCode: 'INVALID_TIMESTAMP' };
  if (message.startsWith('Імпорт зупинено: конфлікт ідентичності автора.') ||
      /^Імпорт зупинено: для @/.test(message)) return { diagnosticCode: 'MODEL_IDENTITY_CONFLICT' };
  for (const code of ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE', 'PROVIDER_ERROR', 'INVALID_INPUT', 'HTTP_ERROR', 'RATE_LIMITED', 'CREDITS_EXHAUSTED']) {
    if (error?.code === code) return { diagnosticCode: code };
  }
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) return { diagnosticCode: 'HTTP_ERROR' };
  return { diagnosticCode: 'UNCLASSIFIED_ERROR' };
}
function recordError(sync, error, nowMs) {
  const at = new Date(nowMs).toISOString();
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
  const code = [401, 403].includes(status) ? 'AUTH_REQUIRED' : status === 402 ? 'CREDITS_EXHAUSTED' : status === 429 ? 'RATE_LIMITED' : 'SYNC_FAILED';
  sync.consecutiveFailures++;
  sync.lastError = { code, message: code === 'AUTH_REQUIRED' ? 'The provider key needs attention.' : code === 'CREDITS_EXHAUSTED' ? 'Provider credits are exhausted.' : code === 'RATE_LIMITED' ? 'Provider rate limit reached; a later retry is scheduled.' : 'Sync did not complete. Existing data was retained.', at,
    httpStatus: status, ...classifySyncError(error) };
  sync.status = 'error';
  const delay = Math.max(sync.intervalMs, Math.min(3600000, 60000 * 2 ** Math.min(sync.consecutiveFailures - 1, 6)));
  sync.nextRunAt = new Date(nowMs + delay).toISOString();
  if ([401, 402, 403].includes(status)) { sync.paused = true; sync.status = 'paused'; }
  addGap(sync, { code, at });
}

/**
 * One persistent worker tick. The host must serialize ticks and durably reserve
 * its usage budget before calling this function. Opening a page never calls it.
 */
export async function advanceSync(workbench, { client, now, maxRequests = 1 } = {}) {
  let dataset = Model.validateDataset(copy(workbench.dataset));
  let state = Model.validateState(copy(workbench.state || Model.initialState()));
  const nowMs = instant(now), nowIso = new Date(nowMs).toISOString();
  const sync = initialSync(workbench.sync, nowMs);
  const result = () => ({ dataset, state, sync });
  if (!Number.isInteger(maxRequests) || maxRequests < 0) throw new Error('Invalid request limit.');
  if (!sync.enabled) { sync.status = 'disabled'; return result(); }
  if (sync.paused || maxRequests === 0) return result();
  if (Date.parse(sync.nextRunAt) > nowMs) return result();
  if (!client || typeof client.searchPage !== 'function' || typeof client.tweetsByIds !== 'function') throw new Error('A read-only provider client is required.');

  const discoveryLane = prepareDiscovery(sync, nowMs, nowIso);
  const eligible = dataset.posts.filter(p => numericId(p.id) && (Model.countablePost ? Model.countablePost(p, state).eligible : Model.postEligibility(p).eligible && p.relevance?.status !== 'review'));
  const eligibleIds = new Set(eligible.map(p => p.id));
  sync.refresh.pendingIds = sync.refresh.pendingIds.filter(id => eligibleIds.has(id));
  if (sync.requestCount === 0 && eligible.some(p => p.authorId.startsWith('sample:'))) sync.phase = 'refresh';
  if (sync.phase === 'refresh' && !sync.refresh.pendingIds.length) {
    sync.refresh.pendingIds = [...eligible].sort((a, b) => (Date.parse(a.lastCheckedAt || a.metricsAsOf) || 0) - (Date.parse(b.lastCheckedAt || b.metricsAsOf) || 0)).map(p => p.id);
    sync.refresh.cycleStartedAt = nowIso;
  }
  if (sync.phase === 'refresh' && !sync.refresh.pendingIds.length) sync.phase = 'discovery';
  if (sync.phase === 'discovery' && !discoveryLane) {
    sync.nextRunAt = new Date(nowMs + sync.intervalMs).toISOString(); sync.status = 'waiting'; return result();
  }
  sync.lastAttemptAt = nowIso; sync.requestCount++;
  const attemptedPhase = sync.phase;
  try {
    if (sync.phase === 'discovery') {
      const window = copy(discoveryLane === 'recent' ? sync.discovery.recentWindow : sync.discovery.pendingWindows[0]);
      const saveWindow = value => {
        if (discoveryLane === 'recent') sync.discovery.recentWindow = value;
        else sync.discovery.pendingWindows[0] = value;
      };
      if (!timestamp(window.start) || !timestamp(window.endExclusive) || Date.parse(window.start) >= Date.parse(window.endExclusive) || typeof window.cursor !== 'string') throw new Error('Invalid checkpoint.');
      const query = '@' + TARGET + ' since_time:' + Math.floor(Date.parse(window.start) / 1000) + ' until_time:' + Math.floor(Date.parse(window.endExclusive) / 1000);
      const page = await client.searchPage({ query, cursor: window.cursor });
      if (!page || !Array.isArray(page.tweets) || typeof page.hasNextPage !== 'boolean') throw new Error('Invalid discovery response.');
      const incoming = normalizedPage(page.tweets, nowIso, window);
      const merged = mergeDataset(dataset, incoming), migrated = Model.reconcileImport(dataset, merged, state);
      const times = page.tweets.map(t => Date.parse(t.createdAt)).filter(Number.isFinite);
      const repeated = page.hasNextPage && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === window.cursor || (window.seenCursors || []).includes(page.nextCursor));
      const jumped = window.previousOldest !== null && times.length && Math.max(...times) > window.previousOldest;
      const stalled = page.hasNextPage && !page.tweets.length;
      dataset = merged; state = migrated;
      if (incoming.posts.length) sync.lastDataAt = nowIso;
      if (repeated || jumped || stalled) {
        // Keep the bounded page observations, but do not advance past the gap.
        addGap(sync, { code: repeated ? 'CURSOR_CYCLE' : jumped ? 'PAGINATION_ORDER' : 'EMPTY_CONTINUATION', at: nowIso, windowStart: window.start, windowEndExclusive: window.endExclusive });
        window.cursor = ''; window.previousOldest = null; window.seenCursors = [];
        saveWindow(window);
      } else if (page.hasNextPage) {
        window.cursor = page.nextCursor;
        window.previousOldest = times.length ? Math.min(...times) : window.previousOldest;
        window.seenCursors = [...(window.seenCursors || []), page.nextCursor].slice(-1000);
        saveWindow(window);
      } else {
        if (discoveryLane === 'recent') {
          const recentThrough = timestamp(sync.discovery.recentThrough);
          if (!recentThrough || Date.parse(window.start) > Date.parse(recentThrough)) sync.discovery.recentFrom = window.start;
          sync.discovery.recentThrough = !recentThrough || Date.parse(window.endExclusive) > Date.parse(recentThrough) ? window.endExclusive : recentThrough;
          sync.discovery.recentWindow = null;
        } else {
          sync.discovery.pendingWindows.shift();
          const covered = timestamp(sync.discovery.coveredThrough);
          sync.discovery.coveredThrough = !covered || Date.parse(window.endExclusive) > Date.parse(covered) ? window.endExclusive : covered;
        }
        promoteRecentCoverage(sync.discovery);
      }
      // Give old pages and fresh mentions a turn even if either lane has a long
      // cursor chain. Metric refresh still receives the intervening tick.
      sync.discovery.nextLane = discoveryLane === 'recent' ? 'backfill' : 'recent';
      sync.phase = dataset.posts.length ? 'refresh' : 'discovery';
    } else {
      const batch = [...new Set(sync.refresh.pendingIds)].slice(0, 20);
      const page = await client.tweetsByIds(batch);
      if (!page || !Array.isArray(page.tweets)) throw new Error('Invalid metrics response.');
      const incoming = normalizedPage(page.tweets, nowIso);
      if (incoming.posts.some(p => !batch.includes(p.id))) throw new Error('Unrequested post in refresh.');
      const seen = new Set(incoming.posts.map(p => p.id)), missing = batch.filter(id => !seen.has(id));
      const merged = mergeDataset(dataset, incoming), migrated = Model.reconcileImport(dataset, merged, state);
      for (const post of merged.posts) if (missing.includes(post.id)) {
        post.lastCheckedAt = nowIso;
        post.availability = { status: 'unavailable', lastAttemptAt: nowIso, lastSeenAt: post.availability?.lastSeenAt || post.metricsAsOf || null };
      }
      if (missing.length) addGap(sync, { code: 'POSTS_UNAVAILABLE', at: nowIso, postIds: missing });
      dataset = merged; state = migrated;
      if (incoming.posts.length) sync.lastDataAt = nowIso;
      sync.refresh.pendingIds = sync.refresh.pendingIds.filter(id => !batch.includes(id));
      sync.phase = 'discovery';
    }
    sync.lastSuccessAt = nowIso; sync.consecutiveFailures = 0; sync.lastError = null;
    sync.nextRunAt = new Date(nowMs + sync.intervalMs).toISOString(); sync.status = 'running';
  } catch (error) {
    recordError(sync, error, nowMs);
    if (attemptedPhase === 'refresh' && !sync.paused) {
      // Keep the failed IDs queued, but give recent mentions the next due tick.
      // A slow metrics endpoint must not block discovery indefinitely.
      sync.phase = 'discovery'; sync.discovery.nextLane = 'recent';
    }
  }
  return result();
}

const HOUR = 3600000;
const CATCHUP_SPACING = 5100;
const HOURLY_MIN_WINDOW = 300000;
function hourlyWindow(start, endExclusive, kind = 'latest', method = 'search', discoveryLane = 'direct') {
  const from = new Date(start).toISOString(), until = new Date(endExclusive).toISOString();
  return { id: 'hourly:' + DISCOVERY_QUERY_POLICY + ':' + discoveryLane + ':' + method + ':' + from + ':' + until, method, discoveryLane,
    queryPolicy: DISCOVERY_QUERY_POLICY, query: discoveryQuery(from, until, DISCOVERY_QUERY_POLICY, discoveryLane),
    start: from, endExclusive: until, kind,
    cursor: '', previousOldest: null, seenCursors: [], observedPostIds: [] };
}
function emptyLane() { return { latestPlannedThrough: null, completedRanges: [], completedThrough: null, coverageFrom: null, lastAuditDay: null }; }
function laneState(hourly, lane = 'direct') { return hourly.lanes[lane]; }
function mirrorDirect(hourly) {
  const direct = laneState(hourly);
  for (const key of ['latestPlannedThrough', 'completedRanges', 'completedThrough', 'coverageFrom', 'lastAuditDay', 'lastAuditAt', 'lastAuditRange']) hourly[key] = direct[key] ?? null;
}
function hourlyCheckpoint(sync, at) {
  const hourly = copy(sync.hourly || {});
  const changed = hourly.queryPolicy !== DISCOVERY_QUERY_POLICY;
  hourly.version = 3; hourly.target = TARGET; hourly.method = 'search';
  hourly.pendingWindows = Array.isArray(hourly.pendingWindows) ? hourly.pendingWindows : [];
  hourly.completedRanges = Array.isArray(hourly.completedRanges) ? hourly.completedRanges : [];
  hourly.gaps = Array.isArray(hourly.gaps) ? hourly.gaps : [];
  if (changed) {
    const previous = hourly.pendingWindows;
    hourly.policyHistory = [...(hourly.policyHistory || []), { at, queryPolicy: hourly.queryPolicy || 'legacy-unfiltered',
      completedThrough: hourly.completedThrough || null, completedRangeCount: hourly.completedRanges.length,
      pendingWindows: previous.map(value => ({ start: value.start, endExclusive: value.endExclusive,
        discoveryLane: value.discoveryLane || 'direct', method: value.method || 'mentions', hadCursor: !!value.cursor })) }].slice(-3);
    // Old intervals remain direct searches; broader histories have their own audits.
    hourly.pendingWindows = previous.map(value => ({ ...hourlyWindow(Date.parse(value.start), Date.parse(value.endExclusive), value.kind || 'policy-recovery'), audit: value.audit === true || value.kind === 'audit' }));
    hourly.lanes = Object.fromEntries(DISCOVERY_LANES.map(lane => [lane, emptyLane()]));
    hourly.lanes.direct.latestPlannedThrough = timestamp(hourly.latestPlannedThrough);
    hourly.catchupLaneIndex = 0;
  } else {
    hourly.lanes ||= {};
    for (const lane of DISCOVERY_LANES) {
      if (!hourly.lanes[lane]) hourly.lanes[lane] = lane === 'direct' ? { ...emptyLane(), latestPlannedThrough: hourly.latestPlannedThrough,
        completedRanges: hourly.completedRanges, completedThrough: hourly.completedThrough, coverageFrom: hourly.coverageFrom,
        lastAuditDay: hourly.lastAuditDay, lastAuditAt: hourly.lastAuditAt, lastAuditRange: hourly.lastAuditRange } : emptyLane();
    }
    hourly.pendingWindows = hourly.pendingWindows.map(value => ({ ...value, discoveryLane: value.discoveryLane || 'direct' }));
  }
  for (const lane of DISCOVERY_LANES) {
    const value = laneState(hourly, lane);
    value.completedRanges = Array.isArray(value.completedRanges) ? value.completedRanges : [];
    for (const key of ['latestPlannedThrough', 'completedThrough', 'coverageFrom', 'lastAttemptAt', 'lastSuccessAt', 'lastDataAt']) value[key] = timestamp(value[key]);
    for (const window of hourly.pendingWindows.filter(window => window.discoveryLane === lane)) if (!value.coverageFrom || Date.parse(window.start) < Date.parse(value.coverageFrom)) value.coverageFrom = window.start;
  }
  hourly.queryPolicy = DISCOVERY_QUERY_POLICY;
  for (const key of ['requestCount', 'searchPages', 'latestPages', 'catchupPages', 'addedPosts', 'splitWindows']) hourly[key] = Number.isInteger(hourly[key]) && hourly[key] >= 0 ? hourly[key] : 0;
  hourly.catchupRequestCount = Number.isInteger(hourly.catchupRequestCount) && hourly.catchupRequestCount >= 0 ? hourly.catchupRequestCount : hourly.catchupPages;
  for (const key of ['lastAttemptAt', 'lastSuccessAt', 'lastDataAt', 'nextRunAt', 'nextAttemptAt', 'catchupLastAttemptAt', 'catchupLastSuccessAt']) hourly[key] = timestamp(hourly[key]);
  hourly.lastError ||= null; hourly.catchupLastError ||= null;
  hourly.catchupNextAttemptAt = hourly.nextAttemptAt;
  mirrorDirect(hourly); sync.hourly = hourly; return hourly;
}
function appendHourlyWindow(hourly, value) {
  if (!hourly.pendingWindows.some(window => window.id === value.id || window.queryPolicy === value.queryPolicy && window.discoveryLane === value.discoveryLane && window.method === value.method && window.start === value.start && window.endExclusive === value.endExclusive)) hourly.pendingWindows.push(value);
  const state = laneState(hourly, value.discoveryLane);
  if (!state.coverageFrom || Date.parse(value.start) < Date.parse(state.coverageFrom)) state.coverageFrom = value.start;
}
function migrateHourlyRecent(sync, hourly) {
  if (hourly.migratedLegacyRecent) return;
  const old = sync.discovery.recentWindow;
  if (old && timestamp(old.start) && timestamp(old.endExclusive) && Date.parse(old.start) < Date.parse(old.endExclusive)) appendHourlyWindow(hourly, hourlyWindow(Date.parse(old.start), Date.parse(old.endExclusive), 'legacy-recent'));
  hourly.migratedLegacyRecent = true;
}
function prepareHourlyAudit(hourly, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  for (const lane of DISCOVERY_LANES) {
    const state = laneState(hourly, lane);
    if (state.lastAuditDay === day || hourly.pendingWindows.some(value => value.discoveryLane === lane && (value.kind === 'audit' || value.audit === true))) continue;
    const until = Math.floor(nowMs / 1000) * 1000 - HOUR, from = until - 71 * HOUR;
    for (let point = from; point < until;) {
      const end = Math.min(until, Math.floor(point / DAY) * DAY + DAY);
      appendHourlyWindow(hourly, { ...hourlyWindow(point, end, 'audit', 'search', lane), audit: true }); point = end;
    }
    state.lastAuditDay = day; state.lastAuditAt = new Date(nowMs).toISOString();
    state.lastAuditRange = { start: new Date(from).toISOString(), endExclusive: new Date(until).toISOString() };
  }
}
function prepareHourlyLatest(sync, hourly, nowMs) {
  const until = Math.floor(nowMs / 1000) * 1000;
  let direct = null;
  for (const lane of DISCOVERY_LANES) {
    const state = laneState(hourly, lane);
    const previous = Date.parse(state.latestPlannedThrough) || (lane === 'direct' ? Date.parse(sync.discovery.recentThrough) || Date.parse(sync.discovery.recentWindow?.endExclusive) : NaN);
    if (Number.isFinite(previous) && previous >= until) continue;
    const from = Math.floor(Math.max(until - HOUR - INTERVAL, Number.isFinite(previous) ? previous - INTERVAL : until - HOUR - INTERVAL) / 1000) * 1000;
    if (Number.isFinite(previous) && previous < from) {
      for (let point = previous; point < from;) {
        const end = Math.min(from, Math.floor(point / DAY) * DAY + DAY);
        appendHourlyWindow(hourly, hourlyWindow(point, end, 'outage', 'search', lane)); point = end;
      }
    }
    const value = hourlyWindow(from, until, 'latest', 'search', lane); appendHourlyWindow(hourly, value);
    state.latestPlannedThrough = value.endExclusive; state.latestRange = { start: value.start, endExclusive: value.endExclusive };
    if (lane === 'direct') direct = hourly.pendingWindows.find(window => window.id === value.id);
  }
  return direct;
}
function chooseHourlyCatchup(hourly) {
  const oldest = values => [...values].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id))[0];
  // The old-work slot also rotates lanes. A dense contextual audit must not
  // monopolize tied oldest timestamps while direct/evidence audits wait.
  if ((hourly.catchupRequestCount + 1) % 6 === 0) {
    const start = Number.isInteger(hourly.oldLaneIndex) ? hourly.oldLaneIndex % DISCOVERY_LANES.length : 0;
    for (let offset = 0; offset < DISCOVERY_LANES.length; offset++) {
      const at = (start + offset) % DISCOVERY_LANES.length;
      const value = oldest(hourly.pendingWindows.filter(window => window.discoveryLane === DISCOVERY_LANES[at]));
      if (value) { hourly.oldLaneIndex = (at + 1) % DISCOVERY_LANES.length; return value; }
    }
    return null;
  }
  const start = Number.isInteger(hourly.catchupLaneIndex) ? hourly.catchupLaneIndex % DISCOVERY_LANES.length : 0;
  for (let offset = 0; offset < DISCOVERY_LANES.length; offset++) {
    const at = (start + offset) % DISCOVERY_LANES.length, lane = DISCOVERY_LANES[at];
    const values = hourly.pendingWindows.filter(window => window.discoveryLane === lane);
    if (!values.length) continue;
    hourly.catchupLaneIndex = (at + 1) % DISCOVERY_LANES.length;
    const latest = laneState(hourly, lane).latestRange;
    return latest ? [...values].filter(window => Date.parse(window.start) < Date.parse(latest.endExclusive) && Date.parse(window.endExclusive) > Date.parse(latest.start))
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start) || Date.parse(b.endExclusive) - Date.parse(a.endExclusive))[0] || oldest(values) : oldest(values);
  }
  return null;
}
function hourlyGap(sync, hourly, value) { hourly.gaps.push(value); addGap(sync, { ...value, source: 'hourly-discovery' }); }
function replaceHourlyWithSplit(sync, hourly, index, window, code, at, details = {}) {
  const from = Date.parse(window.start), until = Date.parse(window.endExclusive), lane = window.discoveryLane || 'direct';
  if (until - from >= 2 * HOURLY_MIN_WINDOW) {
    const middle = Math.floor((from + until) / 2000) * 1000;
    hourly.pendingWindows.splice(index, 1, { ...hourlyWindow(from, middle, 'recovery', window.method || 'search', lane), audit: !!window.audit }, { ...hourlyWindow(middle, until, 'recovery', window.method || 'search', lane), audit: !!window.audit });
    hourly.splitWindows++; return 'split';
  }
  hourlyGap(sync, hourly, { code, at, discoveryLane: lane, start: window.start, endExclusive: window.endExclusive, ...details });
  hourly.pendingWindows.splice(index, 1); return 'gap';
}
function hourlyKnownMissing(dataset, window, state) {
  const seen = new Set(window.observedPostIds || []), from = Date.parse(window.start), until = Date.parse(window.endExclusive);
  return dataset.posts.filter(post => (Model.countablePost ? Model.countablePost(post, state).eligible : Model.postEligibility(post).eligible && post.relevance?.status !== 'review') && !seen.has(post.id) && Date.parse(post.publishedAt) >= from && Date.parse(post.publishedAt) < until &&
    typeof post.authorHandle === 'string' && post.authorHandle.toLowerCase() !== TARGET.toLowerCase() && matchesDiscoveryLane(post, window.discoveryLane || 'direct')).length;
}
function compactRanges(ranges) {
  const result = [];
  for (const range of [...ranges].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const last = result.at(-1);
    if (last && Date.parse(range.start) <= Date.parse(last.endExclusive)) last.endExclusive = new Date(Math.max(Date.parse(last.endExclusive), Date.parse(range.endExclusive))).toISOString();
    else result.push({ start: range.start, endExclusive: range.endExclusive });
  }
  return result;
}
function promoteHourlyCoverage(hourly, lane = 'direct') {
  const state = laneState(hourly, lane);
  state.completedRanges = compactRanges(state.completedRanges);
  let point = Date.parse(state.completedThrough || state.coverageFrom);
  if (!Number.isFinite(point)) return;
  const initial = point;
  for (;;) {
    const next = state.completedRanges.reduce((end, range) => Date.parse(range.start) <= point && Date.parse(range.endExclusive) > end ? Date.parse(range.endExclusive) : end, point);
    if (next === point) break; point = next;
  }
  if (point > initial || state.completedThrough) state.completedThrough = new Date(point).toISOString();
}

/**
 * One hourly discovery request. The host reserves one paid attempt and lease.
 * `latest` always searches the current hour first. `catchup` drains one saved
 * page independently of the next hourly due time; it never refreshes metrics.
 */
export async function advanceHourlyDiscovery(workbench, { client, now, maxRequests = 1, lane = 'latest' } = {}) {
  let dataset = Model.validateDataset(copy(workbench.dataset));
  let state = Model.validateState(copy(workbench.state || Model.initialState()));
  const nowMs = instant(now), at = new Date(nowMs).toISOString();
  const sync = initialSync(workbench.sync, nowMs), result = () => { if (sync.hourly?.lanes) mirrorDirect(sync.hourly); return { dataset, state, sync }; };
  if (!['latest', 'catchup'].includes(lane) || !Number.isInteger(maxRequests) || maxRequests < 0) throw new Error('Invalid hourly discovery action.');
  if (!sync.enabled) { sync.status = 'disabled'; return result(); }
  if (sync.paused || maxRequests === 0) return result();
  const hourly = hourlyCheckpoint(sync, at);
  const due = lane === 'latest' ? hourly.nextRunAt || sync.nextRunAt : hourly.nextAttemptAt;
  if (due && Date.parse(due) > nowMs) return result();
  migrateHourlyRecent(sync, hourly);
  const chosen = lane === 'latest' ? prepareHourlyLatest(sync, hourly, nowMs)
    : chooseHourlyCatchup(hourly);
  if (lane === 'latest') prepareHourlyAudit(hourly, nowMs);
  if (!chosen) return result();
  const index = hourly.pendingWindows.indexOf(chosen), window = copy(chosen);
  if (index < 0 || !timestamp(window.start) || !timestamp(window.endExclusive) || Date.parse(window.start) >= Date.parse(window.endExclusive) || typeof window.cursor !== 'string' || !Array.isArray(window.seenCursors)) throw new Error('Invalid checkpoint.');
  const method = window.method || 'search';
  if (!['search', 'mentions'].includes(method) || !client || typeof client[method === 'mentions' ? 'mentionsPage' : 'searchPage'] !== 'function') throw new Error('A read-only collection client is required.');
  const latestDueBefore = hourly.nextRunAt || sync.nextRunAt;
  const queryLane = window.discoveryLane || 'direct', queryState = laneState(hourly, queryLane);
  sync.phase = 'discovery'; sync.activeLane = lane === 'latest' ? 'hourly-latest' : 'hourly-catchup';
  sync.lastAttemptAt = at; sync.requestCount++; hourly.requestCount++;
  queryState.lastAttemptAt = at;
  if (lane === 'latest') hourly.lastAttemptAt = at;
  else { hourly.catchupLastAttemptAt = at; hourly.catchupRequestCount++; }
  const snapshot = { start: window.start, endExclusive: window.endExclusive, method, lane, discoveryLane: queryLane, status: 'pending' };
  hourly.lastWindow = snapshot;
  if (lane === 'latest') hourly.latestWindow = { ...snapshot };
  try {
    const query = window.query || discoveryQuery(window.start, window.endExclusive, window.queryPolicy || 'legacy-unfiltered', queryLane);
    const page = method === 'mentions'
      ? await client.mentionsPage({ userName: TARGET, sinceTime: Math.floor(Date.parse(window.start) / 1000), untilTime: Math.floor(Date.parse(window.endExclusive) / 1000), cursor: window.cursor })
      : await client.searchPage({ query, cursor: window.cursor });
    if (!page || !Array.isArray(page.tweets) || typeof page.hasNextPage !== 'boolean') throw new Error('Invalid discovery response.');
    const incoming = normalizedPage(page.tweets, at, window);
    const oldIds = new Set(dataset.posts.map(post => post.id));
    const merged = mergeDataset(dataset, incoming), migrated = Model.reconcileImport(dataset, merged, state);
    const times = page.tweets.map(tweet => Date.parse(tweet.createdAt)).filter(Number.isFinite);
    const cycle = page.hasNextPage && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === window.cursor || window.seenCursors.includes(page.nextCursor));
    const jumped = window.previousOldest !== null && times.length && Math.max(...times) > window.previousOldest;
    const empty = page.hasNextPage && !page.tweets.length;
    dataset = merged; state = migrated;
    const added = incoming.posts.filter(post => !oldIds.has(post.id)).length;
    hourly.searchPages++; hourly[lane === 'latest' ? 'latestPages' : 'catchupPages']++;
    hourly.addedPosts += added; hourly.lastPageAdded = added;
    window.observedPostIds = [...new Set([...(window.observedPostIds || []), ...incoming.posts.map(post => post.id)])];
    delete window.consecutiveTimeouts;
    snapshot.returnedPosts = incoming.posts.length; snapshot.addedPosts = added;
    if (cycle || jumped || empty) snapshot.status = replaceHourlyWithSplit(sync, hourly, index, window, cycle ? 'CURSOR_CYCLE' : jumped ? 'PAGINATION_ORDER' : 'EMPTY_CONTINUATION', at);
    else if (page.hasNextPage) {
      window.cursor = page.nextCursor; window.previousOldest = times.length ? Math.min(...times) : window.previousOldest;
      window.seenCursors = [...window.seenCursors, page.nextCursor].slice(-1000);
      hourly.pendingWindows[index] = window;
    } else {
      const missing = hourlyKnownMissing(dataset, window, state);
      if (missing) {
        snapshot.status = replaceHourlyWithSplit(sync, hourly, index, window, 'KNOWN_POST_NOT_RETURNED', at, { count: missing });
      } else {
        hourly.pendingWindows.splice(index, 1); queryState.completedRanges.push({ start: window.start, endExclusive: window.endExclusive });
        snapshot.status = 'complete'; promoteHourlyCoverage(hourly, queryLane);
      }
    }
    sync.lastSuccessAt = at; sync.lastError = null; sync.consecutiveFailures = 0; sync.status = 'running';
    queryState.lastSuccessAt = at; queryState.lastError = null; queryState.lastWindow = { ...snapshot };
    if (incoming.posts.length) queryState.lastDataAt = at;
    if (incoming.posts.length) { sync.lastDataAt = at; if (lane === 'latest') hourly.lastDataAt = at; }
    if (lane === 'latest') { hourly.lastSuccessAt = at; hourly.lastError = null; hourly.latestWindow = { ...snapshot }; }
    else { hourly.catchupLastSuccessAt = at; hourly.catchupLastError = null; }
    hourly.nextAttemptAt = new Date(nowMs + CATCHUP_SPACING).toISOString();
    if (lane === 'latest') {
      hourly.nextRunAt = new Date((Math.floor(nowMs / HOUR) + 1) * HOUR).toISOString(); sync.nextRunAt = hourly.nextRunAt;
    } else sync.nextRunAt = latestDueBefore;
  } catch (error) {
    if (error?.code === 'INVALID_RESPONSE' && error?.message === 'Некоректний курсор наступної сторінки.') {
      snapshot.status = replaceHourlyWithSplit(sync, hourly, index, window, 'CURSOR_CYCLE', at);
      hourly.lastAnomaly = { code: 'CURSOR_CYCLE', at };
      hourly.nextAttemptAt = new Date(nowMs + CATCHUP_SPACING).toISOString();
      if (lane === 'latest') {
        hourly.latestWindow = { ...snapshot };
        hourly.nextRunAt = new Date((Math.floor(nowMs / HOUR) + 1) * HOUR).toISOString(); sync.nextRunAt = hourly.nextRunAt;
      } else sync.nextRunAt = latestDueBefore;
      hourly.catchupNextAttemptAt = hourly.nextAttemptAt;
      return result();
    }
    recordError(sync, error, nowMs); snapshot.status = 'error';
    queryState.lastError = copy(sync.lastError); queryState.lastWindow = { ...snapshot };
    hourly.nextAttemptAt = sync.nextRunAt;
    if (lane === 'latest') {
      hourly.lastError = copy(sync.lastError); hourly.latestWindow = { ...snapshot };
      hourly.nextRunAt = new Date(Math.max((Math.floor(nowMs / HOUR) + 1) * HOUR, Date.parse(sync.nextRunAt))).toISOString(); sync.nextRunAt = hourly.nextRunAt;
    } else {
      hourly.catchupLastError = copy(sync.lastError);
      if (!sync.paused) sync.nextRunAt = latestDueBefore;
    }
    if (sync.lastError?.diagnosticCode === 'REQUEST_TIMEOUT' && !sync.paused) {
      window.consecutiveTimeouts = (window.consecutiveTimeouts || 0) + 1;
      hourly.pendingWindows[index] = window;
      if (window.consecutiveTimeouts >= 2) {
        snapshot.status = replaceHourlyWithSplit(sync, hourly, index, window, 'REQUEST_TIMEOUT', at);
        hourly.lastAnomaly = { code: 'REQUEST_TIMEOUT', at };
        sync.consecutiveFailures = 0; sync.lastError = null; sync.status = 'running';
        hourly.nextAttemptAt = new Date(nowMs + CATCHUP_SPACING).toISOString();
        if (lane === 'latest') hourly.latestWindow = { ...snapshot };
        else hourly.catchupLastError = null;
      }
    } else if (window.consecutiveTimeouts) {
      delete window.consecutiveTimeouts; hourly.pendingWindows[index] = window;
    }
  }
  hourly.catchupNextAttemptAt = hourly.nextAttemptAt;
  return result();
}
