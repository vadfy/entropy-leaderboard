const PAGE_SIZE = 20;
const METRICS = { impressions: 'переглядів', likes: 'лайків', replies: 'коментарів', engagementRate: 'Engagement', score: 'Score' };
const integerFormat = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const scoreFormat = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
const compactFormat = new Intl.NumberFormat('uk-UA', { notation: 'compact', maximumFractionDigits: 1 });
const percentFormat = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthFormat = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dateFormat = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function metricValue(row, metric) {
  if (metric === 'engagementRate') return engagementRate(row);
  if (metric === 'score' && row && Object.hasOwn(row, 'scoreStatus') && row.scoreStatus !== 'ready') return null;
  return numberValue(metric === 'score' ? row?.score : row?.metrics?.[metric]);
}

export function engagementRate(row) {
  if (row && Object.hasOwn(row, 'engagementRate')) return numberValue(row.engagementRate);
  const source = row?.metrics;
  const impressions = numberValue(source?.impressions);
  const counts = ['likes', 'reposts', 'quotes'].map(key => numberValue(source?.[key]));
  if (impressions === null || impressions <= 0 || counts.some(value => value === null)) return null;
  const rate = counts.reduce((sum, value) => sum + value, 0) / impressions * 100;
  return Number.isFinite(rate) ? rate : null;
}

export function formatPercent(value) {
  const number = numberValue(value);
  return number === null ? '—' : percentFormat.format(number) + '%';
}

export function renderScore(row) {
  const score = metricValue(row, 'score');
  if (score !== null) return `<span class="score-value">${formatNumber(score, false, true)}</span>`;
  const label = row?.scoreStatus === 'not-qualified' ? 'Недостатньо робіт / показів' : 'Недостатньо даних';
  return `<span class="score-value">—</span><span class="score-status">${label}</span>`;
}

export function renderContributorMetrics(row) {
  const entries = [['score', 'Score'], ['engagementRate', 'Engagement'], ['impressions', 'Перегляди'], ['likes', 'Лайки'], ['replies', 'Коментарі'], ['posts', 'Пости']];
  return entries.map(([key, label]) => `<span><strong>${key === 'score' ? renderScore(row) : key === 'engagementRate' ? formatPercent(engagementRate(row)) : formatNumber(key === 'posts' ? row.posts : row.metrics?.[key])}</strong>${label}</span>`).join('');
}

export function rankRows(rows, metric = 'impressions') {
  const selectedMetric = Object.hasOwn(METRICS, metric) ? metric : 'impressions';
  return [...rows].sort((a, b) => {
    const left = metricValue(a, selectedMetric);
    const right = metricValue(b, selectedMetric);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left !== right) return (right ?? 0) - (left ?? 0);
    const reachDifference = (metricValue(b, 'impressions') ?? -1) - (metricValue(a, 'impressions') ?? -1);
    if (reachDifference) return reachDifference;
    return String(a.author?.handle ?? a.author?.id ?? '').localeCompare(String(b.author?.handle ?? b.author?.id ?? ''), 'en') || String(a.author?.id ?? '').localeCompare(String(b.author?.id ?? ''), 'en');
  }).map((row, index) => ({ ...row, displayRank: ['score', 'engagementRate'].includes(selectedMetric) && metricValue(row, selectedMetric) === null ? null : index + 1 }));
}

export function filterRows(rows, query) {
  const needle = String(query ?? '').trim().replace(/^@/, '').toLocaleLowerCase('uk-UA');
  return needle ? rows.filter(({ author }) => [author?.handle, author?.displayName].some((value) => String(value ?? '').toLocaleLowerCase('uk-UA').includes(needle))) : rows;
}

export function safePostUrl(post) {
  if (!post?.url) return null;
  try {
    const url = new URL(post.url);
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    if (!/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/\d+\/?$/.test(url.pathname)) return null;
    return 'https://x.com' + url.pathname.replace(/\/$/, '');
  } catch { return null; }
}

function postTime(post) {
  const time = Date.parse(post?.publishedAt || post?.date || '');
  return Number.isFinite(time) ? time : null;
}

export function authorPosts(posts, authorId, period, scope = 'period') {
  const start = Date.parse(period?.start ?? '');
  const end = Date.parse(period?.endExclusive ?? '');
  return posts.filter((post) => {
    if (String(post.authorId) !== String(authorId)) return false;
    if (scope === 'all') return true;
    const time = postTime(post);
    if (Number.isFinite(start) && Number.isFinite(end) && time !== null) return time >= start && time < end;
    return /^\d{4}-\d{2}$/.test(period?.key ?? '') && String(post.date || post.publishedAt || '').slice(0, 7) === period.key;
  }).sort((a, b) => (postTime(b) ?? 0) - (postTime(a) ?? 0) || String(b.id).localeCompare(String(a.id), 'en', { numeric: true }));
}

export function paginatePosts(posts, page = 0) {
  const totalPages = Math.max(1, Math.ceil(posts.length / PAGE_SIZE));
  const normalized = Number.isFinite(page) ? Math.floor(page) : 0;
  const currentPage = Math.min(Math.max(0, normalized), totalPages - 1);
  return { posts: posts.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE), page: currentPage, totalPages, total: posts.length };
}

function formatNumber(value, compact = false, score = false) {
  const number = numberValue(value);
  return number === null ? '—' : (compact ? compactFormat : score ? scoreFormat : integerFormat).format(number);
}

function formatDate(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? dateFormat.format(new Date(timestamp)) + ' UTC' : 'час невідомий';
}

function periodLabel(period) {
  if (/^\d{4}-\d{2}$/.test(period?.key ?? '')) {
    const date = new Date(period.key + '-01T00:00:00Z');
    if (!Number.isNaN(date.getTime())) {
      const label = monthFormat.format(date).replace(/\s*р\.$/, '');
      return label.charAt(0).toUpperCase() + label.slice(1) + ' · UTC';
    }
  }
  return String(period?.key ?? 'Період');
}

function avatar(author, large = false) {
  const seed = String(author?.id ?? author?.handle ?? '');
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  const initials = Array.from(String(author?.displayName || author?.handle || '?').replace(/^@/, '').trim()).slice(0, 2).join('').toLocaleUpperCase('uk-UA');
  return `<span class="creator-avatar avatar-tone-${hash % 6}${large ? ' avatar-large' : ''}" aria-hidden="true">${escapeHTML(initials)}</span>`;
}

function handleLabel(author) { return '@' + String(author?.handle ?? '').replace(/^@/, ''); }
function authorName(author) { return String(author?.displayName || handleLabel(author)); }
function profileUrl(author) {
  const handle = String(author?.handle ?? '').replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? 'https://x.com/' + handle : null;
}

export function renderPost(post) {
  const url = safePostUrl(post);
  const body = typeof post.body === 'string' && post.body.trim() ? post.body : null;
  const summary = typeof post.summary === 'string' && post.summary.trim() ? post.summary : null;
  const text = body || summary || 'Текст поста ще недоступний.';
  const counts = [['impressions', 'переглядів'], ['likes', 'лайків'], ['replies', 'коментарів'], ['reposts', 'репостів'], ['quotes', 'цитат']];
  return `<article class="post-card"><div class="post-header"><time>${escapeHTML(formatDate(post.publishedAt || post.date))}</time>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Відкрити в X ↗</a>` : ''}</div>${!body && summary ? '<p class="summary-fallback">Короткий опис · повний текст доступний у X</p>' : ''}<p class="post-body${!body && !summary ? ' placeholder' : ''}">${escapeHTML(text)}</p><div class="post-metrics">${counts.map(([key, label]) => `<span>${formatNumber(post.metrics?.[key])} ${label}</span>`).join('')}</div>${post.metricsAsOf ? `<p class="post-metric-age">Показники: ${escapeHTML(formatDate(post.metricsAsOf))}</p>` : ''}</article>`;
}

function isEnvelope(value) {
  return value && value.schemaVersion === 1 && value.public && Array.isArray(value.public.periods) && Array.isArray(value.public.posts) && value.public.periods.every((period) => typeof period.key === 'string' && Array.isArray(period.rows) && period.rows.every((row) => row && row.author && typeof row.author.id === 'string'));
}

function boot() {
  const byId = (id) => document.getElementById(id);
  const state = { snapshot: null, pending: null, period: null, sort: 'impressions', query: '', selected: null, scope: 'period', page: 0, error: false, waiting: false, fetching: false, fetchedAt: 0 };
  const selectedPeriod = () => state.snapshot?.public.periods.find((period) => period.key === state.period) ?? null;
  const ranked = () => rankRows(selectedPeriod()?.rows ?? [], state.sort);

  function renderStatus() {
    const updated = state.snapshot?.updatedAt;
    byId('update-label').textContent = state.pending ? 'Є нові дані · з’являться після повернення до рейтингу' : updated ? 'Оновлено: ' + formatDate(updated) : state.error ? 'Оновлення тимчасово недоступне' : state.waiting || state.snapshot ? 'Рейтинг ще оновлюється' : 'Завантажуємо рейтинг';
    byId('freshness-note').innerHTML = state.error && state.snapshot ? '<p class="status-message" role="status">Не вдалося оновити дані. Показуємо останній доступний рейтинг.</p>' : state.snapshot && state.snapshot.public.periods.length ? `<span class="partial-note">Дані можуть бути неповними</span><span>Нові пости: <strong>${escapeHTML(formatDate(state.snapshot.public.freshness?.lastDiscoveryAt))}</strong></span><span>Показники постів можуть оновлюватися в різний час</span>` : '';
    byId('refresh-button').hidden = !state.error && !state.waiting;
    byId('refresh-button').disabled = state.fetching;
  }

  function renderFilters() {
    const periods = [...(state.snapshot?.public.periods ?? [])].sort((a, b) => b.key.localeCompare(a.key));
    byId('period').innerHTML = periods.length ? periods.map((period) => `<option value="${escapeHTML(period.key)}">${escapeHTML(periodLabel(period))}</option>`).join('') : '<option value="">Очікуємо дані</option>';
    byId('period').value = state.period ?? '';
    byId('period').disabled = !periods.length;
    byId('search').disabled = !periods.length;
    byId('sort').disabled = !periods.length;
    byId('sort').value = state.sort;
  }

  function summaryCount(rows, key) {
    const values = rows.map((row) => key === 'posts' ? numberValue(row.posts) : metricValue(row, key));
    if (!values.length || values.every((value) => value === null)) return '—';
    const total = values.reduce((sum, value) => sum + (value ?? 0), 0);
    return (values.some((value) => value === null) ? '≥ ' : '') + formatNumber(total, true);
  }

  function renderSummary(rows) {
    byId('summary').innerHTML = selectedPeriod() ? `<div class="summary-stat"><strong>${formatNumber(rows.length)}</strong><span>кріейторів</span></div><div class="summary-stat"><strong>${summaryCount(rows, 'posts')}</strong><span>постів</span></div><div class="summary-stat"><strong>${summaryCount(rows, 'impressions')}</strong><span>переглядів</span></div><div class="summary-stat"><strong>${summaryCount(rows, 'likes')}</strong><span>лайків</span></div><div class="summary-stat"><strong>${summaryCount(rows, 'replies')}</strong><span>коментарів</span></div>` : '';
  }

  function renderPodium(rows) {
    const leaders = rows.filter((row) => metricValue(row, state.sort) !== null).slice(0, 3);
    const top = byId('top-creators');
    top.hidden = !leaders.length || !!state.selected;
    if (top.hidden) { top.innerHTML = ''; return; }
    const maximum = metricValue(leaders[0], state.sort) ?? 0;
    top.innerHTML = leaders.map((row) => {
      const value = metricValue(row, state.sort);
      const percentage = maximum > 0 ? Math.min(100, Math.max(0, value / maximum * 100)) : 0;
      return `<article class="leader-card leader-place-${Math.min(row.displayRank, 3)}"><div class="leader-card-heading"><div class="leader-identity">${avatar(row.author, true)}<div><h3 class="leader-name">${escapeHTML(handleLabel(row.author))}</h3><p class="leader-display-name">${escapeHTML(authorName(row.author))}</p></div></div><div class="podium-rank" aria-label="Місце ${row.displayRank}"><span aria-hidden="true">❬</span>${row.displayRank}<span aria-hidden="true">❭</span></div></div><div class="leader-card-body"><div class="leader-main-metric"><strong>${state.sort === 'engagementRate' ? formatPercent(value) : formatNumber(value, true, state.sort === 'score')}</strong><span>${escapeHTML(METRICS[state.sort])} за період</span></div><div class="leader-card-stats"><span><strong>${formatNumber(row.posts)}</strong>постів</span><span><strong>${formatPercent(engagementRate(row))}</strong>Engagement</span><span><strong>${formatNumber(row.metrics?.replies, true)}</strong>коментарів</span></div><div class="leader-comparison"><div class="comparison-caption"><span>Від найвищого показника у вибірці</span><span>${Math.round(percentage)}%</span></div><progress class="comparison-track" value="${percentage.toFixed(2)}" max="100" aria-hidden="true"></progress></div></div><button type="button" class="leader-card-link" data-author-id="${escapeHTML(row.author.id)}" aria-label="Переглянути пости ${escapeHTML(handleLabel(row.author))}">Переглянути пости<span aria-hidden="true">↗</span></button></article>`;
    }).join('');
  }

  function renderTable(rows) {
    byId('score-note').textContent = state.sort === 'score' && !(selectedPeriod()?.rows ?? []).some(row => metricValue(row, 'score') !== null) ? 'Score поки недоступний. Місця за Score ще не визначені. Повний Score потребує даних для всіх складових і щонайменше 2 робіт.' : 'Score — оцінка внеску за місяць. Повний Score потребує даних для всіх складових і щонайменше 2 робіт.';
    document.querySelectorAll('th[data-metric]').forEach((cell) => { cell.classList.toggle('metric-highlight', cell.dataset.metric === state.sort); });
    const total = selectedPeriod()?.rows.length ?? 0;
    byId('result-count').textContent = selectedPeriod() ? state.query.trim() ? `${formatNumber(rows.length)} із ${formatNumber(total)} кріейторів` : `${formatNumber(total)} кріейторів · ${periodLabel(selectedPeriod())}` : '';
    byId('table-scroll').hidden = !rows.length;
    byId('leaderboard-empty').hidden = !!rows.length;
    byId('leaderboard-body').innerHTML = rows.map((row) => `<tr${String(row.author.id) === state.selected ? ' class="selected"' : ''}><td><span class="rank${Number.isInteger(row.displayRank) && row.displayRank <= 3 ? ' top-' + row.displayRank : ''}">${row.displayRank ?? '—'}</span></td><td><div class="table-creator">${avatar(row.author)}<button type="button" class="author-button" data-author-id="${escapeHTML(row.author.id)}" aria-label="Переглянути пости ${escapeHTML(handleLabel(row.author))}"><strong>${escapeHTML(authorName(row.author))}</strong><span>${escapeHTML(handleLabel(row.author))}</span></button></div></td><td class="num score-column${state.sort === 'score' ? ' metric-highlight' : ''}">${renderScore(row)}</td><td class="num">${formatNumber(row.posts)}</td>${['impressions', 'engagementRate', 'likes', 'replies', 'reposts', 'quotes'].map((key) => `<td class="num${state.sort === key ? ' metric-highlight' : ''}">${key === 'engagementRate' ? formatPercent(engagementRate(row)) : formatNumber(row.metrics?.[key])}</td>`).join('')}<td><button type="button" class="icon-button" data-author-id="${escapeHTML(row.author.id)}" aria-label="Переглянути пости ${escapeHTML(handleLabel(row.author))}">↗</button></td></tr>`).join('');
    if (!rows.length) {
      const error = state.error && !state.snapshot;
      const waiting = !state.snapshot || !state.snapshot.public.periods.length;
      const title = error ? 'Не вдалося завантажити рейтинг' : waiting ? state.fetching && !state.waiting ? 'Завантажуємо рейтинг' : 'Рейтинг ще оновлюється' : 'Кріейторів не знайдено';
      const message = error ? 'Спробуйте ще раз. Сторінка також перевірятиме оновлення автоматично.' : waiting ? 'Зараховані пости з’являться після першого оновлення даних.' : state.query.trim() ? 'Спробуйте інше ім’я або @нікнейм.' : 'За цей період поки немає зарахованих постів.';
      byId('leaderboard-empty').innerHTML = `<span class="empty-mark" aria-hidden="true">↗</span><h2>${title}</h2><p>${message}</p>${error ? '<button type="button" class="text-button" data-action="retry">Спробувати ще раз</button>' : ''}`;
    }
  }

  function renderDetail() {
    const panel = byId('detail-panel');
    const row = ranked().find((item) => String(item.author.id) === state.selected);
    if (!row) { state.selected = null; panel.hidden = true; panel.innerHTML = ''; byId('board-layout').classList.remove('detail-open'); return; }
    panel.hidden = false;
    byId('board-layout').classList.add('detail-open');
    const available = authorPosts(state.snapshot.public.posts, state.selected, selectedPeriod(), state.scope);
    const page = paginatePosts(available, state.page);
    state.page = page.page;
    const profile = profileUrl(row.author);
    panel.innerHTML = `<div class="detail-header"><div><h2 id="creator-heading" tabindex="-1">${escapeHTML(authorName(row.author))}</h2>${profile ? `<a class="handle" href="${escapeHTML(profile)}" target="_blank" rel="noopener noreferrer">${escapeHTML(handleLabel(row.author))} ↗</a>` : `<span class="handle">${escapeHTML(handleLabel(row.author))}</span>`}</div><button type="button" class="action-button" data-action="close-detail">До рейтингу</button></div><p class="detail-period">${escapeHTML(periodLabel(selectedPeriod()))} · ${row.displayRank === null ? 'місце ще не визначене' : 'місце ' + row.displayRank}</p><div class="detail-metrics">${renderContributorMetrics(row)}</div><section class="author-posts" aria-labelledby="posts-title"><h3 id="posts-title">Зараховані пости</h3><div class="post-scope" aria-label="Період постів"><button type="button" class="action-button" data-scope="period" aria-pressed="${state.scope === 'period'}">Вибраний місяць</button><button type="button" class="action-button" data-scope="all" aria-pressed="${state.scope === 'all'}">Усі доступні</button></div><p class="post-list-summary">${state.scope === 'all' ? 'Усі доступні зараховані пости автора' : escapeHTML(periodLabel(selectedPeriod()))} · ${formatNumber(page.total)} постів${page.total ? ` · ${page.page * PAGE_SIZE + 1}–${Math.min((page.page + 1) * PAGE_SIZE, page.total)}` : ''}</p><div id="post-list">${page.posts.length ? page.posts.map(renderPost).join('') : '<p class="detail-empty">Зарахованих постів у цьому перегляді поки немає.</p>'}</div>${page.totalPages > 1 ? `<div class="pagination"><button type="button" class="action-button" data-page="${page.page - 1}"${page.page === 0 ? ' disabled' : ''}>← Попередні</button><span aria-live="polite">${page.page + 1} / ${page.totalPages}</span><button type="button" class="action-button" data-page="${page.page + 1}"${page.page === page.totalPages - 1 ? ' disabled' : ''}>Наступні →</button></div>` : ''}</section>`;
  }

  function renderBoard() {
    const rows = filterRows(ranked(), state.query);
    renderSummary(rows);
    renderDetail();
    renderPodium(rows);
    renderTable(rows);
    renderStatus();
  }

  function applySnapshot(snapshot) {
    state.snapshot = snapshot;
    state.error = false;
    state.waiting = !snapshot.public.periods.length;
    if (!snapshot.public.periods.some((period) => period.key === state.period)) state.period = snapshot.public.periods.some((period) => period.key === snapshot.public.defaultPeriod) ? snapshot.public.defaultPeriod : [...snapshot.public.periods].sort((a, b) => b.key.localeCompare(a.key))[0]?.key ?? null;
    renderFilters();
    renderBoard();
  }

  async function refresh() {
    if (state.fetching) return;
    state.fetching = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    renderStatus();
    try {
      const response = await fetch('/api/leaderboard', { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }, signal: abort.signal });
      if (!response.ok) throw new Error(response.status === 503 ? 'waiting' : 'unavailable');
      const snapshot = await response.json();
      if (!isEnvelope(snapshot)) throw new Error('invalid');
      state.error = false;
      state.waiting = false;
      const same = state.snapshot && state.snapshot.revision === snapshot.revision && state.snapshot.updatedAt === snapshot.updatedAt;
      if (!same && state.selected) state.pending = snapshot;
      else if (!same || !state.snapshot) applySnapshot(snapshot);
    } catch (error) {
      state.waiting = !state.snapshot && error.message === 'waiting';
      state.error = !state.waiting;
      if (!state.snapshot) renderBoard();
    } finally {
      clearTimeout(timer);
      state.fetching = false;
      state.fetchedAt = Date.now();
      renderStatus();
    }
  }

  function closeDetail(restoreFocus = true) {
    const previous = state.selected;
    state.selected = null;
    state.page = 0;
    if (state.pending) { const next = state.pending; state.pending = null; applySnapshot(next); }
    else renderBoard();
    if (restoreFocus) {
      const source = [...document.querySelectorAll('[data-author-id]')].find((element) => element.dataset.authorId === previous);
      source?.focus({ preventScroll: true });
      if (!source) byId('search').focus({ preventScroll: true });
    }
  }

  byId('search').addEventListener('input', (event) => { state.query = event.target.value; renderBoard(); });
  byId('period').addEventListener('change', (event) => {
    state.period = event.target.value;
    state.scope = 'period';
    closeDetail(false);
    renderFilters();
    renderBoard();
  });
  byId('sort').addEventListener('change', (event) => { state.sort = event.target.value; renderBoard(); });
  byId('refresh-button').addEventListener('click', refresh);
  document.addEventListener('click', (event) => {
    const author = event.target.closest('[data-author-id]');
    if (author) {
      state.selected = author.dataset.authorId;
      state.scope = 'period';
      state.page = 0;
      renderBoard();
      byId('creator-heading')?.focus({ preventScroll: true });
      if (matchMedia('(max-width: 1180px)').matches) byId('detail-panel').scrollIntoView({ block: 'start', behavior: 'instant' });
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close-detail') { closeDetail(); return; }
    if (action === 'retry') { refresh(); return; }
    const scope = event.target.closest('[data-scope]');
    if (scope) { state.scope = scope.dataset.scope; state.page = 0; renderDetail(); byId('detail-panel').querySelector('[data-scope="' + state.scope + '"]')?.focus({ preventScroll: true }); return; }
    const page = event.target.closest('[data-page]');
    if (page && !page.disabled) {
      state.page = Number(page.dataset.page);
      renderDetail();
      byId('posts-title')?.scrollIntoView({ block: 'start' });
      byId('posts-title')?.setAttribute('tabindex', '-1');
      byId('posts-title')?.focus({ preventScroll: true });
    }
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.selected) closeDetail(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - state.fetchedAt >= 60000) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  refresh();
}

if (typeof document !== 'undefined') boot();
