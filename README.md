# Entropy Contributors

Source snapshot of the @entropyIO contributor leaderboard: an owner-private moderation workbench, an anonymous read-only community leaderboard, and their shared collection/scoring modules. This repository contains application code, tests and database schemas. Production databases, moderation records, credentials and Git histories are not included.

## Project layout

| Directory | Purpose |
| --- | --- |
| `entropy-app/` | Canonical shared model, scoring, twitterapi.io adapter, collection engines, admin UI and regression tests. Also contains the earlier local development server. |
| `entropy-cloud/` | Owner-private hosted workbench with persistent D1 storage, moderation, ingestion, public projection and schema migrations. |
| `entropy-community/` | Separate public read-only Site and D1 database. Receives only an allowlisted projection from the private workbench. |
| `entropy-vercel/` | Public Vercel frontend with a fixed proxy to the existing public Site; no database, collection scheduler or private credentials. |

`entropy-cloud/scripts/sync-source.mjs` copies shared source and UI from the adjacent `entropy-app/` directory during builds. Its generated `public/`, `source/`, `lib/entropy-engine.mjs` and `lib/entropy-html.ts` copies are retained so the current hosted source can also build independently. Edit the shared implementation in `entropy-app/` first.

## Current behavior

The leaderboard defaults to counted-post impressions, with likes, comments, reposts, quotes, Engagement % and Score. Creator views show collected posts; moderation can exclude individual posts, exclude an author for a calendar month, ban an author and restore decisions with an audit trail. UTC calendar months are used. Engagement % is `100 × (likes + reposts + quotes) / impressions` over counted posts; comments are shown separately. Unknown observations remain unknown. Replies and plain reposts do not count as creator posts; relevant quote posts can count. Post-type evidence is checked after retrieval as well as through search filters and cannot be erased by a partial refresh or replacement import.

The full Entropy Score is adapted from the supplied Zama v0.1 model and requires complete inputs, including smart-audience and smart-engagement evidence. Missing inputs display an explicit unavailable/pending state rather than a fabricated zero. Kaito is not connected. Personal creator authentication is deferred. The public viewer exposes counted posts and public metrics, without bans, exclusion reasons, internal notes, private trust evidence, scoring implementation or administration controls.

## Entropy discovery and review

The current discovery policy is `entropy-context-v1`, with three independent search lanes:

| Lane | Search scope |
| --- | --- |
| `direct` | Explicit `@entropyIO` mentions. |
| `evidence` | Links to `entropy.io` or official `@entropyIO` post URLs. |
| `context` | The name “Entropy”, followed by project-relevance checks. |

`entropy-app/relevance.mjs` checks each post's own public evidence. Direct mentions establish relevance. Posts without a tag can qualify through official-domain links, official-post links or quote metadata identifying `@entropyIO`. Name-only posts require product context together with Hyperliquid or HIP-3 context for automatic acceptance. Without a stronger project anchor, recognized other-project and unrelated scientific references are rejected; ambiguous or conflicting matches remain in a private review queue and contribute nothing until a moderator approves them. Decisions require a reason, are stored by exact Post ID and survive collection refreshes. Relevance approval never overrides reply/repost exclusion.

Each lane retains its own cursor, time window, error and progress. Every hourly cycle first checks the newest window of each due lane, then advances only fresh-window pages within the cycle limit. Separate maintenance advances older pending pages and revisits recent days for delayed indexing. Historical backfills are separate, bounded jobs. Cursor completion is not a claim that the provider returned every X post: known gaps and anomalies remain visible, and historical coverage stays partial.

The private workbench accepts a post's X URL/ID for explicit repair, submitting exact IDs to `/api/repair` (or a bounded service request with `action: "repair"`). This performs a provider lookup, applies the same identity, relevance and post-type checks, and preserves moderation. It is not triggered by ordinary page reads.

Provider counters do not establish organic reach or unique audience. Posts can have different metric-refresh timestamps; a partial response preserves previous known counts and their observation times.

## Runtime secrets and storage

Configure values in the hosting platform's protected runtime settings, never in repository files or browser assets:

| Project | Setting |
| --- | --- |
| Private workbench | `TWITTERAPI_IO_KEY` — secret provider credential |
| Private workbench and community Site | `COMMUNITY_SYNC_SECRET` — shared server-to-server publishing secret |
| Private workbench | `COMMUNITY_VIEWER_URL` — public viewer origin |
| Private workbench and community Site | `DB` — separate D1 bindings provisioned by hosting |

The public viewer has no twitterapi.io credential or private-Site access token. The private workbench sends an allowlisted snapshot after successful data/moderation commits; viewer failures do not undo those commits.

Keep the administrative Site owner-private. Internal sync routes rely on that hosting access boundary and must not be exposed as a public deployment. Only the separate community Site is public. The committed `.openai/hosting.json` files retain the identifiers of the current Sites; provision/rebind identifiers deliberately before deploying a separate installation.

D1 schema declarations and generated schema-only Drizzle migrations are included in each hosted project. Apply them through the hosting migration workflow; deployment applies pending migrations before uploading the Worker. Local preview databases and production databases are separate. Applied migration history is immutable.

## Hourly collection

Collection runs in two external cloud schedules attached to the private Site, using Europe/Warsaw time. At minute 35, `entropy_sync` or `POST /internal/sync` with `{}` runs the same server cycle: first pages for all three due discovery lanes, followed by fresh pagination, bounded to nine provider requests and approximately 100 seconds. At minute 45, separate maintenance can advance up to six pending pages and refresh one metrics batch after a recent successful discovery. Historical work and metrics never replace the fresh-lane first pages. Both schedules work with the browser closed; paused or disabled collection is not automatically re-enabled.

The administrator can inspect `sync.hourly.lanes[lane].latestSuccessAt`, `latestError` and `latestNextRunAt`, plus `sync.collectionHealth.lanes` and `allLanesCurrent`. The saved `sync.hourly.cycle` receipt records its ID, start/end, request count, per-lane outcomes and whether fresh pagination remains. A current first page does not prove complete pagination. The receipt's `mcp`/`service` source identifies the call transport; scheduler execution history is needed to establish automatic execution. The public snapshot's existing `lastDiscoveryAt` remains the direct-lane timestamp, not an all-lane freshness guarantee.

After a successful first-page check, the lane's next eligible run is aligned to the next minute-35 boundary, including after a manual check. Provider errors and cooldowns retain their retry deadlines. This is server eligibility, not a guarantee that an external schedule runs at the exact second.

The shared limit is 288 provider attempts per UTC day, including failures. Historical work, metrics, repair and older catch-up retain a fixed cutoff at 216 total attempts. Only fresh pagination may use a dynamic higher cutoff: it preserves three first-page attempts for each future minute-35 slot before the next UTC midnight, up to 72 reserved attempts. The status exposes this as `collectionHealth.freshPaginationReserve` and `freshPaginationDailyLimit` (`288 - reserve`); these are cutoffs on the shared attempt counter, not additional allowances. A nine-request cycle is a maximum, not an hourly spending commitment.

These are hosting-platform schedules; copying this repository to GitHub or deploying the Vercel frontend does not create or migrate them. See `entropy-cloud/OPERATIONS.md` for the service protocol, leases and limits.

## Public Vercel frontend

The public leaderboard is available at [entropy-leaderboard.vercel.app](https://entropy-leaderboard.vercel.app). `entropy-vercel/` serves the reviewed public UI and proxies only `/api/leaderboard` to the fixed existing public endpoint, `https://entropyio-leaderboard.vadfy.chatgpt.site/api/leaderboard`. It has no environment-variable, database or cron setup. Private collection, moderation, storage and publication remain in the existing cloud services.

The initial Vercel deployment used a folder upload because the GitHub connection was unavailable. Source auto-deployment from GitHub is not configured; publishing a new GitHub commit alone does not update the deployed frontend. Data updates remain automatic through the existing public snapshot and frontend polling. The Vercel folder uses Node.js 24.x; run `npm test` and `npm run build` there without installing dependencies. See `entropy-vercel/README.md` for a future GitHub import.

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
