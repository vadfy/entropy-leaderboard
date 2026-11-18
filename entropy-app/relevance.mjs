// Public-post relevance only. Reply/repost eligibility and manual decisions are
// separate policies; neither follower data nor a provider query match is proof.
export const RELEVANCE_POLICY = 'entropy-context-v1';

export const RELEVANCE_SIGNALS = Object.freeze([
  'direct_mention', 'official_domain', 'official_post_link', 'official_quote',
  'brand_name', 'hyperliquid_context', 'hip3_context', 'product_context',
  'generic_trading_context', 'community_context', 'science_context', 'other_project_context',
]);
export const RELEVANCE_REASON_CODES = Object.freeze([
  'DIRECT_MENTION', 'OFFICIAL_DOMAIN', 'OFFICIAL_POST_LINK', 'OFFICIAL_QUOTE',
  'PROJECT_CONTEXT', 'AMBIGUOUS_ENTROPY', 'CONFLICTING_CONTEXT', 'UNRELATED_SCIENCE', 'OTHER_PROJECT', 'NO_PROJECT_EVIDENCE',
]);

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const numericId = value => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value);
const exactHandle = value => typeof value === 'string' && value.toLowerCase() === 'entropyio';
const brand = /(^|[^\p{L}\p{N}_])entropy(?:io)?(?=$|[^\p{L}\p{N}_])/iu;
const mention = /(^|[^A-Za-z0-9_])@entropyIO(?![A-Za-z0-9_])/i;
const urlsInText = /https?:\/\/[^\s<>"']+/giu;
const product = /\b(?:markets?|trad(?:e|es|ing)|perps?|perpetuals?|pre[\s-]?ipo|private\s+(?:equities|equity|markets?|assets?|companies)|equities|order[\s-]?books?)\b/i;
const genericTrading = /\b(?:crypto|defi|trading|trade|trader|perps?|perpetuals?|tokens?|airdrop|funding|staking|leverage|markets?)\b/i;
const community = /\b(?:creators?|community|discord|voices|council|genesis|contributors?|ambassadors?)\b/i;
const scientific = /\b(?:thermodynamics?|thermochemistr(?:y|ical)|shannon|boltzmann|gibbs|physics|electromagnet(?:ic|ism)|information\s+theory|cross[\s-]?entropy|entropy\s+loss|randomness|random\s+(?:numbers?|bits?|seeds?)|rng|heat\s+death|black\s+holes?|dry\s+reforming|synthesis\s+gas|syngas|(?:ni|nickel)\s+catalysts?|applied\s+catalysis|metallurg(?:y|ical)|high[\s-]?entropy\s+alloys?)\b/i;
const otherDomains = ['entropy.xyz', 'entropynetwork.io', 'entropy.international'];

function url(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const result = new URL(value.replace(/[),.;!?\]}]+$/u, ''));
    if (result.protocol !== 'https:' || result.username || result.password || result.port) return null;
    return result;
  } catch { return null; }
}
function host(value) { return value.hostname.toLowerCase().replace(/\.$/, ''); }
const under = (hostname, domain) => hostname === domain || hostname.endsWith('.' + domain);
function ownUrls(tweet) {
  const values = array(tweet.entities?.urls).map(value => plain(value) ? value.expanded_url : null);
  values.push(...(text(tweet.text).match(urlsInText) || []));
  // display_url, author/profile links, nested quote links and redirect query
  // parameters are not independently trusted destinations.
  return values.map(url).filter(Boolean);
}
function resultFor(signals) {
  const values = RELEVANCE_SIGNALS.filter(value => signals.has(value));
  const anchors = [
    ['direct_mention', 'DIRECT_MENTION'], ['official_domain', 'OFFICIAL_DOMAIN'],
    ['official_post_link', 'OFFICIAL_POST_LINK'], ['official_quote', 'OFFICIAL_QUOTE'],
  ].filter(([signal]) => signals.has(signal)).map(([, code]) => code);
  const specificProject = signals.has('brand_name') && signals.has('product_context') &&
    (signals.has('hyperliquid_context') || signals.has('hip3_context'));
  let status, reasonCodes;
  if (anchors.length) { status = 'accepted'; reasonCodes = anchors; }
  else if (specificProject && signals.has('other_project_context')) { status = 'review'; reasonCodes = ['CONFLICTING_CONTEXT']; }
  else if (specificProject) { status = 'accepted'; reasonCodes = ['PROJECT_CONTEXT']; }
  else if (signals.has('other_project_context')) { status = 'rejected'; reasonCodes = ['OTHER_PROJECT']; }
  else if (signals.has('brand_name') && signals.has('science_context') &&
      !signals.has('generic_trading_context') && !signals.has('community_context')) { status = 'rejected'; reasonCodes = ['UNRELATED_SCIENCE']; }
  else if (signals.has('brand_name')) { status = 'review'; reasonCodes = ['AMBIGUOUS_ENTROPY']; }
  else { status = 'rejected'; reasonCodes = ['NO_PROJECT_EVIDENCE']; }
  return { version: RELEVANCE_POLICY, status, reasonCodes, signals: values };
}

/** Classify a raw twitterapi.io tweet using only that post's public evidence. */
export function classifyTweet(raw) {
  const tweet = plain(raw) ? raw : {}, ownText = text(tweet.text), signals = new Set();
  // A handle in a URL path is not an actual mention in the author's prose.
  const prose = ownText.replace(urlsInText, ' ');
  if (mention.test(prose) || array(tweet.entities?.user_mentions).some(value => plain(value) && exactHandle(value.screen_name))) signals.add('direct_mention');
  for (const destination of ownUrls(tweet)) {
    const hostname = host(destination);
    if (under(hostname, 'entropy.io')) signals.add('official_domain');
    if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(hostname) &&
        /^\/entropyio\/status\/[1-9]\d{0,24}(?:\/(?:photo|video)\/\d+)?\/?$/i.test(destination.pathname)) signals.add('official_post_link');
    if (otherDomains.some(domain => under(hostname, domain)) || under(hostname, 'pyth.network') && /^\/entropy(?:\/|$)/i.test(destination.pathname)) signals.add('other_project_context');
    // The exact Discord invite is useful review context, not a verified project
    // anchor. Its identity can be promoted separately after first-party proof.
    if (hostname === 'discord.gg' && /^\/entropyio\/?$/i.test(destination.pathname)) signals.add('community_context');
  }
  const quote = plain(tweet.quoted_tweet) ? tweet.quoted_tweet : null;
  if (quote && numericId(quote.id) && plain(quote.author) && exactHandle(quote.author.userName)) signals.add('official_quote');
  if (brand.test(ownText)) signals.add('brand_name');
  if (/\bhyperliquid\b/i.test(prose)) signals.add('hyperliquid_context');
  if (/\bhip[\s-]?3\b/i.test(prose)) signals.add('hip3_context');
  if (product.test(prose)) signals.add('product_context');
  if (genericTrading.test(prose)) signals.add('generic_trading_context');
  if (community.test(prose)) signals.add('community_context');
  if (scientific.test(prose)) signals.add('science_context');
  if (/\bpyth\s+entropy\b/i.test(prose) || /(^|[^A-Za-z0-9_])@entropydotxyz(?![A-Za-z0-9_])/i.test(prose) ||
      array(tweet.entities?.user_mentions).some(value => plain(value) && typeof value.screen_name === 'string' && value.screen_name.toLowerCase() === 'entropydotxyz')) signals.add('other_project_context');
  return resultFor(signals);
}

/** Validate persisted evidence, without treating an asserted status as proof. */
export function validatedRelevance(value) {
  if (!plain(value) || value.version !== RELEVANCE_POLICY || !['accepted', 'review', 'rejected'].includes(value.status) ||
      !Array.isArray(value.reasonCodes) || !value.reasonCodes.length || value.reasonCodes.length > 4 ||
      !Array.isArray(value.signals) || value.signals.length > RELEVANCE_SIGNALS.length ||
      value.reasonCodes.some(code => !RELEVANCE_REASON_CODES.includes(code)) ||
      value.signals.some(signal => !RELEVANCE_SIGNALS.includes(signal)) ||
      new Set(value.reasonCodes).size !== value.reasonCodes.length || new Set(value.signals).size !== value.signals.length) return null;
  const result = resultFor(new Set(value.signals));
  if (result.status !== value.status || result.reasonCodes.length !== value.reasonCodes.length ||
      result.reasonCodes.some(code => !value.reasonCodes.includes(code))) return null;
  return result;
}

/** Legacy bodies can be checked again; retained URL/quote proof is not erased. */
export function classifyStoredPost(raw) {
  const post = plain(raw) ? raw : {};
  const observed = classifyTweet({ text: text(post.body), entities: post.entities, quoted_tweet: post.quoted_tweet });
  const saved = validatedRelevance(post.relevance);
  if (observed.status === 'accepted') return observed;
  if (saved?.status === 'accepted') return saved;
  if (observed.status === 'review') return observed;
  return saved || observed;
}
