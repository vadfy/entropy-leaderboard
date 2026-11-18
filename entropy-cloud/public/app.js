(function () {
  'use strict';
  const S = window.EntropyScoring, M = window.EntropyModel;
  const KEY = new URLSearchParams(location.search).has('qa') ? 'entropy-workbench-qa-v1' : 'entropy-workbench-v1';
  const UI_KEY = KEY + '-ui';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 });
  const num = v => v === null || v === undefined ? '—' : n.format(v);
  const dateText = v => v ? String(v).slice(0, 10).split('-').reverse().join('.') : '—';
  const safeUrl = v => { try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) ? u.href : '#'; } catch (_) { return '#'; } };
  const fresh = M.initialState();
  let dataset = M.validateDataset(window.EntropySeed), state = fresh, selected = null, toastTimer;
  const AUTHOR_POST_PAGE_SIZE = 20;
  let authorPostScope = 'period', authorPostLimit = AUTHOR_POST_PAGE_SIZE, authorTrigger = null;
  let reviewQuery = '', reviewPage = 0;
  const REVIEW_PAGE_SIZE = 20;
  const canDetectServer = ['http:', 'https:'].includes(location.protocol);
  let backend = { status: canDetectServer ? 'detecting' : 'local', revision: null, sync: {}, connection: { configured: false }, mode: null };
  let serverState = null, busy = false, refreshing = false, uiLoaded = false;
  const controlLocks = new Map();
  const writeActions = new Set(['moderate-ban', 'moderate-period', 'moderate-post', 'restore-ban', 'restore-period', 'restore-post', 'approve-relevance', 'reject-relevance', 'restore-relevance', 'repair-post', 'save-decision', 'add-account', 'edit-account', 'save-account', 'import', 'collector-enable', 'collector-pause', 'sync-now']);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved?.version === 1 && saved.dataset) {
      const restoredDataset = M.validateDataset(saved.dataset);
      const restoredState = M.validateState(saved.state);
      dataset = restoredDataset; state = restoredState;
    }
  } catch (_) { /* The bundled data remains intact if a saved copy cannot be read. */ }
  if (!['leaderboard', 'review', 'audience', 'method', 'settings'].includes(state.ui.view)) state.ui.view = 'leaderboard';
  if (!['impressions', 'score', 'likes', 'replies'].includes(state.ui.sort)) state.ui.sort = 'impressions';
  if (!['active', 'review', 'excluded', 'banned', 'all'].includes(state.ui.status)) state.ui.status = 'active';
  function toast(text) { $('toast').textContent = text; $('toast').hidden = false; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').classList.remove('visible'); $('toast').hidden = true; }, 5000); }
  function persist() {
    try {
      if (backend.status === 'local') localStorage.setItem(KEY, JSON.stringify({ version: 1, dataset, state }));
      else localStorage.setItem(UI_KEY, JSON.stringify(state.ui));
    } catch (_) { toast('Браузер не зберіг налаштування. За потреби збережіть резервну копію.'); }
  }
  function controls() {
    document.querySelectorAll('[data-action], #modal-root input, #modal-root textarea, #modal-root select').forEach(el => {
      const locked = busy && (el.closest('#modal-root') || writeActions.has(el.dataset.action)) || el.dataset.action === 'repair-post' && backend.status !== 'connected' ||
        ['detecting', 'error'].includes(backend.status) && writeActions.has(el.dataset.action);
      if (locked && !controlLocks.has(el)) { controlLocks.set(el, el.disabled); el.disabled = true; }
      else if (!locked && controlLocks.has(el)) { el.disabled = controlLocks.get(el); controlLocks.delete(el); }
    });
    for (const el of controlLocks.keys()) if (!el.isConnected) controlLocks.delete(el);
  }
  function setBusy(value) { busy = value; controls(); }
  function apiError(code, fallback) {
    const messages = {
      CONFLICT: 'Дані вже змінилися на сервері. Актуальний стан завантажено; перевірте його й повторіть дію.',
      REVISION_CONFLICT: 'Дані вже змінилися на сервері. Актуальний стан завантажено; перевірте його й повторіть дію.',
      SYNC_BUSY: 'Зараз триває збір даних. Зачекайте трохи й повторіть дію.',
      KEY_REQUIRED: 'Спочатку налаштуйте секрет сервера TWITTERAPI_IO_KEY.',
      PAUSE_REQUIRED: 'Спочатку призупиніть збір, а потім імпортуйте дані.',
      COLLECTOR_ACTIVE: 'Спочатку призупиніть збір, а потім імпортуйте дані.',
      COLLECTOR_DISABLED: 'Спочатку увімкніть збір, а потім запитайте оновлення.',
      COLLECTOR_PAUSED: 'Спочатку відновіть збір після перевірки причини зупинки.',
      DAILY_LIMIT: 'Досягнуто денного ліміту запитів. Наступне оновлення буде після його скидання.',
      FRESH_DISCOVERY_RESERVE: 'Додаткові запити тимчасово зупинені, щоб залишити денний запас для пошуку нових згадок.',
      REPAIR_NOT_DUE: 'Зачекайте кілька секунд після попереднього оновлення й повторіть перевірку поста.',
      UNAUTHENTICATED: 'Потрібно повторно увійти до закритого кабінету.',
      SESSION_REQUIRED: 'Повторно відкрийте кабінет, щоб відновити доступ.',
      ORIGIN_REJECTED: 'Запит відхилено. Відкрийте кабінет за його основним посиланням.',
      TOO_LARGE: 'Максимальний розмір імпорту — 15 МБ.',
      STORE_UNAVAILABLE: 'Серверне сховище зараз недоступне. Зміни не підтверджено.',
      NETWORK: 'Немає зв’язку із сервером. Зміни не підтверджено; повторіть дію після відновлення зв’язку.',
      INVALID_INPUT: 'Сервер не прийняв дані. Перевірте причину рішення, ідентифікатори та формат імпорту.'
    };
    const error = new Error(messages[code] || fallback || 'Не вдалося виконати дію на сервері. Зміни не підтверджено.');
    error.code = code; return error;
  }
  async function api(path, body) {
    let response;
    try {
      response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(body !== undefined && ['/api/sync', '/api/repair'].includes(path) ? 90000 : 45000) });
    } catch (_) { throw apiError('NETWORK'); }
    let payload;
    try { payload = await response.json(); } catch (_) { const error = apiError('INVALID_RESPONSE'); error.status = response.status; throw error; }
    if (!response.ok) {
      const code = response.status === 409 ? 'CONFLICT' : typeof payload.error === 'string' ? payload.error : payload.error?.code || 'SERVER_ERROR';
      const error = apiError(code); error.status = response.status; throw error;
    }
    return payload;
  }
  function applySnapshot(payload) {
    if (!payload || !Number.isSafeInteger(payload.revision) || !payload.sync || typeof payload.connection?.configured !== 'boolean') throw apiError('INVALID_RESPONSE');
    if (backend.revision !== null && payload.revision < backend.revision) return false;
    const nextData = M.validateDataset(payload.dataset), nextState = M.validateState(payload.state);
    let ui = { ...state.ui };
    if (!uiLoaded) {
      try { const saved = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); if (saved) ui = M.validateState({ ...nextState, ui: saved }).ui; } catch (_) { /* Invalid local preferences do not replace server data. */ }
      uiLoaded = true;
    }
    const remapAuthor = oldId => {
      if (!oldId || nextData.authors.some(a => a.id === oldId)) return oldId;
      const oldPosts = new Set(dataset.posts.filter(p => p.authorId === oldId).map(p => p.id));
      const matches = [...new Set(nextData.posts.filter(p => oldPosts.has(p.id)).map(p => p.authorId))];
      return matches.length === 1 ? matches[0] : null;
    };
    if (selected) selected = remapAuthor(selected);
    if (modalContext?.authorId) {
      const mappedAuthor = remapAuthor(modalContext.authorId);
      modalContext.authorId = mappedAuthor; modalContext.stale = !mappedAuthor;
    }
    if (modalContext?.accountId?.startsWith('sample:')) {
      const mappedAccount = remapAuthor(modalContext.accountId);
      if (mappedAccount && mappedAccount !== modalContext.accountId) {
        modalContext.accountId = mappedAccount;
        if ($('account-id')) $('account-id').value = mappedAccount;
      }
    }
    dataset = nextData; serverState = nextState; state = { ...nextState, ui };
    backend = { status: 'connected', revision: payload.revision, sync: payload.sync, connection: payload.connection, mode: payload.mode || 'cloud' };
    persist(); render();
  }
  function editing() { return !$('modal-root').hidden || backend.status === 'connected' && selected !== null || document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'); }
  async function refreshBackend(force = false) {
    if (!canDetectServer || backend.status === 'local' || refreshing && !force || !force && (busy || editing() || document.hidden)) return false;
    refreshing = true;
    try {
      const snapshot = await api('/api/workbench');
      if (!force && (busy || editing())) return false;
      applySnapshot(snapshot); return true;
    }
    catch (error) {
      if (backend.status === 'detecting' && error.status === 404) backend.status = 'local';
      else { backend.status = 'error'; backend.error = error.message; }
      render(); if (force) throw error; return false;
    } finally { refreshing = false; controls(); }
  }
  async function writeServer(path, body) {
    try { const result = await api(path, { ...body, expectedRevision: backend.revision }); applySnapshot(result); return result; }
    catch (error) {
      if (error.status === 409) {
        try { await refreshBackend(true); } catch (_) { throw apiError('NETWORK'); }
        toast(error.message);
      }
      throw error;
    }
  }
  async function saveState(nextState) {
    if (backend.status === 'local') { state = nextState; persist(); return; }
    if (backend.status !== 'connected') throw apiError('NETWORK');
    const saved = { ...serverState };
    for (const key of ['bans', 'periodDecisions', 'postExclusions', 'postRelevance', 'accountReviews', 'audit']) saved[key] = nextState[key];
    await writeServer('/api/state', { state: saved });
  }
  function sourceStatus() {
    if (backend.status === 'detecting') return 'Перевіряємо підключення до сервера…';
    if (backend.status === 'error') return 'Немає зв’язку із сервером · показано останній отриманий знімок';
    if (backend.status === 'connected') {
      if (!backend.connection.configured) return 'Сервер підключено · ключ X не налаштовано';
      if (!backend.sync.enabled) return 'Збір призупинено · показано збережені дані';
      if (backend.sync.paused) return 'Збір зупинено через помилку · потрібна перевірка';
      const hourly = backend.sync.hourly;
      if (hourly?.lastError) return '@entropyIO · повторимо пошук нових згадок · попередні дані збережено';
      if (backend.sync.collectionHealth?.allLanesCurrent === false) return 'Entropy · частина напрямів очікує перевірки · див. хід збору';
      if (backend.sync.collectionHealth?.allLanesCurrent === true) return 'Entropy · усі три напрями перевіряються щогодини · покриття X часткове';
      if (hourly?.lastSuccessAt) return '@entropyIO · нові згадки перевірено ' + timeText(hourly.lastSuccessAt) + ' · покриття X часткове';
      if (hourly) return '@entropyIO · щогодинний збір увімкнено · очікуємо першої перевірки нових згадок';
      if (backend.sync.lastError) return '@entropyIO · збір увімкнено · останній запит потребує повторної спроби';
      return '@entropyIO · щогодинний збір увімкнено · ' + (backend.sync.lastSuccessAt ? 'останній запит ' + timeText(backend.sync.lastSuccessAt) : 'очікуємо першого запиту') + ' · покриття X часткове';
    }
    return dataset.meta.source === 'historical-sample' ? 'Історичний знімок · X не підключено' : 'Локальний імпорт · без фонового оновлення';
  }
  function collectorLabel() {
    if (backend.status === 'detecting') return 'Перевіряємо збір';
    if (backend.status === 'error') return 'Немає зв’язку';
    if (backend.status !== 'connected') return 'Збережена вибірка';
    if (!backend.connection.configured) return 'X не підключено';
    if (!backend.sync.enabled || backend.sync.paused) return 'Збір призупинено';
    return 'Збір щогодини';
  }
  function collectionHealth() {
    const reported = backend.sync.collectionHealth?.freshness;
    if (reported) return ({ current: 'current', partial: 'pending', stale: 'pending', 'not-started': 'pending', error: 'attention', paused: 'attention', disabled: 'idle' })[reported] || 'idle';
    if (backend.status !== 'connected' || !backend.connection.configured || !backend.sync.enabled) return 'idle';
    if (backend.sync.paused || backend.sync.hourly?.lastError) return 'attention';
    const checked = Date.parse(backend.sync.hourly?.lastSuccessAt);
    return Number.isFinite(checked) && Date.now() - checked <= 2 * 3600000 ? 'current' : 'pending';
  }
  function backfillLabel(job, sync) {
    if (!['complete', 'complete-with-gaps', 'cancelled'].includes(job.status) && (!sync.enabled || sync.paused)) return 'Прискорений збір призупинено';
    return ({ running: 'Триває прискорений збір', waiting: 'Прискорений збір очікує повторної спроби', 'request-limit': 'Прискорений збір досяг ліміту запитів', paused: 'Прискорений збір призупинено', complete: 'Історичний прохід завершено', 'complete-with-gaps': 'Історичний прохід завершено з пропусками', cancelled: 'Історичний прохід скасовано' })[job.status] || 'Стан прискореного збору уточнюється';
  }
  function backfillHistoryProgress(sync) {
    const jobs = (Array.isArray(sync.backfillHistory) ? sync.backfillHistory : []).filter(job => job && typeof job === 'object')
      .sort((a, b) => (Date.parse(b.archivedAt || b.finishedAt || b.startedAt) || 0) - (Date.parse(a.archivedAt || a.finishedAt || a.startedAt) || 0)).slice(0, 5);
    if (!jobs.length) return '';
    const utc = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC' : '—';
    const methods = { search: 'Пошук за датами', mentions: 'Згадки акаунта', 'id-search': 'Резервний пошук за діапазоном постів' };
    return '<details class="component-details"><summary>Попередні проходи (' + jobs.length + ')</summary>' + jobs.map(job => '<div class="reason"><strong>' + esc(methods[job.method || 'search'] || 'Інший спосіб збору') + '</strong><p>' + esc(utc(job.start)) + ' — ' + esc(utc(job.endExclusive)) + ' (до)</p><p>' + esc(backfillLabel(job, { enabled: true, paused: false })) + '<br>Успішних сторінок: ' + num(job.successfulPages) + '<br>Додано нових постів: ' + num(job.addedPosts) + '<br>Пропусків: ' + num(Array.isArray(job.gaps) ? job.gaps.length : job.gapCount ?? 0) + '</p></div>').join('') + '</details>';
  }
  function backfillProgress(sync) {
    const job = sync.backfill; if (!job) return backfillHistoryProgress(sync);
    const pending = Array.isArray(job.pendingWindows) ? job.pendingWindows : [], gaps = Array.isArray(job.gaps) ? job.gaps : [];
    const utc = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC' : '—';
    return '<div class="callout info"><h3>Прискорений збір Entropy</h3><p><strong>' + esc(backfillLabel(job, sync)) + '</strong><br>Від ' + esc(utc(job.start)) + ' до ' + esc(utc(job.endExclusive)) + ' (верхня межа не включена).</p><p>Завершено часових вікон: ' + num(job.completedWindows) + '<br>Залишилося вікон: ' + num(pending.length) + '<br>Успішних сторінок: ' + num(job.successfulPages) + '<br>Використано запитів: ' + num(job.requestCount) + ' із ' + num(job.requestLimit) + '<br>Додано нових постів: ' + num(job.addedPosts) + '<br>Зафіксовано пропусків у проході: ' + num(gaps.length) + '</p>' + (job.nextAttemptAt && !['complete', 'complete-with-gaps', 'request-limit', 'paused'].includes(job.status) && sync.enabled && !sync.paused ? '<p>Наступна дозволена спроба: ' + esc(utc(job.nextAttemptAt)) + '.</p>' : '') + (pending.length ? '<p class="muted small">Найближче вікно проходу: ' + esc(utc(pending[0].start)) + ' — ' + esc(utc(pending[0].endExclusive)) + '.</p>' : '') + '<p class="muted small">Завершення проходу означає опрацювання доступних сторінок джерела за цим інтервалом; воно не гарантує, що X повернув кожну згадку. Звичайний щогодинний збір працює окремо.</p></div>' + backfillHistoryProgress(sync);
  }
  function timeText(value) { if (!value || !Number.isFinite(Date.parse(value))) return '—'; return new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
  function hourlyProgress(sync) {
    const hourly = sync.hourly; if (!hourly) return '';
    const metrics = sync.metricsRefresh;
    const pending = Array.isArray(hourly.pendingWindows) ? hourly.pendingWindows : [];
    const lanes = hourly.lanes ? '<h3>Напрями пошуку</h3><div class="discovery-lanes">' + [['direct', 'Відмітки @entropyIO'], ['evidence', 'Офіційні посилання й цитування'], ['context', 'Entropy без відмітки']].map(([id, label]) => {
      const lane = hourly.lanes[id] || {}, count = pending.filter(window => (window.discoveryLane || window.lane || 'direct') === id).length;
      const latest = lane.latestSuccessAt || (id === 'direct' ? hourly.lastSuccessAt : null);
      const health = sync.collectionHealth?.lanes?.[id]?.freshness;
      const recent = lane.latestRange;
      const fresh = recent ? pending.filter(window => (window.discoveryLane || 'direct') === id && Date.parse(window.start) < Date.parse(recent.endExclusive) && Date.parse(window.endExclusive) > Date.parse(recent.start)).length : 0;
      return '<div class="discovery-lane"><strong>' + label + '</strong>' + (health ? '<p class="muted small">' + (health === 'current' ? 'Свіжі пости перевірено' : health === 'error' ? 'Потрібна повторна спроба' : 'Очікує перевірки свіжих постів') + '</p>' : '') + '<p>Свіжі пости перевірено: ' + esc(timeText(latest)) + '<br>Продовжень свіжого пошуку: ' + num(fresh) + '<br>Остання успішна сторінка: ' + esc(timeText(lane.lastSuccessAt)) + '<br>Вікон у черзі: ' + num(count) + '</p>' + (lane.latestError || lane.lastError ? '<p class="metrics-notice">Цей напрям очікує повторної спроби.</p>' : '') + '</div>';
    }).join('') + '</div><p class="muted small">Успішна сторінка не підтверджує повноту пошуку. Свіжі пости мають окрему перевірку щогодини; історичний дозбір не займає її місце.</p>' : '';
    const cycle = hourly.cycle;
    const cycleText = cycle ? '<h3>Останній запуск перевірки</h3><p>Початок: ' + esc(timeText(cycle.startedAt)) + '<br>Завершення: ' + esc(timeText(cycle.finishedAt)) + '<br>Стан: ' + esc(({ complete: 'Перевірку виконано', partial: 'Виконано частково', running: 'Триває', failed: 'Потрібна повторна спроба', skipped: 'Ще не настав час перевірки' })[cycle.status] || 'Стан уточнюється') + '<br>Запитів у запуску: ' + num(cycle.requestCount ?? null) + '</p>' : '';
    return '<div class="collector-progress"><h3>Пошук нових постів щогодини</h3><p>Остання спроба: ' + esc(timeText(hourly.lastAttemptAt)) + '<br>Остання успішна перевірка відміток: ' + esc(timeText(hourly.lastSuccessAt)) + '<br>Наступна спроба дозволена після: ' + esc(timeText(hourly.nextRunAt)) + '<br>Часових вікон у черзі: ' + num(Array.isArray(hourly.pendingWindows) ? hourly.pendingWindows.length : 0) + '</p>' + (hourly.lastError ? '<p class="error">Остання перевірка не завершилася. Сервер повторить її, збережені пости залишаються в рейтингу.</p>' : '') + lanes + cycleText + '<p class="muted small">Пошук працює на сервері незалежно від відкритої сторінки. Час дозволеної спроби не є гарантією точного часу запуску.</p>' + (metrics ? '<h3>Оновлення метрик постів</h3><p>Останній успішний пакет: ' + esc(timeText(metrics.lastSuccessAt)) + '<br>Постів у черзі: ' + num(metrics.pendingCount ?? null) + '</p>' + (metrics.lastError ? '<p class="metrics-notice">Метрики частини постів очікують оновлення. Показано попередні значення; пошук нових згадок продовжується окремо.</p>' : '<p class="muted small">Пакети метрик оновлюються окремо; різні пости можуть мати різний час спостереження.</p>') : '') + '</div>';
  }
  function period() { return M.periodFor(state.ui.period, dataset); }
  function aggregates() { const p = period(); return dataset.authors.map(a => M.aggregateAuthor(dataset, state, a, p)); }
  function getAuthor(id) { return aggregates().find(a => a.author.id === id); }
  function engagementPercent(a) {
    const value = a.score.components.ERpercent;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
  function engagementLabel(a) { const value = engagementPercent(a); return value === null ? '—' : num(value) + '%'; }
  function scoreCell(a) {
    if (!a.participates) return '<span class="score-state muted">Не враховано</span>';
    const score = a.score.score;
    if (score !== null) return num(score) + (a.score.status === 'review' ? '<span class="subtle score-note">Попередній · на перевірці</span>' : '');
    if (a.score.status === 'ineligible') return '<span class="score-state muted" title="Для Score потрібно щонайменше 2 враховані роботи й покази більше нуля">Не допущено</span>';
    const missing = a.score.missing.map(key => missingLabels[key] || key).join(', ');
    return '<span class="score-state muted" title="' + esc(missing ? 'Бракує: ' + missing : 'Для розрахунку Score потрібні повні перевірені дані') + '">Недостатньо даних</span>';
  }
  function autoStatus(a) {
    if (a.status === 'banned') return '<span class="badge danger">Бан</span>';
    if (a.status === 'excluded') return '<span class="badge muted">Не зараховано</span>';
    if (a.status === 'no-posts') return '<span class="badge muted">Немає придатних постів</span>';
    if (!a.posts.length && a.pendingPosts?.length) return '<span class="badge warning">Згадки потребують перевірки</span>';
    if (a.score.requiresReview) return '<span class="badge warning">На перевірці</span>';
    if (a.score.status === 'ineligible') return '<span class="badge muted">Менше 2 постів / немає показів</span>';
    if (a.score.status === 'incomplete') return '<span class="badge muted">Score не оцінено</span>';
    return '<span class="badge success">Розраховано</span>';
  }
  function filtered() {
    const search = state.ui.search.trim().toLowerCase();
    return aggregates().filter(a => {
      const status = state.ui.status;
      const pass = status === 'all' || status === 'active' && ['active', 'review'].includes(a.status) || status === a.status;
      return pass && (!search || (a.author.handle + ' ' + (a.author.displayName || '')).toLowerCase().includes(search));
    }).sort((a, b) => {
      const av = state.ui.sort === 'score' ? a.participates ? a.score.score : null : a.metrics[state.ui.sort];
      const bv = state.ui.sort === 'score' ? b.participates ? b.score.score : null : b.metrics[state.ui.sort];
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      return (bv ?? 0) - (av ?? 0) || (b.metrics.impressions ?? 0) - (a.metrics.impressions ?? 0) || a.author.handle.localeCompare(b.author.handle);
    });
  }
  function render() {
    document.querySelectorAll('.prototype-label').forEach(el => { el.textContent = backend.status === 'connected' && backend.mode === 'cloud' ? 'Хмарний кабінет' : 'Локальний прототип'; });
    document.querySelectorAll('[data-view]').forEach(b => { const on = b.dataset.view === state.ui.view; b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
    ['leaderboard', 'review', 'audience', 'method', 'settings'].forEach(v => $('view-' + v).hidden = state.ui.view !== v);
    $('review-nav-count').textContent = num(M.relevanceQueue(dataset, state).length);
    $('source-status').textContent = sourceStatus();
    $('source-status').dataset.health = collectionHealth();
    $('collector-label').textContent = collectorLabel();
    $('collector-label').dataset.health = collectionHealth();
    const monthKeys = [...new Set(dataset.posts.map(p => p.date.slice(0, 7)).concat(/^\d{4}-\d{2}$/.test(state.ui.period) ? [state.ui.period] : []))].sort().reverse();
    $('period').innerHTML = monthKeys.map(k => { const text = new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(k + '-01T00:00:00Z')); return '<option value="' + k + '">' + text[0].toUpperCase() + text.slice(1) + ' · UTC</option>'; }).join('') + '<option value="sample">Вибірка · ' + esc(dateText(dataset.meta.periodStart)) + ' — ' + esc(dateText(dataset.meta.periodEndExclusive)) + ' (до)</option>';
    $('period').value = state.ui.period; $('sort').value = state.ui.sort; $('status-filter').value = state.ui.status; $('search').value = state.ui.search;
    renderBoard(); renderReview(); renderAudience(); renderMethod(); renderSettings(); controls();
  }
  function relevanceSummary(post) {
    const decision = state.postRelevance?.[post.id];
    if (decision) return decision.action === 'approve' ? 'Належність до Entropy підтверджена вручну' : 'Відхилено після перевірки контексту';
    if (!post.relevance) return 'Історичний запис · контекст окремо не оцінювався';
    if (post.relevance.reasonCodes?.includes('CONFLICTING_CONTEXT')) return 'Є ознаки нашого Entropy й іншого проєкту — потрібна ручна перевірка';
    const signals = post.relevance.signals || [];
    const descriptions = [];
    if (signals.includes('direct_mention')) descriptions.push('Пряма згадка офіційного акаунта');
    if (signals.includes('official_domain') || signals.includes('official_post_link')) descriptions.push('Посилання на офіційний ресурс');
    if (signals.includes('official_quote')) descriptions.push('Цитування офіційного поста');
    if (signals.includes('product_context') || signals.includes('hip3_context') || signals.includes('hyperliquid_context')) descriptions.push('Контекст продукту Entropy');
    return descriptions.join(' · ') || (post.relevance.status === 'accepted' ? 'Контекст Entropy підтверджено правилом збору' : 'Є згадка Entropy, але проєкт ще не підтверджено');
  }
  function renderReview() {
    const all = M.relevanceQueue(dataset, state), rows = M.relevanceQueue(dataset, state, reviewQuery);
    const totalPages = Math.max(1, Math.ceil(rows.length / REVIEW_PAGE_SIZE));
    reviewPage = Math.min(reviewPage, totalPages - 1);
    const visible = rows.slice(reviewPage * REVIEW_PAGE_SIZE, (reviewPage + 1) * REVIEW_PAGE_SIZE);
    const authors = new Map(dataset.authors.map(author => [author.id, author]));
    $('review-search').value = reviewQuery;
    $('review-content').innerHTML = '<p class="subtle review-result-count" role="status">Очікують перевірки: ' + num(all.length) + (reviewQuery ? ' · знайдено: ' + num(rows.length) : '') + '. Показано ' + num(visible.length) + ' постів. Рішення тут не скасовує бан або виключення поста.</p>' + (visible.length ? '<div class="review-post-list">' + visible.map(post => {
      const author = authors.get(post.authorId);
      return '<article class="post-card review-post-card" data-review-post-id="' + esc(post.id) + '"><div class="post-header"><strong>@' + esc(author?.handle || post.authorHandle || '') + '</strong><time>' + dateText(post.publishedAt || post.date) + '</time><span class="badge warning">Не враховано · потрібен контекст</span></div><p class="post-body">' + esc(post.body || post.summary || 'Повний текст не отримано; перевірте оригінал у X.') + '</p><p class="subtle">' + esc(relevanceSummary(post)) + '</p><div class="post-metrics">' + num(post.metrics.impressions) + ' переглядів · ' + num(post.metrics.likes) + ' лайків · ' + num(post.metrics.replies) + ' коментарів</div><div class="post-actions"><a href="' + esc(safeUrl(post.url)) + '" target="_blank" rel="noopener noreferrer">Відкрити в X ↗</a><button class="action-button primary" data-action="approve-relevance" data-author="' + esc(post.authorId) + '" data-post="' + esc(post.id) + '">Це наш Entropy</button><button class="action-button ghost" data-action="reject-relevance" data-author="' + esc(post.authorId) + '" data-post="' + esc(post.id) + '">Інший контекст</button></div></article>';
    }).join('') + '</div>' : '<div class="empty-state"><h2>' + (reviewQuery ? 'Збігів у черзі немає' : 'Черга перевірки порожня') + '</h2><p>Підтверджені згадки одразу потрапляють у розрахунок. Неоднозначні пости з’являтимуться тут після збору; порожня черга не означає повне покриття X.</p></div>') + (totalPages > 1 ? '<div class="review-pagination"><button class="action-button ghost" data-action="review-page" data-page="' + (reviewPage - 1) + '"' + (!reviewPage ? ' disabled' : '') + '>← Попередні</button><span>' + (reviewPage + 1) + ' / ' + totalPages + '</span><button class="action-button ghost" data-action="review-page" data-page="' + (reviewPage + 1) + '"' + (reviewPage + 1 === totalPages ? ' disabled' : '') + '>Наступні →</button></div>' : '');
  }
  function moderateRelevance(type, authorId, postId) {
    const post = dataset.posts.find(post => post.id === postId && post.authorId === authorId);
    if (!post || !M.postEligibility(post).eligible) { toast('Реплай або репост не можна зарахувати до рейтингу.'); return; }
    modalContext = { type, authorId, postId, periodKey: post.date.slice(0, 7) };
    const approved = type === 'approve-relevance';
    modal(approved ? 'Підтвердити згадку Entropy' : 'Відхилити інший контекст', '<p class="muted">' + (approved ? 'Підтвердження дозволить врахувати цей пост, якщо автор і пост не виключені іншими рішеннями.' : 'Пост залишиться в історії, але не впливатиме на рейтинг навіть після нового автоматичного збігу.') + '</p><div class="form-grid"><label class="field full-width"><span class="form-label">Пояснення рішення *</span><textarea class="form-textarea" id="public-reason" rows="3" placeholder="Що підтверджує або спростовує зв’язок із нашим Entropy"></textarea></label><label class="field full-width"><span class="form-label">Внутрішня нотатка команди</span><textarea class="form-textarea" id="internal-note" rows="2"></textarea></label></div>', '<button class="action-button ghost" data-action="close-modal">Скасувати</button><button class="action-button primary" data-action="save-decision">Зберегти рішення</button>');
  }
  function postIdFromInput(value) {
    const input = String(value).trim();
    if (/^[1-9]\d{0,24}$/.test(input)) return input;
    try {
      const url = new URL(input);
      if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
      const match = url.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/([1-9]\d{0,24})\/?$/);
      return match ? match[1] : null;
    } catch (_) { return null; }
  }
  async function repairPost() {
    if (busy || backend.status !== 'connected') return;
    const id = postIdFromInput($('repair-post-input').value);
    if (!id) { $('repair-post-result').textContent = 'Вкажіть коректне HTTPS-посилання на пост у X або його числовий ID.'; return; }
    try {
      setBusy(true);
      $('repair-post-result').textContent = 'Перевіряємо пост через провайдера…';
      const result = await writeServer('/api/repair', { ids: [id] });
      const repair = result.sync?.postRepair;
      if (repair?.status === 'error') throw new Error('Провайдер не завершив перевірку. Старі дані збережено; повторіть пізніше.');
      const queued = repair?.queuedForReview || 0;
      $('repair-post-result').textContent = queued ? 'Пост додано до черги перевірки контексту. До підтвердження він не враховується.' : repair?.ignoredReplies ? 'Це реплай — він не враховується.' : repair?.accepted ? 'Пост перевірено. Підтверджений контекст враховується з урахуванням модерації.' : 'Пост не зараховано: провайдер не повернув його або зв’язок із нашим Entropy не підтвердився.';
      toast($('repair-post-result').textContent);
    } catch (error) { $('repair-post-result').textContent = error.message; toast(error.message); }
    finally { setBusy(false); }
  }
  function avatar(author, size = '') {
    const handle = String(author.handle || ''), initials = (author.displayName || handle).trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || '').join('').slice(0, 2).toUpperCase();
    const tone = [...handle].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
    return '<span class="creator-avatar ' + size + ' avatar-tone-' + tone + '" aria-hidden="true">' + esc(initials || handle.slice(0, 2).toUpperCase()) + '</span>';
  }
  function boardMetric(author) { return state.ui.sort === 'score' ? author.participates ? author.score.score : null : author.metrics[state.ui.sort]; }
  function renderTopCreators(rows) {
    const leaders = rows.filter(author => author.participates && boardMetric(author) !== null).slice(0, 3);
    const labels = { impressions: 'Показів', likes: 'Лайків', replies: 'Коментарів', score: 'Score' };
    const leadingValue = leaders.length ? boardMetric(leaders[0]) : 0;
    $('top-creators').hidden = selected !== null || !leaders.length;
    $('top-creators').innerHTML = leaders.map((author, i) => {
      const value = boardMetric(author), share = leadingValue > 0 ? Math.max(0, Math.min(100, value / leadingValue * 100)) : null;
      return '<article class="leader-card leader-place-' + (i + 1) + '"><div class="leader-card-heading"><div class="leader-identity">' + avatar(author.author, 'avatar-large') + '<div><button type="button" class="author-button leader-name" data-action="open-author" data-author="' + esc(author.author.id) + '">@' + esc(author.author.handle) + '</button><span class="leader-display-name">' + esc(author.author.displayName || author.author.handle) + '</span></div></div><span class="podium-rank" aria-label="Місце ' + (i + 1) + '"><span aria-hidden="true">❬</span>' + (i + 1) + '<span aria-hidden="true">❭</span></span></div><div class="leader-card-body"><div class="leader-main-metric"><strong>' + num(value) + '</strong><span>' + labels[state.ui.sort] + ' за обраний період</span></div><div class="leader-card-stats"><span><strong>' + num(author.posts.length) + '</strong>постів</span><span><strong>' + num(author.metrics.likes) + '</strong>лайків</span><span><strong>' + num(author.metrics.replies) + '</strong>коментарів</span></div>' + (share !== null ? '<div class="leader-comparison"><div class="comparison-caption"><span>Від показника лідера</span><span>' + num(share) + '%</span></div><div class="comparison-track" aria-hidden="true"><span style="width:' + share.toFixed(2) + '%"></span></div></div>' : '') + '</div><button type="button" class="leader-card-link" data-action="open-author" data-author="' + esc(author.author.id) + '">Переглянути пости <span aria-hidden="true">↗</span></button></article>';
    }).join('');
  }
  function renderBoard() {
    const rows = filtered(), all = aggregates(), included = all.filter(a => a.participates);
    const I = included.some(a => a.metrics.impressions === null) ? null : included.reduce((s, a) => s + a.metrics.impressions, 0);
    $('summary').innerHTML = [['Авторів у перегляді', rows.length], ['Врахованих постів', included.reduce((s, a) => s + a.posts.length, 0)], ['Показів врахованих постів', I], ['Оцінок Score готово', all.filter(a => a.participates && a.score.score !== null).length]].map(([label, value]) => '<div class="summary-stat"><span class="summary-value">' + num(value) + '</span><span class="summary-label">' + esc(label) + '</span></div>').join('');
    $('period-note').textContent = (period().monthly ? 'Місячний розрахунок UTC. ' : 'Дослідницький інтервал; це не календарний місяць Zama. ') + (backend.status === 'connected' ? 'Вибірка часткова. Останній знімок джерела: ' + dateText(dataset.meta.asOf) + '; окремі лічильники можуть бути старішими. Підсумковий відбір не зафіксовано.' : 'Вибірка часткова. Метрики накопичені на ' + dateText(dataset.meta.asOf) + '; підсумковий відбір не зафіксовано.');
    const hourly = backend.sync.hourly;
    const checks = hourly?.lanes ? [['direct', '@entropyIO'], ['evidence', 'Посилання й цитування'], ['context', 'Без відмітки']].map(([id, label]) => '<span>' + label + ': <strong>' + esc(timeText(hourly.lanes[id]?.latestSuccessAt || (id === 'direct' ? hourly.lastSuccessAt : null))) + '</strong></span>').join('') : '<span>Остання перевірка нових згадок: <strong>' + esc(timeText(hourly?.lastSuccessAt)) + '</strong></span>';
    $('freshness-note').innerHTML = backend.status === 'connected' ? '<span class="freshness-item"><span class="status-dot" data-health="' + collectionHealth() + '" aria-hidden="true"></span>' + esc(collectorLabel()) + '</span>' + checks + '<span>Наступна спроба після: <strong>' + esc(timeText(hourly?.nextRunAt || backend.sync.nextRunAt)) + '</strong></span>' + (backend.sync.metricsRefresh?.lastError ? '<span class="metrics-notice">Метрики частини постів очікують оновлення</span>' : '') : '<span>Останній збережений знімок · ' + esc(dateText(dataset.meta.asOf)) + '</span>';
    renderTopCreators(rows);
    let ranked = 0;
    $('leaderboard-body').innerHTML = rows.map((a, i) => {
      const reposts = a.metrics.reposts !== null ? num(a.metrics.reposts) : a.metrics.uiReposts !== null ? '<span class="muted" title="Лічильник інтерфейсу X; не підставляється в API-формулу">UI ' + num(a.metrics.uiReposts) + '</span>' : '—';
      const place = a.participates ? ++ranked : null;
      const metricClass = key => state.ui.sort === key ? ' metric-highlight' : '';
      return '<tr' + (selected === a.author.id ? ' class="selected"' : '') + '><td><span class="rank ' + (place && place < 4 ? 'top top-' + place : '') + '">' + (place ?? '—') + '</span></td><td><div class="table-creator">' + avatar(a.author) + '<div><button type="button" class="author-button" data-action="open-author" data-author="' + esc(a.author.id) + '">@' + esc(a.author.handle) + '</button><span class="subtle">' + (a.manual ? esc(a.manual.reason) : a.posts.length + ' враховано з ' + a.allPosts.length) + '</span></div></div></td><td class="num strong score-cell' + metricClass('score') + '">' + scoreCell(a) + '</td><td class="num">' + a.posts.length + '</td><td class="num strong' + metricClass('impressions') + '">' + num(a.metrics.impressions) + '</td><td class="num engagement-cell" title="Лайки + API-репости + цитування, поділені на покази">' + engagementLabel(a) + '</td><td class="num' + metricClass('likes') + '">' + num(a.metrics.likes) + '</td><td class="num">' + reposts + '</td><td class="num">' + num(a.metrics.quotes) + '</td><td class="num' + metricClass('replies') + '">' + num(a.metrics.replies) + '</td><td class="status-cell">' + autoStatus(a) + '</td><td><button type="button" class="icon-button" data-action="open-author" data-author="' + esc(a.author.id) + '" aria-label="Перегляд @' + esc(a.author.handle) + '">↗</button></td></tr>';
    }).join('');
    $('leaderboard-empty').hidden = rows.length > 0;
    renderDetail();
  }
  const missingLabels = { impressions: 'покази', likes: 'лайки', reposts: 'API-репости', quotes: 'цитування', followers: 'кількість підписників', smartFollowers: 'smart followers', smartFollowersComplete: 'повнота оцінки підписників', smartEngagement: 'smart engagement', smartEngagementComplete: 'повнота оцінки взаємодій', posts: 'кількість робіт' };
  function authorPosts(authorId, scope = authorPostScope) {
    const p = period();
    return dataset.posts.filter(post => post.authorId === authorId && (scope === 'history' || post.date >= p.start && post.date < p.endExclusive))
      .sort((a, b) => String(b.publishedAt || b.date).localeCompare(String(a.publishedAt || a.date)) || b.id.localeCompare(a.id));
  }
  function openAuthor(authorId, trigger) {
    if (!getAuthor(authorId)) return;
    selected = authorId; authorTrigger = trigger; authorPostScope = 'period'; authorPostLimit = AUTHOR_POST_PAGE_SIZE;
    renderBoard();
    $('detail-title').focus({ preventScroll: true });
    $('detail-panel').scrollIntoView({ block: 'start' });
  }
  function closeAuthor(restoreFocus = true) {
    const oldId = selected, previousTrigger = authorTrigger;
    selected = null; authorTrigger = null; renderBoard();
    if (!restoreFocus) return;
    const trigger = previousTrigger?.isConnected ? previousTrigger : [...document.querySelectorAll('[data-action="open-author"]')].find(el => el.dataset.author === oldId);
    trigger?.focus({ preventScroll: true }); trigger?.scrollIntoView({ block: 'center' });
  }
  function changeAuthorScope(scope) {
    if (!['period', 'history'].includes(scope)) return;
    authorPostScope = scope; authorPostLimit = AUTHOR_POST_PAGE_SIZE; renderDetail();
    document.querySelector('[data-action="author-post-scope"][data-scope="' + scope + '"]')?.focus({ preventScroll: true });
  }
  function moreAuthorPosts() {
    const previousLimit = authorPostLimit;
    authorPostLimit += AUTHOR_POST_PAGE_SIZE; renderDetail();
    const firstNew = $('detail-panel').querySelectorAll('.post-card')[previousLimit];
    firstNew?.focus({ preventScroll: true }); firstNew?.scrollIntoView({ block: 'start' });
  }
  function renderDetail() {
    const el = $('detail-panel');
    const a = selected ? getAuthor(selected) : null;
    el.hidden = !a; $('board-layout').classList.toggle('detail-open', !!a); if (!a) return;
    const id = esc(a.author.id), p = period(), c = a.score.components;
    const missing = a.score.missing.map(k => missingLabels[k] || k).join(', ');
    const restoration = state.bans[a.author.id] ? '<button class="action-button" data-action="restore-ban" data-author="' + id + '">Розбанити</button>' : state.periodDecisions[p.key + '|' + a.author.id] ? '<button class="action-button" data-action="restore-period" data-author="' + id + '">Повернути за період</button>' : '<button class="action-button" data-action="moderate-period" data-author="' + id + '">Не зарахувати</button><button class="action-button danger" data-action="moderate-ban" data-author="' + id + '">Бан</button>';
    let html = '<div class="detail-header"><div><h2 id="detail-title" tabindex="-1">@' + esc(a.author.handle) + '</h2>' + autoStatus(a) + '</div><button class="action-button ghost" data-action="close-detail" aria-label="Повернутися до лідерборду">← Лідерборд</button></div>';
    html += '<div class="detail-actions">' + restoration + '<button class="action-button ghost" data-action="creator-preview" data-author="' + id + '">Вигляд для автора</button></div>';
    html += '<p class="subtle">У рейтинг входять оригінальні твіти й цитування. Реплаї, включно з відповідями у власних тредах, і звичайні репости не враховуються; збережені записи залишаються в історії.</p>';
    html += '<p class="subtle">Рейтинг і рішення «Не зарахувати» — за обраний період: ' + dateText(p.start) + ' — ' + dateText(p.endExclusive) + ' (до), UTC. Виключення окремого поста діє для нього в усіх періодах.</p>';
    if (a.manual) html += '<div class="reason"><strong>Причина для автора</strong><p>' + esc(a.manual.reason) + '</p></div>' + (a.manual.internalNote ? '<div class="internal-note"><strong>Внутрішня нотатка</strong><p>' + esc(a.manual.internalNote) + '</p></div>' : '');
    if (a.score.requiresReview) html += '<div class="callout">ER ' + num(c.ERpercent) + '% перевищує 20%. Потрібна перевірка; автоматичного бану немає.</div>';
    html += '<div class="detail-metrics"><span>' + (a.manual ? 'У рейтингу: 0 постів; збережено ' + a.allPosts.length : a.posts.length + ' із ' + a.allPosts.length + ' постів враховано') + '</span><span>Підписники: ' + num(a.author.followers) + '</span><span>Робіт для Score: ' + a.works.length + '</span><span class="detail-score">Score<strong>' + scoreCell(a) + '</strong></span><span>Engagement<strong>' + engagementLabel(a) + '</strong></span></div>';
    html += '<details class="component-details"><summary>З чого складається Score</summary><div class="component-grid">' + [['Аудиторія', c.audienceBlock], ['Охоплення', c.reachBlock], ['Залучення', c.engageBlock], ['Ефективність', c.efficiencyBlock], ['Множник ER', c.erMult], ['Регулярність', c.postMult], ['Додатковий штраф', c.penaltyMult], ['Score', a.score.score]].map(([k,v]) => '<div class="component"><span>' + k + '</span><strong>' + num(v) + '</strong></div>').join('') + '</div>' + (missing ? '<p class="muted small">Бракує: ' + esc(missing) + '. Невідомі значення не є нулями.</p>' : '') + '</details>';
    html += '<details class="component-details"><summary>Smart-дані та повнота</summary><p class="small">Відома зважена сума підписників: ' + num(a.smart.smartFollowers) + '. Оцінено акаунтів: ' + a.smart.followers.assessedCount + ' із ' + a.smart.followers.confirmedCount + ' отриманих підписників. Набір ' + (a.smartFollowersComplete ? 'повний' : 'неповний') + '.</p><p class="small">Відомий smart engagement: ' + num(a.smart.smartEngagement) + '. Учасників дискусії з оцінкою: ' + a.smart.engagement.assessedCount + '. Набір ' + (a.smartEngagementComplete ? 'повний' : 'неповний') + '.</p><p class="muted small">Нуль відомих внесків у неповному наборі не означає, що їх немає на X.</p></details>';
    const historyCount = authorPosts(a.author.id, 'history').length, posts = authorPosts(a.author.id), visiblePosts = posts.slice(0, authorPostLimit);
    html += '<section class="author-posts" aria-labelledby="author-posts-title"><h3 id="author-posts-title">Усі знайдені пости</h3><div class="post-scope" role="group" aria-label="Період постів автора"><button class="action-button ghost" data-action="author-post-scope" data-scope="period" aria-pressed="' + (authorPostScope === 'period') + '">Обраний період · ' + a.allPosts.length + '</button><button class="action-button ghost" data-action="author-post-scope" data-scope="history" aria-pressed="' + (authorPostScope === 'history') + '">Уся зібрана історія · ' + historyCount + '</button></div><p class="subtle post-list-summary" role="status">Показано ' + visiblePosts.length + ' із ' + posts.length + ' знайдених постів · спочатку нові. Виключені пости залишаються у списку. Історія не змінює період рейтингу; покриття X може бути неповним.</p>';
    if (!posts.length) html += '<div class="empty-state">' + (authorPostScope === 'period' ? 'У збереженій вибірці немає постів за обраний період. Перевірте всю зібрану історію.' : 'У збереженій історії ще немає постів цього автора.') + '</div>';
    html += visiblePosts.map(post => {
      const inPeriod = post.date >= p.start && post.date < p.endExclusive;
      const d = state.postExclusions[post.id], ban = state.bans[a.author.id];
      const creatorDecision = ban || state.periodDecisions[(inPeriod ? p.key : post.date.slice(0, 7)) + '|' + a.author.id];
      const eligibility = M.postEligibility(post), relevant = M.relevanceEligibility(post, state), ignored = !eligibility.eligible || !relevant.eligible;
      const status = !eligibility.eligible ? eligibility.reason === 'reply' ? 'Реплай · не враховується' : 'Репост · не враховується' : !relevant.eligible ? relevant.reason === 'relevance-review' ? 'Не враховано · потрібна перевірка контексту' : 'Не враховано · інший контекст' : d ? 'Виключено вручну' : ban ? 'Не враховано: бан автора' : creatorDecision ? 'Не враховано: рішення за період' : inPeriod ? 'Враховано в метриках' : 'Збережено в історії';
      const reason = (decision, label) => decision ? '<div class="reason"><strong>' + label + '</strong><p>' + esc(decision.reason) + '</p></div>' + (decision.internalNote ? '<div class="internal-note"><strong>Внутрішня нотатка</strong><p>' + esc(decision.internalNote) + '</p></div>' : '') : '';
      const relevanceAction = !eligibility.eligible ? '' : state.postRelevance?.[post.id] ? '<button class="action-button ghost" data-action="restore-relevance" data-author="' + id + '" data-post="' + esc(post.id) + '">Скасувати перевірку контексту</button>' : !relevant.eligible ? '<button class="action-button" data-action="approve-relevance" data-author="' + id + '" data-post="' + esc(post.id) + '">Це наш Entropy</button><button class="action-button ghost" data-action="reject-relevance" data-author="' + id + '" data-post="' + esc(post.id) + '">Інший контекст</button>' : '';
      const action = (ignored ? '' : '<button class="action-button ghost" data-action="' + (d ? 'restore-post' : 'moderate-post') + '" data-author="' + id + '" data-post="' + esc(post.id) + '">' + (d ? 'Повернути' : 'Виключити пост') + '</button>') + relevanceAction;
      const contextHtml = post.relevance || state.postRelevance?.[post.id] ? '<p class="subtle">' + esc(relevanceSummary(post)) + '</p>' : '';
      return '<article class="post-card' + (ignored || d || creatorDecision ? ' excluded' : '') + '" tabindex="-1" data-post-id="' + esc(post.id) + '"><div class="post-header"><span>' + dateText(post.date) + '</span><span class="post-status">' + (!inPeriod ? '<span class="badge muted">Поза обраним періодом</span>' : '') + '<span class="badge ' + (ignored || d || creatorDecision ? 'warning' : 'muted') + '">' + status + '</span></span></div>' + (!post.body ? '<span class="subtle">Короткий опис; повний текст не завантажено</span>' : '') + '<p class="post-body">' + esc(post.body || post.summary) + '</p>' + contextHtml + '<div class="post-metrics">' + num(post.metrics.impressions) + ' показів · ' + num(post.metrics.likes) + ' лайків · ' + num(post.metrics.replies) + ' коментарів</div>' + (post.availability?.status === 'unavailable' ? '<p class="muted small">Остання перевірка не повернула пост. Показано попередні збережені метрики.</p>' : '') + reason(d, 'Причина виключення поста') + reason(state.postRelevance?.[post.id], 'Причина перевірки контексту') + reason(creatorDecision, 'Причина рішення щодо автора') + '<div class="post-actions"><a href="' + esc(safeUrl(post.url)) + '" target="_blank" rel="noopener noreferrer">Оригінал у X ↗</a>' + action + '</div></article>';
    }).join('');
    if (visiblePosts.length < posts.length) html += '<button class="action-button ghost post-load-more" data-action="author-post-more">Показати ще ' + Math.min(AUTHOR_POST_PAGE_SIZE, posts.length - visiblePosts.length) + ' · залишилося ' + (posts.length - visiblePosts.length) + '</button>';
    html += '</section>';
    const events = state.audit.filter(e => e.authorId === a.author.id).slice(0, 8);
    if (events.length) html += '<details class="component-details"><summary>Історія рішень (' + events.length + ')</summary>' + events.map(e => '<div class="reason"><span class="muted small">' + dateText(e.at) + ' · ' + esc(eventLabel(e.type)) + '</span><p>' + esc(e.reason) + '</p>' + (e.internalNote ? '<div class="internal-note">' + esc(e.internalNote) + '</div>' : '') + '</div>').join('') + '</details>';
    el.innerHTML = html;
  }
  function eventLabel(type) { return ({ ban: 'Бан', 'exclude-period': 'Не зараховано за період', 'exclude-post': 'Виключено пост', 'restore-ban': 'Бан скасовано', 'restore-period': 'Участь відновлено', 'restore-post': 'Пост повернуто', 'approve-relevance': 'Згадку підтверджено', 'reject-relevance': 'Інший контекст відхилено', 'restore-relevance': 'Перевірку контексту скасовано', 'account-review': 'Оцінка довіри' })[type] || type; }
  let previousFocus = null;
  function modal(title, content, actions) {
    previousFocus = document.activeElement;
    const root = $('modal-root'); root.hidden = false;
    root.innerHTML = '<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">' + esc(title) + '</h2><button class="icon-button" data-action="close-modal" aria-label="Закрити вікно">×</button></div>' + content + '<p class="error" id="modal-error" role="alert"></p><div class="modal-actions">' + actions + '</div></section></div>';
    const focus = root.querySelector('textarea,input,select,button'); if (focus) focus.focus();
  }
  let modalContext = null;
  function closeModal() { $('modal-root').hidden = true; $('modal-root').innerHTML = ''; modalContext = null; if (previousFocus?.isConnected) previousFocus.focus(); previousFocus = null; }
  function moderate(type, authorId, postId) {
    const a = getAuthor(authorId); modalContext = { type, authorId, postId, periodKey: period().key };
    const title = type === 'ban' ? 'Бан @' + a.author.handle : type === 'exclude-period' ? 'Не зарахувати @' + a.author.handle : 'Виключити пост';
    modal(title, '<p class="muted">' + (type === 'ban' ? 'Автор буде виключений із цього й наступних відборів до розбану.' : type === 'exclude-period' ? 'Рішення стосується лише обраного періоду.' : 'Пост залишиться у списку, але його метрики та взаємодії не формуватимуть результат.') + '</p><div class="form-grid"><label class="field full-width"><span class="form-label">Причина для кріейтора *</span><textarea class="form-textarea" id="public-reason" rows="3" placeholder="Конкретна причина та, за потреби, посилання на докази"></textarea></label><label class="field full-width"><span class="form-label">Внутрішня нотатка команди</span><textarea class="form-textarea" id="internal-note" rows="2" placeholder="Не відображається в авторському перегляді"></textarea></label></div>', '<button class="action-button ghost" data-action="close-modal">Скасувати</button><button class="action-button ' + (type === 'ban' ? 'danger' : 'primary') + '" data-action="save-decision">Застосувати</button>');
  }
  async function saveDecision() {
    if (busy) return;
    try {
      if (modalContext?.stale || !modalContext?.authorId) throw new Error('Автор змінився після оновлення даних. Закрийте вікно й відкрийте його знову.');
      const next = M.decision(state, { ...modalContext, reason: $('public-reason').value, internalNote: $('internal-note').value }, new Date().toISOString());
      setBusy(true); await saveState(next); closeModal(); render();
      toast(backend.status === 'local' ? 'Рішення збережено локально. Рейтинг перераховано.' : 'Рішення збережено на сервері. Рейтинг перераховано.');
    } catch (e) { if ($('modal-error')) $('modal-error').textContent = e.message; else toast(e.message); }
    finally { setBusy(false); }
  }
  async function restore(type, authorId, postId) {
    if (busy) return;
    try {
      const next = M.decision(state, { type, authorId, postId, periodKey: period().key }, new Date().toISOString());
      setBusy(true); await saveState(next); render(); toast('Рішення скасовано. Внесок повернуто до розрахунку.');
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  function showCreator(authorId) {
    const v = M.creatorView(dataset, state, authorId, period()); modalContext = { authorId };
    const labels = { banned: 'Участь призупинена', excluded: 'Внесок не зараховано', review: 'Показники потребують перевірки', 'no-posts': 'Немає завантажених постів', active: 'Ваш внесок враховується' };
    modal('Перегляд для @' + v.author.handle, '<div class="callout">Це приватне прев’ю. Захищене зовнішнє посилання ще не створене.</div><h3>' + labels[v.status] + '</h3><p class="muted">' + dateText(v.period.start) + ' — ' + dateText(new Date(new Date(v.period.endExclusive + 'T00:00:00Z').getTime() - 86400000).toISOString()) + '</p>' + (v.decision ? '<div class="reason"><strong>Причина рішення</strong><p>' + esc(v.decision.reason) + '</p></div>' : '') + '<p>Враховано постів: ' + v.includedPosts + '</p>' + v.excludedPosts.map(p => '<div class="reason"><a class="evidence-link" href="' + esc(safeUrl(p.url)) + '" target="_blank" rel="noopener noreferrer">Пост від ' + dateText(p.date) + ' ↗</a><p>' + esc(p.reason) + '</p></div>').join(''), '<button class="action-button ghost" data-action="close-modal">Закрити</button><button class="action-button primary" data-action="export-creator" data-author="' + esc(authorId) + '">Зберегти авторський статус</button>');
  }
  function renderAudience() {
    const accounts = M.reviewAccounts(dataset, state.accountReviews);
    if (!accounts.length) { $('audience-content').innerHTML = '<div class="empty-state"><h3>Акаунти аудиторії ще не завантажені</h3><p>Smart followers та smart engagement залишаються неоціненими. Імпорт може містити акаунти, підтверджені зв’язки підписки та взаємодії. Ручна оцінка акаунта без цих зв’язків не додає автору smart-балів.</p></div>'; return; }
    $('audience-content').innerHTML = accounts.map(a => {
      const r = S.assessAccount(a), passed = r.status === 'assessed';
      return '<article class="account-card"><div><h3>@' + esc(a.handle || a.id) + '</h3><span class="muted small">ID: ' + esc(a.id) + '</span></div><span class="badge ' + (passed ? r.trust === 0 ? 'warning' : 'success' : 'muted') + '">' + (passed ? 'Вага довіри ' + num(r.trust) : 'Не оцінено') + '</span><p>' + esc(r.reason || 'Немає збереженого висновку.') + '</p><div>' + r.evidence.map(e => '<a class="evidence-link" href="' + esc(safeUrl(e.url)) + '" target="_blank" rel="noopener noreferrer">Доказ ↗</a>').join(' ') + '</div><button class="action-button" data-action="edit-account" data-account="' + esc(a.id) + '">Переглянути оцінку</button></article>';
    }).join('');
  }
  function editAccount(id) {
    const existing = M.reviewAccounts(dataset, state.accountReviews).find(a => a.id === id);
    modalContext = { accountId: existing?.id || null };
    modal(existing ? 'Оцінка акаунта' : 'Додати оцінку акаунта', '<p class="muted">Це редакційна оцінка довіри, не гарантія визначення людини або бота. Оцінка не банить автора.</p><div class="form-grid"><label class="field"><span class="form-label">X User ID *</span><input class="form-input" id="account-id" value="' + esc(existing?.id || '') + '"' + (existing ? ' readonly' : '') + '></label><label class="field"><span class="form-label">Нік</span><input class="form-input" id="account-handle" value="' + esc(existing?.handle || '') + '"></label><label class="field full-width"><span class="form-label">Вага довіри</span><select class="form-select" id="account-trust"><option value="">Не оцінено</option><option value="1">1 — достатні позитивні ознаки</option><option value="0.5">0,5 — обмежені ознаки після перевірки</option><option value="0">0 — підтверджена маніпуляція</option></select></label><label class="field full-width"><span class="form-label">Пояснення оцінки *</span><textarea class="form-textarea" id="account-reason" rows="3">' + esc(existing?.reason || '') + '</textarea></label><label class="field full-width"><span class="form-label">Посилання на докази, по одному в рядку *</span><textarea class="form-textarea" id="account-evidence" rows="3">' + esc((existing?.evidence || []).map(e => e.url).join('\n')) + '</textarea></label></div><p class="form-hint">Для ваги 1 потрібні приклади власного змістовного контенту та контекстних взаємодій з різними авторами. Верифікація або вік акаунта самі не визначають вагу.</p>', '<button class="action-button ghost" data-action="close-modal">Скасувати</button><button class="action-button primary" data-action="save-account">Зберегти оцінку</button>');
    $('account-trust').value = existing?.trust === null || existing?.trust === undefined ? '' : String(existing.trust);
  }
  async function saveAccount() {
    if (busy) return;
    try {
      const id = $('account-id').value.trim(); if (!M.safeId(id)) throw new Error('Вкажіть коректний ID акаунта.');
      const trust = $('account-trust').value === '' ? null : Number($('account-trust').value);
      const record = { id, handle: $('account-handle').value.trim().replace(/^@/, ''), trust, reason: $('account-reason').value.trim(), evidence: $('account-evidence').value.split('\n').map(s => s.trim()).filter(Boolean).map(url => ({ url, note: '' })), reviewedAt: new Date().toISOString() };
      const checked = S.assessAccount(record); if (checked.status === 'invalid') throw new Error('Для числової ваги потрібні причина та хоча б одне коректне HTTP(S)-посилання на доказ.');
      const next = structuredClone(state); next.accountReviews[id] = record;
      next.audit.unshift({ id: 'review:' + Date.now(), type: 'account-review', accountId: id, at: record.reviewedAt, reason: record.reason });
      next.audit = next.audit.slice(0, 1000);
      setBusy(true); await saveState(next); closeModal(); render(); toast('Оцінку довіри збережено. Залежні smart-метрики перераховано.');
    } catch (e) { if ($('modal-error')) $('modal-error').textContent = e.message; else toast(e.message); }
    finally { setBusy(false); }
  }
  function renderMethod() {
    $('method-content').innerHTML = '<div class="callout">Версія ' + S.ALGORITHM_VERSION + '. Це власна адаптація наданого опису Zama, а не підтверджене відтворення її внутрішньої методики.</div><section class="method-section"><h2>Складові Score</h2><table class="method-table"><tbody><tr><th>Аудиторія</th><td>500 × min(log₁₀(smart followers + 1), 3)</td></tr><tr><th>Охоплення</th><td>10 × √показів</td></tr><tr><th>Реакції</th><td>Лайки + 3 × репости + (4…6) × цитування; обмеження залучення 1…5% за масштабом охоплення</td></tr><tr><th>Smart-внесок</th><td>150 × min(smart engagement, 0,5 × EffEng), разом із множником SRM¹·⁵</td></tr><tr><th>Регулярність</th><td>1 + 0,02 × min(кількість постів, 20), максимум +40%</td></tr><tr><th>ER</th><td>Множник 0,90…1,00. За ER >10% і показів <50 000 додатково ×0,30</td></tr><tr><th>Участь</th><td>Від 2 врахованих робіт, покази >0; календарний місяць UTC</td></tr></tbody></table></section><section class="method-section"><h2>Власні smart-метрики</h2><p>Вага довіри: 1, 0,5 або 0 з причиною та доказами. Неперевірений акаунт має стан «не оцінено».</p><p>Smart followers — сума ваг підтверджених підписників. Smart engagement — сума ваг унікальних зовнішніх акаунтів зі змістовним цитуванням або відповіддю на враховані роботи за період. Максимум один внесок акаунта на автора за період; власні взаємодії виключаються.</p><p>До рейтингу входять оригінальні твіти й цитування. Реплаї, зокрема відповіді у власних тредах, і звичайні репости не враховуються. Без відмітки потрібне підтвердження зв’язку з нашим Entropy: офіційне посилання, цитування або специфічний контекст продукту. Неоднозначні збіги очікують рішення в розділі «Перевірка згадок». Придатні пости з однаковим workId залишаються однією роботою для допуску й бонусу регулярності. Якщо джерело не передало тип або групування, потрібна ручна перевірка.</p><p>Лайки й прості репости впливають на ENG. Отримані відповіді на враховані твіти можуть входити до власної smart-складової Entropy. Самі по собі повтори, GM та емодзі не створюють smart-внеску.</p></section><section class="method-section"><h2>Явні інтерпретації формули</h2><ul><li>ER всередині розрахунку — частка; ER% ділиться на 100 перед множенням на покази.</li><li>ENG_raw = ENG; QE використовує натуральний логарифм.</li><li>За нульового EngObs значення Clamp = 1.</li><li>ER >20% створює стан «На перевірці», без автоматичної дискваліфікації чи бану.</li><li>Невідомі дані не стають нулями. Нижня відома smart-сума може визначити точну складову лише після досягнення її математичної стелі.</li><li>CPM $30 та score¹·²⁵ стосуються винагород і не включені в цей відбір.</li></ul></section><section class="method-section"><h2>Пояснення для кріейтора</h2><p>Публічна причина рішення й виключені пости відображаються в окремому прев’ю. Внутрішні нотатки команди туди не потрапляють. Прев’ю не є зовнішньою захищеною сторінкою.</p></section>';
  }
  function renderSettings() {
    if (backend.status !== 'local') {
      const sync = backend.sync || {}, configured = backend.connection.configured, connected = backend.status === 'connected';
      const collecting = sync.enabled && !sync.paused;
      const errors = { AUTH_REQUIRED: 'Ключ провайдера потребує перевірки.', CREDITS_EXHAUSTED: 'Баланс провайдера вичерпано.', RATE_LIMITED: 'Досягнуто ліміту швидкості провайдера; заплановано повторну спробу.', DAILY_LIMIT: 'Досягнуто денного ліміту запитів.', SYNC_FAILED: 'Збір не завершився. Попередні дані збережено.', COLLECTOR_ERROR: 'Збір не завершився. Попередні дані збережено.' };
      const errorText = sync.lastError ? errors[sync.lastError.code] || 'Останнє оновлення не завершилося. Попередні дані збережено.' : null;
      const pending = Array.isArray(sync.hourly?.pendingWindows) ? sync.hourly.pendingWindows : sync.discovery?.pendingWindows || [], refreshIds = sync.refresh?.pendingIds || [], gaps = sync.gaps || [];
      const budget = sync.attemptBudget || {};
      const controlsHtml = '<div class="detail-actions"><button class="action-button primary" data-action="' + (collecting ? 'collector-pause' : 'collector-enable') + '"' + (!configured || !connected ? ' disabled' : '') + '>' + (collecting ? 'Призупинити збір' : 'Увімкнути збір') + '</button><button class="action-button" data-action="sync-now"' + (!configured || !connected || !collecting ? ' disabled' : '') + '>Оновити зараз</button></div>';
      $('settings-content').innerHTML = '<div class="settings-grid"><section class="settings-block"><h2>Джерело даних</h2><span class="badge ' + (connected && configured && collecting && !sync.lastError ? 'success' : 'warning') + '">' + esc(sourceStatus()) + '</span><p>' + dataset.authors.length + ' авторів · ' + dataset.posts.length + ' постів. Знімок ' + dateText(dataset.meta.asOf) + '.</p><p class="muted">Покриття часткове. Невідомі або недоступні дані не перетворюються на нулі. Ручні рішення зберігаються за ID.</p><p class="muted small">' + esc(dataset.meta.identityNote || '') + '</p><button class="action-button" data-action="import">Імпортувати дані</button>' + (!connected ? '<button class="action-button ghost" data-action="server-retry">Повторити підключення</button>' : '') + '</section><section class="settings-block"><h2>Збереження</h2><p>Дані й рішення зберігаються на сервері. У цьому браузері залишаються лише налаштування перегляду.</p><p class="muted">Резервна копія містить внутрішні нотатки. API-ключі до неї не входять. Експорт авторського статусу містить лише призначену автору інформацію.</p><button class="action-button" data-action="export">Зберегти копію</button></section><section class="settings-block"><h2>Підключення X</h2><span class="badge ' + (configured ? 'success' : 'muted') + '">' + (configured ? 'Секрет сервера налаштовано' : 'Ключ ще не налаштовано') + '</span><p>Відстежуваний акаунт: <a href="https://x.com/entropyIO" target="_blank" rel="noopener noreferrer">@entropyIO ↗</a>. Пошук охоплює відмітки, офіційні посилання й згадки Entropy без відмітки. Неоднозначні пости очікують ручної перевірки.</p><p class="muted small">Ключ налаштовується як секрет сервера TWITTERAPI_IO_KEY. Він не повертається браузеру й не зберігається у файлах експорту.</p>' + controlsHtml + '<p>Остання спроба: ' + timeText(sync.lastAttemptAt) + '<br>Останній успішний запит: ' + timeText(sync.lastSuccessAt) + '<br>Останні отримані дані: ' + timeText(sync.lastDataAt) + '<br>Наступна дозволена спроба: ' + timeText(sync.nextRunAt) + '</p>' + (errorText ? '<p class="callout">' + esc(errorText) + '</p>' : '') + '<p class="muted">Закриття сторінки не змінює серверний розклад збору. Перегляди — накопичений лічильник; органічність та smart-оцінки потребують окремої перевірки.</p></section><section class="settings-block"><h2>Хід збору</h2>' + hourlyProgress(sync) + backfillProgress(sync) + '<h3>Черги та ліміти</h3><p>Незавершених часових вікон: ' + num(pending.length) + '<br>Постів у черзі оновлення метрик: ' + num(sync.metricsRefresh?.pendingCount ?? refreshIds.length) + '<br>Зафіксованих пропусків: ' + num(gaps.length) + '</p>' + (pending.length ? '<p class="muted small">Найближче вікно: ' + timeText(pending[0].start) + ' — ' + timeText(pending[0].endExclusive) + '.</p>' : '') + '<p class="muted small">Використано спроб за добу UTC: ' + num(budget.count ?? null) + ' із ' + num(budget.limit ?? null) + '. Ліміт запитів не є лімітом витрат у доларах.</p><p class="muted">Бан, незарахування й оцінки довіри залишаються рішеннями модератора. Помилка API не скасовує їх автоматично.</p><span class="badge muted">' + (backend.mode === 'cloud' ? 'Хмарна версія' : 'Серверний перегляд') + '</span></section></div>';
      return;
    }
    $('settings-content').innerHTML = '<div class="settings-grid"><section class="settings-block"><h2>Джерело даних</h2><span class="badge warning">X не підключено</span><p>' + dataset.authors.length + ' авторів · ' + dataset.posts.length + ' постів. Знімок ' + dateText(dataset.meta.asOf) + '.</p><p class="muted">Повнота: ' + (dataset.meta.coverage === 'complete' ? 'заявлена джерелом як повна' : 'часткова або невідома') + '. Фонове сканування відсутнє. Дані можна оновити імпортом; ручні рішення зберігаються за ID.</p><p class="muted small">' + esc(dataset.meta.identityNote || '') + '</p><button class="action-button" data-action="import">Імпортувати дані</button></section><section class="settings-block"><h2>Збереження</h2><p>Дані та рішення зберігаються в цьому браузері. Очищення даних браузера видалить локальну копію.</p><p class="muted">Резервна копія містить внутрішні нотатки. Експорт авторського статусу містить лише призначену автору інформацію.</p><button class="action-button" data-action="export">Зберегти копію</button></section><section class="settings-block"><h2>Підключення X</h2><span class="badge muted">Обрано twitterapi.io</span><p>Відстежуваний акаунт: <a href="https://x.com/entropyIO" target="_blank" rel="noopener noreferrer">@entropyIO ↗</a>. Пошук охоплює відмітки, офіційні посилання й згадки Entropy без відмітки. Неоднозначні пости очікують ручної перевірки.</p><p>Адаптер підготовлено для пошуку згадок та оновлення лічильників. Автоматичне оновлення ще не увімкнене; браузер показує останній імпортований знімок.</p><p class="muted">Перегляди — накопичений лічильник, а не підтверджене органічне чи унікальне охоплення. Smart-оцінки потребують окремої перевірки.</p><p class="muted small">Ключ зберігається поза браузером. Цей кабінет його не запитує. Для постійного збору потрібні сервер, ліміт витрат і журнал оновлень.</p></section><section class="settings-block"><h2>Передача проєкту</h2><p>Версія формули, вихідні дані, оцінки довіри та журнал рішень входять до резервної копії. Для спільної роботи команди й доступу кріейторів знадобиться серверна авторизація.</p><span class="badge muted">Локальна версія</span></section></div>';
  }
  function download(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importFile(file) {
    if (!file || busy) return;
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('Максимальний розмір імпорту — 15 МБ.');
      setBusy(true);
      const payload = JSON.parse(await file.text());
      const isBackup = payload.kind === 'entropy-backup' && payload.version === 1;
      const nextData = M.validateDataset(isBackup ? payload.dataset : payload);
      const nextState = isBackup ? M.validateState(payload.state) : M.reconcileImport(dataset, nextData, state);
      const nextPeriod = M.periodFor(nextState.ui.period, nextData);
      nextData.authors.forEach(a => M.aggregateAuthor(nextData, nextState, a, nextPeriod));
      if (backend.status === 'local') { dataset = nextData; state = nextState; selected = null; persist(); render(); }
      else {
        if (backend.status !== 'connected') throw apiError('NETWORK');
        await writeServer('/api/import', { dataset: nextData, ...(isBackup ? { state: nextState } : {}), isBackup });
      }
      toast('Дані імпортовано. Збережені ручні рішення застосовано за ID.');
    } catch (e) { toast('Імпорт не застосовано: ' + (/[А-Яа-яІіЇїЄєҐґ]/.test(e.message) ? e.message : 'Перевірте формат файла та обов’язкові поля.')); }
    finally { $('import-file').value = ''; setBusy(false); }
  }
  async function collectorAction(enabled, immediate) {
    if (busy || backend.status !== 'connected') return;
    try {
      setBusy(true);
      const result = await writeServer(immediate ? '/api/sync' : '/api/collector', immediate ? {} : { enabled });
      toast(immediate ? result.sync.lastError ? 'Оновлення не завершилося. Попередні дані збережено; причину дивіться в налаштуваннях.' : 'Запит оновлення опрацьовано. Поточний стан показано в кабінеті.' : enabled ? 'Збір увімкнено на сервері. Подальші оновлення виконує серверний розклад.' : 'Збір призупинено на сервері.');
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  async function exportCurrent(authorId) {
    if (busy) return;
    try {
      setBusy(true);
      if (backend.status !== 'local') await refreshBackend(true);
      if (authorId) {
        const a = getAuthor(authorId) || (selected && getAuthor(selected));
        if (!a) throw new Error('Автора вже немає у поточній вибірці. Оновіть перегляд.');
        download('entropy-status-' + a.author.handle + '.json', { kind: 'entropy-creator-status', ...M.creatorView(dataset, state, a.author.id, period()) });
      } else {
        download('entropy-backup-' + new Date().toISOString().slice(0, 10) + '.json', { kind: 'entropy-backup', version: 1, algorithmVersion: S.ALGORITHM_VERSION, exportedAt: new Date().toISOString(), dataset, state });
        toast('Резервну копію збережено. Вона містить внутрішні нотатки.');
      }
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  document.addEventListener('click', e => {
    const nav = e.target.closest('[data-view]'); if (nav) { selected = null; authorTrigger = null; state.ui.view = nav.dataset.view; persist(); render(); return; }
    const b = e.target.closest('[data-action]'); if (!b) return;
    const action = b.dataset.action, id = b.dataset.author;
    if (busy && (writeActions.has(action) || ['close-modal', 'export', 'export-creator'].includes(action))) return;
    if (['detecting', 'error'].includes(backend.status) && writeActions.has(action)) { toast('Зачекайте на підключення до сервера.'); return; }
    if (action === 'open-author') openAuthor(id, b);
    else if (action === 'close-detail') closeAuthor();
    else if (action === 'author-post-scope') changeAuthorScope(b.dataset.scope);
    else if (action === 'author-post-more') moreAuthorPosts();
    else if (action === 'moderate-ban') moderate('ban', id);
    else if (action === 'moderate-period') moderate('exclude-period', id);
    else if (action === 'moderate-post') moderate('exclude-post', id, b.dataset.post);
    else if (action === 'save-decision') saveDecision();
    else if (action === 'restore-ban') restore('restore-ban', id);
    else if (action === 'restore-period') restore('restore-period', id);
    else if (action === 'restore-post') restore('restore-post', id, b.dataset.post);
    else if (action === 'approve-relevance' || action === 'reject-relevance') moderateRelevance(action, id, b.dataset.post);
    else if (action === 'restore-relevance') restore('restore-relevance', id, b.dataset.post);
    else if (action === 'repair-post') void repairPost();
    else if (action === 'review-page') { reviewPage = Math.max(0, Number(b.dataset.page) || 0); renderReview(); controls(); }
    else if (action === 'creator-preview') showCreator(id);
    else if (action === 'close-modal') closeModal();
    else if (action === 'add-account') editAccount(null);
    else if (action === 'edit-account') editAccount(b.dataset.account);
    else if (action === 'save-account') saveAccount();
    else if (action === 'import') $('import-file').click();
    else if (action === 'export') void exportCurrent(null);
    else if (action === 'export-creator') void exportCurrent(id);
    else if (action === 'collector-enable') void collectorAction(true, false);
    else if (action === 'collector-pause') void collectorAction(false, false);
    else if (action === 'sync-now') void collectorAction(true, true);
    else if (action === 'server-retry') void refreshBackend(true).catch(e => toast(e.message));
  });
  $('period').addEventListener('change', e => { state.ui.period = e.target.value; selected = null; persist(); render(); });
  $('sort').addEventListener('change', e => { state.ui.sort = e.target.value; persist(); renderBoard(); });
  $('status-filter').addEventListener('change', e => { state.ui.status = e.target.value; persist(); renderBoard(); });
  $('search').addEventListener('input', e => { state.ui.search = e.target.value; persist(); renderBoard(); });
  $('review-search').addEventListener('input', e => { reviewQuery = e.target.value; reviewPage = 0; renderReview(); controls(); });
  $('import-file').addEventListener('change', e => importFile(e.target.files[0]));
  document.addEventListener('keydown', e => {
    if ($('modal-root').hidden) { if (e.key === 'Escape' && selected) { e.preventDefault(); closeAuthor(); } return; }
    if (e.key === 'Escape') { if (!busy) closeModal(); return; }
    if (e.key !== 'Tab') return;
    const items = [...$('modal-root').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')].filter(el => el.getClientRects().length);
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  document.addEventListener('submit', e => e.preventDefault());
  render();
  if (canDetectServer) {
    // Bootstrap must replace the bundled seed even if this tab is hidden or a
    // visitor starts typing before the first read returns. Later reads still
    // respect editing and open creator cards.
    void refreshBackend(true).catch(() => {});
    setInterval(() => { void refreshBackend(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshBackend(); });
  }
})();
