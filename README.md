# Crest

A Hacker News feed showing only the stories that crossed a score threshold, newest first. Runs on Cloudflare Workers (free tier): a cron poller writes to D1, a static page reads from a small JSON API.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design rationale.

## Setup & deploy

```bash
# 1. Install dependencies
pnpm install

# 2. Create the D1 database
pnpm exec wrangler d1 create crest
#    → copy the printed database_id into wrangler.toml

# 3. Create the tables in the remote (deployed) DB
pnpm run schema

# 4. Typecheck, then deploy (uploads public/, registers the cron trigger)
pnpm run typecheck
pnpm run deploy
```

> **pnpm caveat:** `pnpm deploy` is a *built-in pnpm command* (workspace deployment) and will shadow the script. Always run the script as **`pnpm run deploy`**.

The cron fires every 10 minutes. To populate immediately, trigger the poller once (see Local development below) or wait for the first scheduled run.

## Local development

```bash
pnpm run schema:local        # create the tables in the local D1
pnpm exec wrangler dev       # page at http://localhost:8787, API at /api/stories
```

Trigger the scheduled handler locally (otherwise it only runs on the cron): with `wrangler dev` running, hit its test endpoint — `curl "http://localhost:8787/__scheduled"` — or start with `pnpm exec wrangler dev --test-scheduled`.

## Tuning

Set in `wrangler.toml`'s `[vars]` block (or the Cloudflare dashboard); removing a var falls back to its default below.

| Var | Meaning | Default |
| --- | --- | --- |
| `SCORE_TARGET` | Points threshold for inclusion | 150 |
| `WINDOW_DAYS` | How late a bloomer is still caught | 7 |
| `HITS_PER_PAGE` | Must exceed qualifying stories in the window | 1000 |
| `PAGE_SIZE` | Stories per page, API and frontend | 20 |

## `first_seen` semantics

`first_seen` is the moment the *poller* observed a story crossing the threshold — not when it was posted to HN (`hn_created`), and not page-load time. The feed sorts by `first_seen`, so a story posted days ago that only now crosses 150 points still shows up as "new."
