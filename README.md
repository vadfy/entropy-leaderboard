# Entropy Contributors

Source snapshot of the @entropyIO contributor leaderboard: an owner-private moderation workbench, an anonymous read-only community leaderboard, and their shared collection/scoring modules. This repository contains application code, tests and database schemas. Production databases, moderation records, credentials and Git histories are not included.

## Project layout

| Directory | Purpose |
| --- | --- |
| `entropy-app/` | Canonical shared model, scoring, twitterapi.io adapter, collection engines, admin UI and regression tests. Also contains the earlier local development server. |
| `entropy-cloud/` | Owner-private hosted workbench with persistent D1 storage, moderation, ingestion, public projection and schema migrations. |
| `entropy-community/` | Separate public read-only Site and D1 database. Receives only an allowlisted projection from the private workbench. |

`entropy-cloud/scripts/sync-source.mjs` copies shared source and UI from the adjacent `entropy-app/` directory during builds. Its generated `public/`, `source/`, `lib/entropy-engine.mjs` and `lib/entropy-html.ts` copies are retained so the current hosted source can also build independently. Edit the shared implementation in `entropy-app/` first.

## Current behavior

The leaderboard defaults to counted-post impressions, with likes, comments, reposts, quotes, Engagement % and Score. Creator views show collected posts; moderation can exclude individual posts, exclude an author for a calendar month, ban an author and restore decisions with an audit trail. UTC calendar months are used. Engagement % is `100 × (likes + reposts + quotes) / impressions` over counted posts; comments are shown separately. Unknown observations remain unknown. Replies and plain reposts do not count as creator posts; relevant quote posts can count. Post-type evidence is checked after retrieval as well as through search filters and cannot be erased by a partial refresh or replacement import.

The full Entropy Score is adapted from the supplied Zama v0.1 model and requires complete inputs, including smart-audience and smart-engagement evidence. Missing inputs display an explicit unavailable/pending state rather than a fabricated zero. Kaito is not connected. Personal creator authentication is deferred. Public visitors see counted posts and public metrics, not bans, exclusion reasons, internal notes, private trust evidence, scoring implementation or administration controls.

## Entropy discovery and review

The current discovery policy is `entropy-context-v1`, with three independent search lanes:

| Lane | Search scope |
| --- | --- |
| `direct` | Explicit `@entropyIO` mentions. |
| `evidence` | Links to `entropy.io` or official `@entropyIO` post URLs. |
| `context` | The name “Entropy”, followed by project-relevance checks. |

`entropy-app/relevance.mjs` checks each post's own public evidence. Direct mentions establish relevance. Posts without a tag can qualify through official-domain links, official-post links or quote metadata identifying `@entropyIO`. Name-only posts require product context together with Hyperliquid or HIP-3 context for automatic acceptance. Without a stronger project anchor, recognized other-project and unrelated scientific references are rejected; ambiguous or conflicting matches remain in a private review queue and contribute nothing until a moderator approves them. Decisions require a reason, are stored by exact Post ID and survive collection refreshes. Relevance approval never overrides reply/repost exclusion.

Each lane retains its own cursor, time window, error and progress. New direct mentions have priority; bounded maintenance advances pending pages across all lanes and revisits recent days for delayed indexing. Historical backfills are separate, bounded jobs. Cursor completion is not a claim that the provider returned every X post: known gaps and anomalies remain visible, and historical coverage stays partial.

The private workbench accepts a post's X URL/ID for explicit repair, submitting exact IDs to `/api/repair` (or a bounded service request with `action: "repair"`). This performs a provider lookup, applies the same identity, relevance and post-type checks, and preserves moderation. It is not triggered by ordinary page reads.

Provider counters do not establish organic reach or unique audience. Posts can have different metric-refresh timestamps; a partial response preserves previous known counts and their observation times.

## Runtime secrets and storage

Configure values in the hosting platform's protected runtime settings, never in repository files or browser assets:

| Project | Setting |
| --- | --- |
| Private workbench | `TWITTERAPI_IO_KEY` — secret provider credential |
| Both hosted projects | `COMMUNITY_SYNC_SECRET` — shared server-to-server publishing secret |
| Private workbench | `COMMUNITY_VIEWER_URL` — public viewer origin |
| Both hosted projects | `DB` — separate D1 bindings provisioned by hosting |

The public viewer has no twitterapi.io credential or private-Site access token. The private workbench sends an allowlisted snapshot after successful data/moderation commits; viewer failures do not undo those commits.

Keep the administrative Site owner-private. Internal sync routes rely on that hosting access boundary and must not be exposed as a public deployment. Only the separate community Site is public. The committed `.openai/hosting.json` files retain the identifiers of the current Sites; provision/rebind identifiers deliberately before deploying a separate installation.

D1 schema declarations and generated schema-only Drizzle migrations are included in each hosted project. Apply them through the hosting migration workflow; deployment applies pending migrations before uploading the Worker. Local preview databases and production databases are separate. Applied migration history is immutable.

## Hourly collection

Collection runs in two external cloud schedules attached to the private Site: fresh direct mentions hourly at minute 35, with other discovery lanes queued for maintenance, and bounded catch-up/metric maintenance hourly at minute 45, using Europe/Warsaw time. They work with the browser closed. Paused or disabled collection is not automatically re-enabled. These are hosting-platform schedules; copying this repository to GitHub does not create GitHub Actions or migrate those schedules. Existing collection continues independently of this repository. See `entropy-cloud/OPERATIONS.md` for the service protocol, request budgets, concurrency leases and limits.

## Development and validation

Use Node.js 22.13+ and pnpm 11.25.0. Tests use synthetic provider responses or local fixtures and need no real API credentials. Browser uploads normalize executable file permissions; restore the five shell entrypoints before installation or building. From the repository root:

```sh
chmod +x entropy-cloud/scripts/build-verified.sh \
  entropy-cloud/scripts/install-ci.sh \
  entropy-cloud/scripts/install-pnpm.sh \
  entropy-cloud/scripts/sites-env.sh \
  entropy-community/scripts/build.sh

node --test entropy-app/*.test.mjs

cd entropy-cloud
pnpm install
node --test tests/*.test.mjs
pnpm build

cd ../entropy-community
pnpm install
pnpm test
pnpm build
pnpm validate
```

For the earlier local-only preview, run `node entropy-app/serve.mjs`. For the current hosted app, use the project-specific build and hosting workflow. Do not run a provider collector with production credentials merely to validate a source export.

## Included sample data

`entropy-app/seed.json` and its generated copies contain the original historical research fixture: 24 public posts from nine authors. It is not the live production dataset, a database backup, a complete monthly sample or a record of production moderation. It is retained because development initialization and regression tests depend on it. The local `runtime/` directory and all cloud database contents are excluded. Existing per-project READMEs describe their particular components; the older local prototype's limitations do not describe the current hosted system.
