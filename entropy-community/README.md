# Entropy community leaderboard

An anonymous, read-only community view for @entropyIO. This is a separate Site and database from the owner-private contributor workbench. Authentication and personal moderation details are deferred.

The private workbench discovers mentions hourly in cloud jobs. After each successful data or moderation commit it sends an allowlisted projection to this Site. The browser only reads that projection and checks for changes every minute. Closing the page does not stop collection.

## Public data

Only permitted calendar-month rows, creator names and handles, scalar eligible scores, public counters and counted posts are mirrored. Reply posts (including self-replies and thread continuations) and plain reposts are excluded on the private server before projection; original tweets and top-level quote tweets remain eligible. Comments received by those eligible tweets remain visible as a counter. Unknown counters remain null. Bans, period exclusions and individual post exclusions are applied before publishing; their reasons, internal notes, audit history, identity evidence, private scoring implementation and provider credentials never cross this boundary. Historical coverage remains partial and is labelled as such.

Untagged posts may qualify through exact official Entropy links, a quote of the official account, or distinctive verified product context. Ambiguous Entropy name matches remain in the private review queue until approved. A saved rejection overrides later automatic matches; reply/repost exclusions still apply to approvals. Neither candidate bodies nor relevance evidence, review decisions or their reasons are included in the public snapshot.

`GET /api/leaderboard` returns the published snapshot. `POST /internal/snapshot` accepts updates only with the server-side `COMMUNITY_SYNC_SECRET` bearer credential. That secret belongs in Sites runtime secrets and is never in browser assets or repository files. The public Site does not need a Twitter API credential or access to the private workbench.

Snapshots are staged in D1 chunks and published by a monotonic source-revision pointer. A reader sees one complete generation. Older revisions cannot replace newer revisions. Migration-owned tables are created through the generated Drizzle migration at deployment, never by a web request.

## Development

Use Node 22.13 or later. `pnpm install` installs schema-generation tools; the Worker and browser runtime have no package dependencies.

```sh
pnpm test
pnpm build
pnpm validate
```

Edit browser files under `public/` and server code in `worker/index.js`. The deterministic build embeds the three public files into `dist/server/index.js`; the private model and score code are not bundled. Update `db/schema.ts` and run `pnpm db:generate` for schema changes. Commit generated SQL and metadata; applied migration history is immutable.

Keep the separate administrative Site owner-private. Public sharing applies only to this community Site.
