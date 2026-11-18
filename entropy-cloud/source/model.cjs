(function (root, factory) {
  const api = factory(root.EntropyScoring || (typeof require === 'function' ? require('./scoring.cjs') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EntropyModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Scoring) {
  'use strict';
  const METRICS = ['impressions', 'likes', 'reposts', 'uiReposts', 'quotes', 'replies', 'bookmarks'];
  const isNumber = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const safeId = v => typeof v === 'string' && v.trim() === v && v.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(v);
  const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
  function confirmedRelevance(r) {
    if (!plain(r) || r.version !== 'entropy-context-v1' || !Array.isArray(r.reasonCodes) || !Array.isArray(r.signals)) return false;
    return ['DIRECT_MENTION', 'OFFICIAL_DOMAIN', 'OFFICIAL_POST_LINK', 'OFFICIAL_QUOTE'].some(code => r.reasonCodes.includes(code) && r.signals.includes(code.toLowerCase()))
      || r.reasonCodes.includes('PROJECT_CONTEXT') && ['brand_name', 'product_context'].every(code => r.signals.includes(code)) && ['hyperliquid_context', 'hip3_context'].some(code => r.signals.includes(code));
  }
  function isoDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const n = new Date(v + 'T00:00:00Z');
    return Number.isFinite(n.getTime()) && n.toISOString().slice(0, 10) === v;
  }
  function validateDataset(raw) {
    if (!raw || !Array.isArray(raw.authors) || !Array.isArray(raw.posts)) throw new Error('Потрібні списки authors і posts.');
    if (raw.authors.length > 20000 || raw.posts.length > 100000) throw new Error('Набір завеликий для локального прототипу.');
    const ids = new Set();
    const authors = raw.authors.map(a => {
      if (!a || !safeId(a.id) || typeof a.handle !== 'string' || !a.handle.trim()) throw new Error('У автора потрібні коректні текстові id і handle.');
      if (ids.has(a.id)) throw new Error('Повторний ID автора: ' + a.id);
      ids.add(a.id);
      if (a.followers !== null && a.followers !== undefined && !isNumber(a.followers)) throw new Error('Некоректна кількість підписників.');
      return { ...a, followers: a.followers ?? null, smartFollowersComplete: a.smartFollowersComplete === true, smartEngagementComplete: a.smartEngagementComplete === true };
    });
    const postIds = new Set();
    const posts = raw.posts.map(p => {
      if (!p || !safeId(p.id) || postIds.has(p.id)) throw new Error('ID поста відсутній, некоректний або повторюється.');
      postIds.add(p.id);
      if (p.workId !== null && p.workId !== undefined && !safeId(p.workId)) throw new Error('Некоректний workId у пості.');
      if (!ids.has(p.authorId)) throw new Error('Для поста немає автора: ' + p.id);
      const day = p.date || (typeof p.publishedAt === 'string' ? p.publishedAt.slice(0, 10) : null);
      if (!isoDate(day)) throw new Error('Невідома або некоректна дата поста: ' + p.id);
      let url;
      try { url = new URL(p.url); } catch (_) { throw new Error('Некоректне посилання поста.'); }
      if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) throw new Error('Для поста потрібне HTTPS-посилання X.');
      const metrics = {};
      for (const k of METRICS) {
        const v = p.metrics?.[k];
        if (v !== null && v !== undefined && !isNumber(v)) throw new Error('Некоректна метрика ' + k + ' у пості ' + p.id);
        metrics[k] = v ?? null;
      }
      let relevance;
      if (p.relevance !== undefined && p.relevance !== null) {
        const r = p.relevance;
        const codes = values => Array.isArray(values) && values.length <= 32 && values.every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v));
        const acceptedProof = confirmedRelevance(r);
        if (!plain(r) || r.version !== 'entropy-context-v1' || !['accepted', 'review', 'rejected'].includes(r.status) || !codes(r.reasonCodes || []) || !codes(r.signals || []) || r.status === 'accepted' && !acceptedProof) throw new Error('Некоректний висновок про належність поста до Entropy.');
        relevance = { ...r, reasonCodes: [...(r.reasonCodes || [])], signals: [...(r.signals || [])] };
      }
      return { ...p, ...(relevance ? { relevance } : {}), date: day, metrics, summary: typeof p.summary === 'string' ? p.summary : '', body: typeof p.body === 'string' ? p.body : null };
    });
    const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
    const accountIds = new Set();
    accounts.forEach(a => {
      if (!a || !safeId(a.id) || accountIds.has(a.id)) throw new Error('Некоректний або повторний ID акаунта аудиторії.');
      accountIds.add(a.id);
    });
    const meta = plain(raw.meta) ? raw.meta : { coverage: 'unknown', asOf: null };
    for (const k of ['periodStart', 'periodEndExclusive']) if (meta[k] !== undefined && !isoDate(meta[k])) throw new Error('Некоректна межа періоду джерела.');
    return { meta, authors, posts, accounts,
      followRelations: Array.isArray(raw.followRelations) ? raw.followRelations : [], interactions: Array.isArray(raw.interactions) ? raw.interactions : [] };
  }
  function periodFor(key, dataset) {
    if (/^\d{4}-\d{2}$/.test(key)) {
      const [y, m] = key.split('-').map(Number);
      if (m < 1 || m > 12) throw new Error('Некоректний місяць.');
      return { key, start: key + '-01', endExclusive: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), monthly: true };
    }
    return { key: 'sample', start: dataset.meta.periodStart || '2026-10-17', endExclusive: dataset.meta.periodEndExclusive || '2026-11-17', monthly: false };
  }
  function sumKnown(posts, key) {
    if (!posts.length) return 0;
    if (posts.some(p => !isNumber(p.metrics[key]))) return null;
    return posts.reduce((n, p) => n + p.metrics[key], 0);
  }
  function reviewAccounts(dataset, reviews) {
    const byId = new Map(dataset.accounts.map(a => [a.id, a]));
    Object.values(reviews || {}).forEach(a => byId.set(a.id, { ...(byId.get(a.id) || {}), ...a }));
    return [...byId.values()];
  }
  function postEligibility(post) {
    const reference = value => typeof value === 'string' ? value.trim().length > 0 : typeof value === 'number' && Number.isFinite(value);
    if (post.isReply === true || reference(post.inReplyToId)) return { eligible: false, reason: 'reply' };
    if (post.isRetweet === true || post.isRepost === true || plain(post.retweeted_tweet) || reference(post.retweeted_tweet)
      || reference(post.retweetedTweetId) || reference(post.repostedTweetId)) return { eligible: false, reason: 'repost' };
    // Old imports may have no post-kind facts. A conversation ID alone does not
    // establish a reply, and absent facts must not become a verified original.
    return { eligible: true, reason: null };
  }
  function relevanceEligibility(post, state = {}) {
    const decision = state.postRelevance?.[post.id];
    // These editorial decisions are independent of new provider observations.
    if (decision?.action === 'reject') return { eligible: false, reason: 'relevance-rejected', manual: true };
    if (decision?.action === 'approve') return { eligible: true, reason: 'relevance-approved', manual: true };
    if (!post.relevance) return { eligible: true, reason: 'legacy', manual: false };
    if (post.relevance.status === 'accepted') return confirmedRelevance(post.relevance) ? { eligible: true, reason: 'relevance-confirmed', manual: false } : { eligible: false, reason: 'relevance-review', manual: false };
    return { eligible: false, reason: post.relevance.status === 'review' ? 'relevance-review' : 'relevance-rejected', manual: false };
  }
  function countablePost(post, state = {}) {
    const kind = postEligibility(post);
    return kind.eligible ? relevanceEligibility(post, state) : kind;
  }
  function relevanceQueue(dataset, state, query = '') {
    const search = String(query).trim().toLowerCase();
    const authors = new Map(dataset.authors.map(author => [author.id, author]));
    return dataset.posts.filter(post => postEligibility(post).eligible && relevanceEligibility(post, state).reason === 'relevance-review')
      .filter(post => !search || [post.body, post.summary, authors.get(post.authorId)?.handle, authors.get(post.authorId)?.displayName].join(' ').toLowerCase().includes(search))
      .sort((a, b) => String(b.publishedAt || b.date).localeCompare(String(a.publishedAt || a.date)) || b.id.localeCompare(a.id));
  }
  function aggregateAuthor(dataset, state, author, period) {
    const allPosts = dataset.posts.filter(p => p.authorId === author.id && p.date >= period.start && p.date < period.endExclusive);
    const eligiblePosts = allPosts.filter(p => countablePost(p, state).eligible);
    const ignoredPosts = allPosts.filter(p => !countablePost(p, state).eligible);
    const pendingPosts = allPosts.filter(p => postEligibility(p).eligible && relevanceEligibility(p, state).reason === 'relevance-review');
    const posts = eligiblePosts.filter(p => !state.postExclusions[p.id]);
    const works = [...new Set(posts.map(p => p.workId || p.id))];
    const periodDecision = state.periodDecisions[period.key + '|' + author.id];
    const ban = state.bans[author.id];
    const manual = ban ? { ...ban, type: 'ban' } : periodDecision ? { ...periodDecision, type: 'exclude-period' } : null;
    const metrics = Object.fromEntries(METRICS.map(k => [k, sumKnown(posts, k)]));
    const accounts = reviewAccounts(dataset, state.accountReviews);
    const smart = Scoring.computeSmartMetrics(author.id, accounts, dataset.followRelations, dataset.interactions, posts.map(p => p.id), {
      start: period.start + 'T00:00:00Z', endExclusive: period.endExclusive + 'T00:00:00Z',
    });
    const smartFollowersComplete = author.smartFollowersComplete === true && smart.followers.unknownAccountIds.length === 0 && author.followers !== null && smart.followers.confirmedCount === author.followers;
    const smartEngagementComplete = author.smartEngagementComplete === true && smart.engagement.unknownAccountIds.length === 0 && (smart.engagement.missing || smart.missing).length === 0;
    const score = Scoring.scoreAuthor({ impressions: metrics.impressions, likes: metrics.likes, reposts: metrics.reposts, quotes: metrics.quotes,
      followers: author.followers, smartFollowers: smart.smartFollowers, smartEngagement: smart.smartEngagement,
      posts: works.length, smartFollowersComplete, smartEngagementComplete });
    const status = ban ? 'banned' : periodDecision || (eligiblePosts.length > 0 && posts.length === 0) ? 'excluded' : eligiblePosts.length === 0 ? pendingPosts.length ? 'review' : 'no-posts' : score.requiresReview ? 'review' : 'active';
    return { author, allPosts, eligiblePosts, ignoredPosts, pendingPosts, posts, works, metrics, smart, smartFollowersComplete, smartEngagementComplete, score, manual, status, participates: !manual && posts.length > 0 };
  }
  function decision(state, payload, now) {
    const next = JSON.parse(JSON.stringify(state));
    const { type, authorId, postId, periodKey, reason, internalNote = '' } = payload;
    const restoring = type.startsWith('restore-');
    if (!restoring && (typeof reason !== 'string' || reason.trim().length < 3)) throw new Error('Потрібна причина для автора.');
    const record = { reason: restoring ? 'Рішення скасовано модератором.' : reason.trim(), internalNote: String(internalNote).trim(), at: now };
    if (type === 'ban') next.bans[authorId] = record;
    else if (type === 'exclude-period') next.periodDecisions[periodKey + '|' + authorId] = record;
    else if (type === 'exclude-post') next.postExclusions[postId] = { ...record, authorId };
    else if (type === 'restore-ban') delete next.bans[authorId];
    else if (type === 'restore-period') delete next.periodDecisions[periodKey + '|' + authorId];
    else if (type === 'restore-post') delete next.postExclusions[postId];
    else if (type === 'approve-relevance' || type === 'reject-relevance') {
      if (!safeId(postId) || !safeId(authorId)) throw new Error('Потрібні ID поста й автора.');
      next.postRelevance ||= {};
      next.postRelevance[postId] = { ...record, authorId, action: type === 'approve-relevance' ? 'approve' : 'reject' };
    }
    else if (type === 'restore-relevance') delete (next.postRelevance ||= {})[postId];
    else throw new Error('Невідомий тип рішення.');
    next.audit.unshift({ id: 'event:' + now + ':' + next.audit.length, type, authorId, postId: postId || null, periodKey, ...record });
    next.audit = next.audit.slice(0, 1000);
    return next;
  }
  function creatorView(dataset, state, authorId, period) {
    const author = dataset.authors.find(a => a.id === authorId);
    if (!author) throw new Error('Автора не знайдено.');
    const a = aggregateAuthor(dataset, state, author, period);
    const publicDecision = d => d ? { reason: d.reason, at: d.at } : null;
    return { author: { id: author.id, handle: author.handle }, period: { start: period.start, endExclusive: period.endExclusive },
      status: a.status, decision: publicDecision(a.manual), includedPosts: a.manual ? 0 : a.posts.length,
      excludedPosts: a.eligiblePosts.filter(p => state.postExclusions[p.id]).map(p => ({ id: p.id, url: p.url, date: p.date, ...publicDecision(state.postExclusions[p.id]) })) };
  }
  function initialState() { return { version: 1, bans: {}, periodDecisions: {}, postExclusions: {}, postRelevance: {}, accountReviews: {}, identityEvidence: {}, audit: [], snapshots: [], ui: { view: 'leaderboard', period: '2026-11', sort: 'impressions', status: 'active', search: '' } }; }
  function validateState(raw) {
    if (!plain(raw) || raw.version !== 1) throw new Error('Непідтримувана версія збереженого стану.');
    const result = initialState();
    for (const k of ['bans', 'periodDecisions', 'postExclusions']) {
      if (!plain(raw[k])) throw new Error('Некоректний список рішень: ' + k);
      for (const [id, record] of Object.entries(raw[k])) {
        if (!safeId(id) || !plain(record) || typeof record.reason !== 'string' || record.reason.trim().length < 3 || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)) || (record.internalNote !== undefined && typeof record.internalNote !== 'string')) throw new Error('Некоректний запис рішення.');
        result[k][id] = { ...record, internalNote: record.internalNote || '' };
      }
    }
    if (raw.postRelevance !== undefined) {
      if (!plain(raw.postRelevance) || Object.keys(raw.postRelevance).length > 100000) throw new Error('Некоректний список перевірок згадок.');
      for (const [id, record] of Object.entries(raw.postRelevance)) {
        if (!safeId(id) || !plain(record) || !safeId(record.authorId) || !['approve', 'reject'].includes(record.action) || typeof record.reason !== 'string' || record.reason.trim().length < 3 || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)) || record.internalNote !== undefined && typeof record.internalNote !== 'string') throw new Error('Некоректне рішення перевірки згадки.');
        result.postRelevance[id] = { ...record, internalNote: record.internalNote || '' };
      }
    }
    if (!plain(raw.accountReviews)) throw new Error('Некоректний список оцінок акаунтів.');
    for (const [id, record] of Object.entries(raw.accountReviews)) {
      if (!safeId(id) || !plain(record) || record.id !== id || Scoring.assessAccount(record).status === 'invalid') throw new Error('Некоректна оцінка акаунта.');
      result.accountReviews[id] = record;
    }
    // Older version-1 backups have no evidence ledger. Keep those readable,
    // while validating every identity record in newer backups before use.
    if (raw.identityEvidence !== undefined) {
      if (!plain(raw.identityEvidence) || Object.keys(raw.identityEvidence).length > 20000) throw new Error('Некоректний реєстр ідентичностей.');
      const postOwners = new Map();
      let postCount = 0;
      for (const [id, record] of Object.entries(raw.identityEvidence)) {
        if (!safeId(id) || !plain(record) || record.id !== id || typeof record.handle !== 'string' || !record.handle.trim() || !Array.isArray(record.postIds) || record.postIds.some(postId => !safeId(postId)) || new Set(record.postIds).size !== record.postIds.length) throw new Error('Некоректний доказ ідентичності автора.');
        postCount += record.postIds.length;
        if (postCount > 100000) throw new Error('Реєстр ідентичностей завеликий для локального прототипу.');
        for (const postId of record.postIds) {
          if (postOwners.has(postId) && postOwners.get(postId) !== id) throw new Error('У реєстрі один пост має кількох авторів.');
          postOwners.set(postId, id);
        }
        result.identityEvidence[id] = { id, handle: record.handle, postIds: [...record.postIds] };
      }
    }
    const eventTypes = ['ban', 'exclude-period', 'exclude-post', 'restore-ban', 'restore-period', 'restore-post', 'approve-relevance', 'reject-relevance', 'restore-relevance', 'account-review'];
    if (!Array.isArray(raw.audit) || raw.audit.length > 1000 || raw.audit.some(e => !plain(e) || !eventTypes.includes(e.type) || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || typeof e.reason !== 'string' || (e.internalNote !== undefined && typeof e.internalNote !== 'string'))) throw new Error('Некоректний журнал рішень.');
    result.audit = raw.audit;
    const ui = raw.ui;
    if (!plain(ui) || !['leaderboard', 'review', 'audience', 'method', 'settings'].includes(ui.view) || !['impressions', 'score', 'likes', 'replies'].includes(ui.sort) || !['active', 'review', 'excluded', 'banned', 'all'].includes(ui.status) || typeof ui.search !== 'string' || !(ui.period === 'sample' || /^\d{4}-(0[1-9]|1[0-2])$/.test(ui.period))) throw new Error('Некоректні налаштування перегляду.');
    result.ui = { ...ui };
    return result;
  }
  function reconcileImport(previousDataset, nextDataset, state) {
    const previous = validateDataset(previousDataset);
    const next = validateDataset(nextDataset);
    // All changes occur on a detached state. A failed identity check must leave
    // the current dataset, decisions, private notes and audit intact.
    const migrated = JSON.parse(JSON.stringify(validateState(state)));
    const previousPosts = new Map(previous.posts.map(p => [p.id, p]));
    const previousAuthors = new Map(previous.authors.map(a => [a.id, a]));
    const nextAuthorIds = new Set(next.authors.map(a => a.id));
    const mappings = new Map();
    const targets = new Map();
    const identityError = detail => { throw new Error('Імпорт зупинено: конфлікт ідентичності автора. ' + detail); };
    // Moderated authors can disappear from a refresh and return much later.
    // Their minimal evidence must outlive any one dataset, or a later import
    // could bypass a saved sample-ID ban by presenting a numeric user ID.
    for (const evidence of Object.values(migrated.identityEvidence)) {
      if (!previousAuthors.has(evidence.id)) previousAuthors.set(evidence.id, evidence);
      for (const postId of evidence.postIds) {
        const existing = previousPosts.get(postId);
        if (existing && existing.authorId !== evidence.id) identityError('Поточний набір суперечить збереженому авторству поста: ' + postId);
        previousPosts.set(postId, existing || { id: postId, authorId: evidence.id });
      }
    }
    for (const post of next.posts) {
      const oldPost = previousPosts.get(post.id);
      if (!oldPost || oldPost.authorId === post.authorId) continue;
      // A shared immutable post ID can upgrade a temporary sample author to an
      // X User ID. A handle match alone is never proof: handles can be reassigned.
      if (!oldPost.authorId.startsWith('sample:') || !/^\d+$/.test(post.authorId)) identityError('Один пост пов’язаний із різними авторами: ' + post.id);
      if (mappings.has(oldPost.authorId) && mappings.get(oldPost.authorId) !== post.authorId) identityError('Тимчасового автора пов’язано з кількома X User ID.');
      if (targets.has(post.authorId) && targets.get(post.authorId) !== oldPost.authorId) identityError('Кілька тимчасових авторів претендують на один X User ID.');
      mappings.set(oldPost.authorId, post.authorId);
      targets.set(post.authorId, oldPost.authorId);
    }
    const authorReferenced = id => Object.hasOwn(migrated.bans, id)
      || Object.keys(migrated.periodDecisions).some(k => k.endsWith('|' + id))
      || Object.entries(migrated.postExclusions).some(([postId, d]) => d.authorId === id || previousPosts.get(postId)?.authorId === id)
      || Object.entries(migrated.postRelevance).some(([postId, d]) => d.authorId === id || previousPosts.get(postId)?.authorId === id)
      || migrated.audit.some(e => e.authorId === id || e.accountId === id)
      || Object.hasOwn(migrated.accountReviews, id);
    for (const [oldId, newId] of mappings) {
      if (nextAuthorIds.has(oldId)) identityError('У новому наборі залишився і тимчасовий, і справжній ID одного автора.');
      if (previousAuthors.has(newId) || authorReferenced(newId)) identityError('Цільовий X User ID уже має окрему історію або рішення.');
    }
    const normalizedHandle = handle => handle.replace(/^@/, '').toLowerCase();
    for (const author of previousAuthors.values()) {
      if (!author.id.startsWith('sample:') || mappings.has(author.id) || !authorReferenced(author.id)) continue;
      if (next.authors.some(a => a.id !== author.id && normalizedHandle(a.handle) === normalizedHandle(author.handle))) {
        throw new Error('Імпорт зупинено: для @' + normalizedHandle(author.handle) + ' є збережені рішення, але новий ID не підтверджено спільним ID поста. Збігу імені недостатньо; додай попередній пост із перевіреним автором.');
      }
    }
    const remap = id => mappings.get(id) || id;
    const remapKeys = (records, keyFor, recordFor = record => record) => {
      const result = {};
      for (const [key, record] of Object.entries(records)) {
        const mappedKey = keyFor(key);
        if (Object.hasOwn(result, mappedKey)) identityError('Під час перенесення зіткнулися збережені рішення.');
        result[mappedKey] = recordFor(record);
      }
      return result;
    };
    const evidence = {};
    // Retain only id, handle and post IDs, never post bodies, metrics, reasons
    // or private notes. Existing evidence also survives restored decisions.
    for (const record of Object.values(migrated.identityEvidence)) {
      const id = remap(record.id);
      evidence[id] = { id, handle: record.handle, postIds: [...record.postIds] };
    }
    for (const author of [...previousAuthors.values(), ...next.authors]) {
      if (!authorReferenced(author.id) && !Object.hasOwn(evidence, remap(author.id))) continue;
      const id = remap(author.id);
      if (!Object.hasOwn(evidence, id)) evidence[id] = { id, handle: author.handle, postIds: [] };
    }
    const retainedPostIds = new Map(Object.values(evidence).map(record => [record.id, new Set(record.postIds)]));
    for (const post of [...previousPosts.values(), ...next.posts]) {
      const record = evidence[remap(post.authorId)];
      if (record && !retainedPostIds.get(record.id).has(post.id)) {
        record.postIds.push(post.id);
        retainedPostIds.get(record.id).add(post.id);
      }
    }
    migrated.identityEvidence = evidence;
    migrated.bans = remapKeys(migrated.bans, remap);
    migrated.periodDecisions = remapKeys(migrated.periodDecisions, key => {
      for (const [oldId, newId] of mappings) if (key.endsWith('|' + oldId)) return key.slice(0, -oldId.length) + newId;
      return key;
    });
    migrated.postExclusions = remapKeys(migrated.postExclusions, id => id, record => ({ ...record, ...(record.authorId ? { authorId: remap(record.authorId) } : {}) }));
    migrated.postRelevance = remapKeys(migrated.postRelevance, id => id, record => ({ ...record, authorId: remap(record.authorId) }));
    // Audience reviews are identity-bound too. Only an identical sample ID with
    // the same post-backed mapping is moved; a matching handle is never used.
    migrated.accountReviews = remapKeys(migrated.accountReviews, remap, record => ({ ...record, id: remap(record.id) }));
    migrated.audit = migrated.audit.map(event => ({ ...event,
      ...(event.authorId ? { authorId: remap(event.authorId) } : {}),
      ...(event.accountId ? { accountId: remap(event.accountId) } : {}) }));
    return validateState(migrated);
  }
  return { validateDataset, validateState, reconcileImport, periodFor, sumKnown, reviewAccounts, postEligibility, relevanceEligibility, countablePost, relevanceQueue, aggregateAuthor, decision, creatorView, initialState, safeId };
});
