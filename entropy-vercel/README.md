# Entropy public leaderboard — Vercel frontend

Phase 1 publishes the existing public leaderboard on Vercel. The three files in `public/` are an unchanged copy of `entropy-community/public/`: Ukrainian interface, monthly ranking, metrics/Score, creator search, sorting, author post view and visible-tab polling every 60 seconds. An open author view keeps the new snapshot pending until the view closes.

## Data flow and access

```
Browser → GET /api/leaderboard on Vercel
        → GET https://entropyio-leaderboard.vadfy.chatgpt.site/api/leaderboard
        → existing allowlisted public snapshot in Cloudflare D1

Existing private collector/admin → existing public snapshot publisher
```

The private admin, database, moderation and hourly collection remain in the existing cloud services. Closing the Vercel page does not affect collection. This project contains no database, TwitterAPI credential, scheduler or admin endpoints. Do not add TwitterAPI, private Sites service credentials or `COMMUNITY_SYNC_SECRET` to this Vercel project.

The proxy accepts only GET at one exact path with no query string. It fetches one hardcoded public URL, does not follow redirects, and forwards only a validated Entropy ETag validator. Cookies, authorization, owner identity headers and arbitrary upstream headers are never forwarded. Responses copy only the public content type, validated ETag and upstream cache policy; failures use `no-store` and contain no upstream error details. A missing upstream cache policy becomes `no-store`. A 304 is passed through only for the matching forwarded validator.

Snapshot bytes are streamed with backpressure and without buffering/JSON parsing; this supports responses exceeding Vercel's 4.5 MB nonstreamed response limit. A 10 second total timeout covers headers and the response body. Client cancellation cancels the upstream request. If a body fails after headers were sent, the stream fails and the unchanged UI retains its previous valid snapshot.

## Deploy from GitHub

1. Include `entropy-vercel/` in the repository. Import the repository into Vercel.
2. Set **Root Directory** to **`entropy-vercel`**, not the repository root or `entropy-cloud`. If deploying only this folder as a standalone repository, use its root (`.`).
3. Choose **Other** for Framework Preset, **Node.js 24.x**, Build Command **`npm run build`**, Output Directory **`dist`**. These are also declared in `package.json`/`vercel.json`.
4. No environment variables, integrations, database or cron setup are required. There are no package dependencies.
5. For public anonymous access, ensure Vercel Authentication/Deployment Protection does not restrict the production deployment. Preview protection can remain enabled.
6. Deploy and verify `/`, `/api/leaderboard`, creator search and an author's posts. Confirm POST `/api/leaderboard` returns 405 and `/api/workbench`/`/internal/sync` return 404. Compare API snapshot revision to the existing public cloud endpoint. Verify the next existing hourly collector run updates the revision/freshness shown through Vercel.

Deployment does not create or modify any collection schedule. Keep the existing cloud schedules enabled. Do not duplicate them in Vercel.

## Local checks

Use Node.js 24.x. No install step is needed for local checks:

```
npm test
npm run build
```

Tests use fake upstream responses and make no network/provider calls. They cover rejected methods/paths/query strings, credential/header isolation, ETag/304, conservative caching, redirects/errors, total timeout, cancellation and a streamed response larger than 4.5 MB. The build copies exactly the three reviewed public assets into `dist`; Vercel separately builds `api/leaderboard.js` as a Node.js Web Handler.

For Vercel-aware local serving, use `vercel dev` after linking the intended project; do not pull private backend environment variables into this project. Updating the shared design later requires copying the reviewed three public UI files here again; this deployment is deliberately self-contained.

## Official runtime references

- [Node.js Web Handlers](https://vercel.com/docs/functions/runtimes/node-js)
- [Function Request/Response API](https://vercel.com/docs/functions/functions-api-reference)
- [Static output and function configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Function limits and streamed responses](https://vercel.com/docs/functions/limitations)
