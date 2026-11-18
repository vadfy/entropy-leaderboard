import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEVANCE_POLICY, classifyTweet, classifyStoredPost, validatedRelevance } from './relevance.mjs';

const link = expanded_url => ({ expanded_url });
const tweet = (text, extra = {}) => ({ text, ...extra });

test('Quang untagged post is accepted by its own expanded Entropy referral URL', () => {
  const source = tweet('so finally my fav project announces its discord... search entropy on my bio', {
    entities: { urls: [link('https://pro.entropy.io/?r=quang250802'), link('https://discord.gg/entropyio')] },
  });
  const result = classifyTweet(source);
  assert.equal(result.version, RELEVANCE_POLICY); assert.equal(result.status, 'accepted');
  assert.deepEqual(result.reasonCodes, ['OFFICIAL_DOMAIN']); assert.ok(!result.signals.includes('direct_mention'));
  assert.ok(result.signals.includes('official_domain')); assert.ok(result.signals.includes('community_context'));
});
test('FastLife untagged post retains both own-domain and validated official-quote evidence', () => {
  const source = tweet('Entropy roles: Voices, Council, Genesis. Create something useful for the community.', {
    entities: { urls: [link('https://pro.entropy.io/?r=fastlife')] },
    quoted_tweet: { id: '2122649707138965603', author: { userName: 'entropyIO' }, text: 'Discord upgrade' },
  });
  const result = classifyTweet(source);
  assert.equal(result.status, 'accepted'); assert.deepEqual(result.reasonCodes, ['OFFICIAL_DOMAIN', 'OFFICIAL_QUOTE']);
  assert.equal(classifyTweet(tweet(source.text)).status, 'review');
});
test('only exact own mentions are accepted, with casing and actual mention entities supported', () => {
  for (const source of [tweet('Hello @EnTrOpYiO!'), tweet('', { entities: { user_mentions: [{ screen_name: 'entropyIO' }] } })]) {
    assert.equal(classifyTweet(source).status, 'accepted'); assert.ok(classifyTweet(source).signals.includes('direct_mention'));
  }
  for (const value of ['@entropyIO_fake', '@entropyIO2', 'negentropy', 'user@entropyIO.com', 'https://evil.example/@entropyIO']) assert.notEqual(classifyTweet(tweet(value)).status, 'accepted');
});
test('official root, product and documentation links are parsed as exact HTTPS destinations', () => {
  for (const value of ['https://entropy.io/', 'https://pro.entropy.io/?r=x', 'https://docs.entropy.io/about-entropy/readme', 'https://ENTROPY.IO./path']) {
    assert.equal(classifyTweet(tweet('A useful project', { entities: { urls: [link(value)] } })).status, 'accepted');
  }
  assert.equal(classifyTweet(tweet('Read this (https://entropy.io/features).')).status, 'accepted');
});
test('lookalike hosts, userinfo, redirects, insecure URLs and custom ports are not target anchors', () => {
  for (const value of ['https://entropy.io.evil.example/', 'https://evilentropy.io/', 'https://entropy.io@evil.example/',
    'https://user:password@entropy.io/', 'https://evil.example/?next=https://entropy.io/', 'http://entropy.io/',
    'https://entropy.io:8443/', 'https://еntropy.io/', 'javascript:https://entropy.io/']) {
    const result = classifyTweet(tweet('Entropy', { entities: { urls: [link(value)] } }));
    assert.notEqual(result.status, 'accepted', value); assert.ok(!result.signals.includes('official_domain'), value);
  }
});
test('display links and profile bios cannot override a different actual destination', () => {
  const result = classifyTweet(tweet('Entropy', { author: { description: 'Building https://entropy.io @entropyIO' },
    entities: { urls: [{ expanded_url: 'https://other.example/', display_url: 'entropy.io' }] } }));
  assert.equal(result.status, 'review'); assert.ok(!result.signals.includes('official_domain'));
});
test('canonical links to an official status prove relevance without relying on copied quote text', () => {
  for (const value of ['https://x.com/entropyIO/status/2122649707138965603', 'https://twitter.com/ENTROPYIO/status/123?ref=test',
    'https://www.x.com/entropyio/status/123/photo/1']) {
    assert.deepEqual(classifyTweet(tweet('This is useful', { entities: { urls: [link(value)] } })).reasonCodes, ['OFFICIAL_POST_LINK']);
  }
  for (const value of ['https://x.com/entropyIO_bad/status/123', 'https://x.com/entropyIO/status/nope',
    'https://evil.example/entropyIO/status/123', 'https://x.com/entropyIO/status/123/unrelated']) {
    assert.notEqual(classifyTweet(tweet('This is useful', { entities: { urls: [link(value)] } })).status, 'accepted');
  }
});
test('official quote identity must be first-level, exact and backed by a string post ID', () => {
  const quote = { id: '2122649707138965603', author: { userName: 'EnTrOpYiO' } };
  assert.deepEqual(classifyTweet(tweet('This is useful', { quoted_tweet: quote })).reasonCodes, ['OFFICIAL_QUOTE']);
  for (const invalid of [true, 'entropyIO', { ...quote, id: 2122649707138965603 }, { ...quote, id: null },
    { ...quote, author: { userName: 'entropyIO_fake' } }, { ...quote, author: { name: 'entropyIO' } }]) {
    assert.notEqual(classifyTweet(tweet('This is useful', { quoted_tweet: invalid })).status, 'accepted');
  }
});
test('unofficial quoted content and nested quotes do not establish the author’s target reference', () => {
  const quote = { id: '123', author: { userName: 'someone' }, text: '@entropyIO is great',
    entities: { urls: [link('https://entropy.io/')] }, quoted_tweet: { id: '456', author: { userName: 'entropyIO' } } };
  assert.equal(classifyTweet(tweet('This is useful', { quoted_tweet: quote })).status, 'rejected');
  assert.equal(classifyTweet(tweet('Entropy looks interesting', { quoted_tweet: quote })).status, 'review');
});
test('specific documented trading context accepts untagged Entropy without a URL', () => {
  for (const value of ['Entropy builds pre-IPO perpetual markets on Hyperliquid.', 'Entropy is a HIP-3 market deployer.',
    'I trade private equity perps on Entropy using Hyperliquid.']) assert.equal(classifyTweet(tweet(value)).status, 'accepted', value);
  assert.deepEqual(classifyTweet(tweet('Entropy HIP-3 perpetual markets')).reasonCodes, ['PROJECT_CONTEXT']);
});
test('generic Entropy, crypto, creators and trading statements stay reviewable rather than inflating rank', () => {
  for (const value of ['Entropy', '#Entropy is early', 'EntropyIO is the next big thing', 'I like Entropy trading.',
    'Entropy crypto airdrop', 'Entropy Creator Program is live', 'Entropy Voices and Council', 'Entropy on Hyperliquid']) {
    assert.equal(classifyTweet(tweet(value)).status, 'review', value);
  }
  assert.equal(classifyTweet(tweet('Hyperliquid perpetual markets are growing')).status, 'rejected');
});
test('scientific and randomness contexts do not turn keyword results into project contributions', () => {
  for (const value of ['Shannon entropy is fundamental to information theory.', 'Entropy sources produce random bits for RNGs.']) {
    assert.equal(classifyTweet(tweet(value)).status, 'rejected', value);
    assert.ok(classifyTweet(tweet(value)).reasonCodes.includes('UNRELATED_SCIENCE'));
  }
  assert.equal(classifyTweet(tweet('Entropy combines markets with randomness; product here https://entropy.io/')).status, 'accepted');
});
test('live physics and catalysis search results are excluded from the private candidate queue', () => {
  const sources = [
    tweet('We are fundamentally misreading the room. Biological sensors read the electromagnetic spectrum in a high entropy ocean of energy. The universe is information architecture with deep physics and AI.', { author: { userName: 'JeramieHicks' } }),
    tweet('Dry reforming turns CO2 and CH4 into syngas, but Ni catalysts coke. Applied Catalysis B review: dynamic operation and high-entropy alloys.', { author: { userName: 'drGuara' } }),
  ];
  for (const source of sources) {
    const result = classifyTweet(source);
    assert.equal(result.status, 'rejected', source.author.userName);
    assert.deepEqual(result.reasonCodes, ['UNRELATED_SCIENCE']);
    assert.ok(result.signals.includes('science_context'));
    assert.deepEqual(validatedRelevance(result), result);
  }
  assert.equal(classifyTweet(tweet('Entropy ❄️')).status, 'review');
});
test('science exclusions do not override official product evidence or uncertain brand metaphors', () => {
  assert.equal(classifyTweet(tweet('Entropy takes physics seriously: https://pro.entropy.io/')).status, 'accepted');
  assert.equal(classifyTweet(tweet('Entropy HIP-3 perpetual markets on Hyperliquid are the physics of trading.')).status, 'accepted');
  assert.equal(classifyTweet(tweet('Entropy creators are a catalyst for our community.')).status, 'review');
  assert.equal(classifyTweet(tweet('Entropy is the next catalyst.')).status, 'review');
});
test('documented product context remains usable when the author also discusses scientific concepts', () => {
  const result = classifyTweet(tweet('Entropy pre-IPO perpetual markets on Hyperliquid should explain randomness and Shannon entropy to traders.'));
  assert.equal(result.status, 'accepted'); assert.deepEqual(result.reasonCodes, ['PROJECT_CONTEXT']);
  assert.ok(result.signals.includes('science_context'));
  assert.deepEqual(validatedRelevance(result), result);
});
test('scientific metaphors mixed with generic trading or creator context stay reviewable', () => {
  for (const value of ['Entropy trading makes the randomness of markets easier to navigate.',
    'Entropy creators bring order to randomness in our community.', 'Shannon entropy helps this crypto discussion.']) {
    const result = classifyTweet(tweet(value));
    assert.equal(result.status, 'review', value); assert.deepEqual(result.reasonCodes, ['AMBIGUOUS_ENTROPY']);
    assert.deepEqual(validatedRelevance(result), result);
  }
});
test('other Entropy projects are rejected unless the tweet also independently references the target', () => {
  for (const value of ['https://entropy.xyz/', 'https://www.entropynetwork.io/', 'https://entropy.international/', 'https://docs.pyth.network/entropy']) {
    const result = classifyTweet(tweet('Entropy crypto infrastructure', { entities: { urls: [link(value)] } }));
    assert.equal(result.status, 'rejected', value); assert.deepEqual(result.reasonCodes, ['OTHER_PROJECT']);
  }
  assert.deepEqual(classifyTweet(tweet('Pyth Entropy generates randomness')).reasonCodes, ['OTHER_PROJECT']);
  assert.equal(classifyTweet(tweet('Comparing Entropy products', { entities: { urls: [link('https://entropy.xyz'), link('https://entropy.io')] } })).status, 'accepted');
});
test('mixed specific target context and another Entropy project need review without an official target anchor', () => {
  const source = tweet('Comparing Entropy HIP-3 perpetual markets on Hyperliquid with other platforms.', {
    entities: { urls: [link('https://entropy.xyz/')] },
  });
  const result = classifyTweet(source);
  assert.equal(result.status, 'review'); assert.deepEqual(result.reasonCodes, ['CONFLICTING_CONTEXT']);
  assert.deepEqual(validatedRelevance(result), result);
  source.entities.urls.push(link('https://entropy.io/'));
  assert.equal(classifyTweet(source).status, 'accepted');
});
test('author bio, user name, search description and media text cannot silently identify the project', () => {
  const result = classifyTweet({ text: 'Good morning', author: { userName: 'entropyIO', description: '@entropyIO https://entropy.io' },
    query: '@entropyIO', summary: 'Entropy Hyperliquid markets', altText: '@entropyIO' });
  assert.equal(result.status, 'rejected'); assert.deepEqual(result.signals, []);
});
test('reply and repost flags remain separate from relevance and cannot be approved through this classifier', () => {
  const original = classifyTweet(tweet('@entropyIO useful thread'));
  assert.deepEqual(classifyTweet(tweet('@entropyIO useful thread', { isReply: true, inReplyToId: '123' })), original);
  assert.deepEqual(classifyTweet(tweet('@entropyIO useful thread', { isRetweet: true })), original);
});
test('malformed and missing provider fields fail closed without throwing', () => {
  for (const value of [undefined, null, false, [], '', { text: {} }, { text: 'Hello', entities: { urls: [null, false, {}], user_mentions: [null] }, quoted_tweet: [] }]) {
    assert.equal(classifyTweet(value).status, 'rejected');
  }
});
test('persisted evidence must use known policy, signals, codes and a supported decision', () => {
  const accepted = classifyTweet(tweet('', { entities: { urls: [link('https://pro.entropy.io/?r=creator')] } }));
  assert.deepEqual(validatedRelevance(accepted), accepted);
  for (const invalid of [{ ...accepted, version: 'future-unknown' }, { ...accepted, signals: [] }, { ...accepted, signals: ['magic_trust'] },
    { ...accepted, status: 'rejected' }, { ...accepted, reasonCodes: ['MANUAL_APPROVAL'] },
    { ...accepted, signals: ['official_domain', 'official_domain'] }, { ...accepted, reasonCodes: ['OFFICIAL_DOMAIN', 'OFFICIAL_DOMAIN'] }]) {
    assert.equal(validatedRelevance(invalid), null);
  }
});
test('a legacy own body can establish relevance while positive retained quote/link evidence survives missing raw objects', () => {
  const accepted = classifyTweet(tweet('Great news', { quoted_tweet: { id: '123', author: { userName: 'entropyIO' } } }));
  assert.equal(classifyStoredPost({ body: '@entropyIO update' }).status, 'accepted');
  assert.deepEqual(classifyStoredPost({ body: 'Great news', relevance: accepted }), accepted);
  assert.deepEqual(classifyStoredPost({ body: null, relevance: accepted }), accepted);
  assert.equal(classifyStoredPost({ body: 'Entropy is interesting', relevance: { ...accepted, version: 'unknown' } }).status, 'review');
  const review = classifyTweet(tweet('Entropy looks interesting'));
  assert.deepEqual(classifyStoredPost({ body: null, relevance: review }), review);
  assert.equal(classifyStoredPost({ summary: 'Entropy Hyperliquid trading' }).status, 'rejected');
});
test('classification does not mutate source objects or return mutable shared evidence arrays', () => {
  const source = tweet('@entropyIO update', { entities: { urls: [link('https://entropy.io')] } });
  const before = structuredClone(source), result = classifyTweet(source);
  result.signals.push('not_retained'); result.reasonCodes.length = 0;
  assert.deepEqual(source, before);
  assert.ok(!classifyTweet(source).signals.includes('not_retained'));
});
