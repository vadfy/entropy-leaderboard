// Server-only, read-only adapter. Never import this module into the browser bundle.
import { classifyTweet } from './relevance.mjs';
// Reference: https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search
// Reference: https://docs.twitterapi.io/api-reference/endpoint/get_tweet_by_ids
// Reference: https://docs.twitterapi.io/api-reference/endpoint/get_user_mention
const ORIGIN = 'https://api.twitterapi.io';
const numericId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

export class TwitterApiError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'TwitterApiError';
    this.code = code;
    this.status = status;
  }
}
function invalid(message) { throw new TwitterApiError('INVALID_INPUT', message); }
function responseError(message) { throw new TwitterApiError('INVALID_RESPONSE', message); }

export function createClient({ apiKey, fetchImpl, timeoutMs = 30000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) invalid('Потрібен серверний ключ twitterapi.io.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 65000) invalid('Таймаут запиту має бути від 1 до 65000 мс.');
  const request = fetchImpl === undefined ? (url, init) => globalThis.fetch(url, init) : fetchImpl;
  if (typeof request !== 'function') invalid('Недоступний HTTP-клієнт.');
  const secret = apiKey.trim();
  async function get(route, params) {
    const url = new URL(route, ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response;
    try {
      response = await request(url, {
        method: 'GET', headers: { 'x-api-key': secret, Accept: 'application/json' },
        // Workers supports manual/follow only. Manual also keeps the key from
        // being forwarded to an unexpected redirect destination.
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
      throw new TwitterApiError(code, 'Запит twitterapi.io не завершився. Дані не оновлено.');
    }
    if (!response || typeof response.ok !== 'boolean') responseError('Некоректна HTTP-відповідь twitterapi.io.');
    if (response.status >= 300 && response.status < 400) throw new TwitterApiError('HTTP_ERROR', 'Перенаправлення twitterapi.io відхилено.', response.status);
    if (!response.ok) {
      const status = Number.isInteger(response.status) ? response.status : null;
      const code = status === 429 ? 'RATE_LIMITED' : status === 402 ? 'CREDITS_EXHAUSTED' : 'HTTP_ERROR';
      throw new TwitterApiError(code, 'twitterapi.io повернув HTTP ' + (status ?? 'помилку') + '. Автоматичних повторів немає.', status);
    }
    let body;
    try { body = await response.json(); }
    catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new TwitterApiError('REQUEST_TIMEOUT', 'Запит twitterapi.io не завершився. Дані не оновлено.');
      responseError('twitterapi.io повернув некоректний JSON.');
    }
    if (!plain(body)) responseError('Некоректний формат відповіді twitterapi.io.');
    if (body.status === 'error' || body.error || (body.status && body.status !== 'success')) {
      throw new TwitterApiError('PROVIDER_ERROR', 'twitterapi.io повідомив про помилку. Дані не оновлено.');
    }
    if (!Array.isArray(body.tweets)) responseError('У відповіді twitterapi.io відсутній список tweets.');
    return body;
  }
  return Object.freeze({
    async searchPage({ query, cursor = '' } = {}) {
      if (typeof query !== 'string' || !query.trim() || [...query].length > 512) invalid('Пошуковий запит має містити 1–512 символів.');
      if (typeof cursor !== 'string' || cursor.length > 20000) invalid('Некоректний курсор пошуку.');
      const body = await get('/twitter/tweet/advanced_search', { query, queryType: 'Latest', cursor });
      if (typeof body.has_next_page !== 'boolean') responseError('У відповіді пошуку відсутня ознака наступної сторінки.');
      if (body.has_next_page && (typeof body.next_cursor !== 'string' || !body.next_cursor || body.next_cursor === cursor)) responseError('Некоректний курсор наступної сторінки.');
      return { tweets: body.tweets, hasNextPage: body.has_next_page, nextCursor: body.has_next_page ? body.next_cursor : null };
    },
    async mentionsPage({ userName, sinceTime, untilTime, cursor = '' } = {}) {
      if (typeof userName !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(userName)) invalid('Потрібне точне ім’я X-акаунта без @.');
      // The endpoint accepts Unix seconds (9–10 digits), not milliseconds.
      if (![sinceTime, untilTime].every(value => Number.isInteger(value) && value >= 100000000 && value <= 9999999999) || untilTime <= sinceTime) invalid('Потрібні коректні впорядковані межі Unix у секундах.');
      if (typeof cursor !== 'string' || cursor.length > 20000) invalid('Некоректний курсор пошуку.');
      const body = await get('/twitter/user/mentions', { userName, sinceTime, untilTime, cursor });
      if (typeof body.has_next_page !== 'boolean') responseError('У відповіді згадок відсутня ознака наступної сторінки.');
      if (body.has_next_page && (typeof body.next_cursor !== 'string' || !body.next_cursor || body.next_cursor === cursor)) responseError('Некоректний курсор наступної сторінки.');
      return { tweets: body.tweets, hasNextPage: body.has_next_page, nextCursor: body.has_next_page ? body.next_cursor : null };
    },
    async tweetsByIds(ids) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some(id => !numericId(id))) invalid('Потрібні 1–50 точних текстових X Post ID.');
      const wanted = [...new Set(ids)];
      const body = await get('/twitter/tweets', { tweet_ids: wanted.join(',') });
      const seen = new Set(), tweets = [];
      let unavailableEntries = 0;
      for (const tweet of body.tweets) {
        if (plain(tweet) && (tweet.id === '' || tweet.id === null)) { unavailableEntries++; continue; }
        if (!plain(tweet) || !numericId(tweet.id) || !wanted.includes(tweet.id) || seen.has(tweet.id)) responseError('Некоректний або повторний ID у відповіді twitterapi.io.');
        seen.add(tweet.id); tweets.push(tweet);
      }
      return { tweets, missingIds: wanted.filter(id => !seen.has(id)), unavailableEntries };
    },
  });
}

function count(value, field) {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid('Некоректний лічильник ' + field + '.');
  return parsed;
}
function day(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('Некоректна дата ' + label + '.');
  const timestamp = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) invalid('Некоректна дата ' + label + '.');
  return value;
}
function instant(value, label) {
  if (typeof value !== 'string' || !value.trim()) invalid('Відсутній час ' + label + '.');
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) day(value.slice(0, 10), label);
  // Explicit timezone prevents a server's local timezone from changing the month.
  if (!/(?:Z|[+-]\d{2}:?\d{2}| GMT| UTC)$/i.test(value.trim()) && !/[+-]\d{4}\s\d{4}$/.test(value.trim())) invalid('Для часу ' + label + ' потрібен часовий пояс.');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalid('Некоректний час ' + label + '.');
  return new Date(timestamp).toISOString();
}
function isRepost(tweet) {
  return tweet.isRetweet === true || plain(tweet.retweeted_tweet) ||
    typeof tweet.retweeted_tweet === 'string' && tweet.retweeted_tweet.length > 0;
}

export function normalizeTweets(tweets, { observedAt, query = '', periodStart, periodEndExclusive } = {}) {
  if (!Array.isArray(tweets) || tweets.length > 100000) invalid('Потрібен обмежений список tweets.');
  const checkedAt = instant(observedAt, 'спостереження');
  if (typeof query !== 'string') invalid('Некоректний опис пошукового запиту.');
  if ((periodStart === undefined) !== (periodEndExclusive === undefined)) invalid('Потрібні обидві межі періоду.');
  if (periodStart !== undefined) {
    day(periodStart, 'початку'); day(periodEndExclusive, 'кінця');
    if (periodStart >= periodEndExclusive) invalid('Кінець періоду має бути пізніше початку.');
  }
  const authors = new Map(), posts = new Map();
  const diagnostics = { inputRows: tweets.length, excludedReposts: 0, duplicates: 0, outsidePeriod: 0 };
  for (let index = 0; index < tweets.length; index++) {
    const tweet = tweets[index];
    if (!plain(tweet)) invalid('Некоректний запис tweets за індексом ' + index + '.');
    if (isRepost(tweet)) { diagnostics.excludedReposts++; continue; }
    if (!numericId(tweet.id)) invalid('У tweets за індексом ' + index + ' потрібен точний текстовий ID.');
    const author = tweet.author;
    if (!plain(author) || !numericId(author.id) || typeof author.userName !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(author.userName)) invalid('Некоректний автор у tweets за індексом ' + index + '.');
    const publishedAt = instant(tweet.createdAt, 'публікації');
    const date = publishedAt.slice(0, 10);
    if (periodStart !== undefined && (date < periodStart || date >= periodEndExclusive)) { diagnostics.outsidePeriod++; continue; }
    if (posts.has(tweet.id)) {
      const old = posts.get(tweet.id);
      if (old.authorId !== author.id || old.publishedAt !== publishedAt) invalid('Суперечливі дублікати X Post ID.');
      diagnostics.duplicates++;
      continue;
    }
    if (tweet.text !== undefined && tweet.text !== null && typeof tweet.text !== 'string') invalid('Некоректний текст поста.');
    const previousAuthor = authors.get(author.id);
    if (previousAuthor && previousAuthor.handle.toLowerCase() !== author.userName.toLowerCase()) invalid('Суперечливі імена одного автора у знімку.');
    const followers = count(author.followers, 'followers');
    authors.set(author.id, { id: author.id, handle: author.userName, displayName: typeof author.name === 'string' ? author.name : author.userName,
      followers: followers ?? previousAuthor?.followers ?? null, smartFollowersComplete: false, smartEngagementComplete: false });
    posts.set(tweet.id, {
      id: tweet.id, authorId: author.id, authorHandle: author.userName, date, publishedAt,
      url: 'https://x.com/' + author.userName + '/status/' + tweet.id,
      summary: '', body: typeof tweet.text === 'string' ? tweet.text : null,
      metrics: { impressions: count(tweet.viewCount, 'viewCount'), likes: count(tweet.likeCount, 'likeCount'),
        reposts: count(tweet.retweetCount, 'retweetCount'), uiReposts: null, quotes: count(tweet.quoteCount, 'quoteCount'),
        replies: count(tweet.replyCount, 'replyCount'), bookmarks: count(tweet.bookmarkCount, 'bookmarkCount') },
      metricsAsOf: checkedAt, metricsWindow: 'cumulative', source: 'twitterapi.io',
      // conversationId is retained as evidence, never used to group other authors' work.
      conversationId: numericId(tweet.conversationId) ? tweet.conversationId : null,
      inReplyToId: numericId(tweet.inReplyToId) ? tweet.inReplyToId : null,
      isReply: typeof tweet.isReply === 'boolean' ? tweet.isReply : null, isQuote: !!tweet.quoted_tweet,
      relevance: classifyTweet(tweet),
    });
  }
  const dates = [...posts.values()].map(post => post.date).sort();
  const derivedStart = dates[0] || checkedAt.slice(0, 10);
  const derivedEnd = new Date(Date.parse((dates.at(-1) || checkedAt.slice(0, 10)) + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  return {
    meta: { source: 'twitterapi.io', asOf: checkedAt, coverage: 'partial', query,
      periodStart: periodStart ?? derivedStart, periodEndExclusive: periodEndExclusive ?? derivedEnd,
      sourceNote: 'Лічильники twitterapi.io на час спостереження; знімок із ручного збору, без фонового оновлення.',
      limitations: ['viewCount — накопичені перегляди поста, не унікальні люди й не підтверджені органічні покази.',
        'Пошук не гарантує повного охоплення всіх публікацій; знімок залишається частковим.',
        'Smart-дані та оцінки довіри не отримані; верифікація акаунта не підставляється як довіра.',
        'Частини тредів потребують перевірки групування; conversationId не є workId.'], diagnostics },
    authors: [...authors.values()], posts: [...posts.values()], accounts: [], followRelations: [], interactions: [],
  };
}
