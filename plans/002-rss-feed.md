# Plan 002: Add an RSS feed endpoint at `GET /feed.xml`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c37464c..HEAD -- src/index.ts wrangler.toml public/index.html`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on
> a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `c37464c`, 2026-06-18

## Why this matters

Crest already frames itself as a "digest" (`README.md`'s footer text: "refreshes every 10 minutes") and its data model — `stories` ordered by `first_seen` — maps directly onto an RSS item list with no schema change needed. People who want a periodic digest of 150+-point HN stories are exactly the audience who already uses feed readers for this kind of thing, and right now the only way to consume Crest is to load the HTML page yourself. Adding a feed endpoint is a thin read-only addition reusing the existing query.

## Current state

- `src/index.ts:107-151` (current, actual) — the `/api/stories` handler, the pattern to follow for binding env vars and running the D1 query:
  ```ts
  app.get('/api/stories', async (c) => {
    const pageSize = envNumber(c.env.PAGE_SIZE, DEFAULT_PAGE_SIZE);
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const offset = (page - 1) * pageSize;

    // Fetch one extra row to know if a next page exists, without a separate COUNT query.
    const { results } = await c.env.crest.prepare(
      `SELECT id, title, url, points, num_comments, hn_created, first_seen
         FROM stories
        ORDER BY first_seen DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(pageSize + 1, offset)
      .all<{
        id: number;
        title: string;
        url: string | null;
        points: number;
        num_comments: number;
        hn_created: number;
        first_seen: number;
      }>();

    const hasMore = results.length > pageSize;

    const lastPoll = await c.env.crest
      .prepare(`SELECT v FROM meta WHERE k = 'last_poll'`)
      .first<{ v: number }>();

    c.header('Cache-Control', 'public, max-age=300');
    return c.json({
      stories: results.slice(0, pageSize).map((r) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        points: r.points,
        comments: r.num_comments,
        hn_created: r.hn_created,
        first_seen: r.first_seen,
      })),
      page,
      hasMore,
      lastPolled: lastPoll?.v ?? null,
    });
  });
  ```
- `src/index.ts:105` — `const app = new Hono<{ Bindings: Env }>();` — the new route is registered on this same `app`.
- The deployed Worker's public URL is `https://crest.byt3h3ad.workers.dev` (from `wrangler.toml:1`, `name = "crest"`, plus the `workers.dev` default route) — used below to build absolute `<link>`/`<guid>` URLs in the feed.
- `ARCHITECTURE.md` §6.6 confirms: "Do **not** add a `'/'` route — `index.html` is served by static assets before the Worker runs." The new `/feed.xml` route does not collide with this since it's a Worker route, not a static asset path, and static assets are checked first — there is no `public/feed.xml` file, so requests to `/feed.xml` will correctly fall through to the Worker.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|-----------------------------------|---------------------|
| Typecheck | `pnpm run typecheck`              | exit 0, no errors   |
| Local dev | `pnpm exec wrangler dev`          | serves on `http://localhost:8787`; `curl http://localhost:8787/feed.xml` returns XML |

## Scope

**In scope** (the only files you should modify):
- `src/index.ts` (add the new route and an XML-escaping helper)
- `public/index.html` (add a `<link rel="alternate" type="application/rss+xml">` tag in `<head>`, pointing readers/feed-discovery tools at the new feed)

**Out of scope** (do NOT touch, even though they look related):
- `schema.sql` — no schema change is needed; the feed reuses the existing `stories` and `meta` tables read-only.
- The `/api/stories` JSON endpoint — leave its behavior and response shape untouched; the feed is a separate, additive route.
- Pagination — the feed should return a single fixed-size batch of the most recent stories (see Step 1), not paginated; RSS readers don't paginate.

## Git workflow

- Branch: `advisor/002-rss-feed`
- Single commit, message style matching the repo's existing commits: e.g. `Add RSS feed endpoint at /feed.xml`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the `/feed.xml` route

In `src/index.ts`, add a new route on the existing `app` (after the `/api/stories` handler, before `export default`):

- Query the same `stories` table, `ORDER BY first_seen DESC`, with a fixed `LIMIT 30` (no offset, no pagination — a feed reader wants "the recent items," not a specific page). Reuse the column list from the existing `/api/stories` query (`id, title, url, points, num_comments, hn_created, first_seen`).
- For each row, build one RSS `<item>`:
  - `<title>` — the story title, XML-escaped (see escaping helper below).
  - `<link>` — `s.url` if present, else `https://news.ycombinator.com/item?id=${s.id}` (same fallback logic as `linkUrl` in `public/index.html`'s `load()` function).
  - `<guid isPermaLink="false">crest-${s.id}</guid>` — stable per-story identifier independent of whether `url` changes; `isPermaLink="false"` because the guid string itself is not a fetchable URL.
  - `<pubDate>` — `new Date(s.first_seen * 1000).toUTCString()` (RSS dates are RFC 822; `first_seen` is the field the rest of the app sorts by, per `ARCHITECTURE.md` §11's `first_seen` semantics note — use it here too, not `hn_created`, for consistency with "newest first" meaning "newest into Crest's feed").
  - `<description>` — XML-escaped text: `${s.points} points · ${s.num_comments} comments`.
- Wrap items in an RSS 2.0 envelope:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0">
    <channel>
      <title>Crest</title>
      <link>https://crest.byt3h3ad.workers.dev/</link>
      <description>Stories that crossed 150+ points, newest first.</description>
      <!-- items here -->
    </channel>
  </rss>
  ```
- Set the response header `Content-Type: application/rss+xml; charset=utf-8`.
- Reuse the same `Cache-Control: public, max-age=300` header as `/api/stories` (`src/index.ts:136`) — same justification: data only changes per poll cycle.
- Write a small XML-escaping helper (no dependency — this is a 5-line function): escape `&`, `<`, `>`, `"`, `'` to their entity equivalents, applied to `title` and `description` text before interpolating into the XML string. **Do not skip this** — titles come from HN submitters and can contain any of these characters; unescaped interpolation would produce invalid XML.
- Return the XML via `c.body(xml, 200, { 'Content-Type': 'application/rss+xml; charset=utf-8' })` (Hono's `c.body` for non-JSON string responses — see [Hono docs](https://hono.dev/docs/api/context#body) if unfamiliar; do not use `c.json`, which would wrap the string in JSON quoting).

**Verify**: `pnpm run typecheck` → exit 0.

### Step 2: Manual local verification

Start `pnpm exec wrangler dev`, then in another shell:
```bash
curl -s http://localhost:8787/feed.xml | head -c 500
```
Confirm the output starts with `<?xml version="1.0" encoding="UTF-8"?>` and contains `<rss version="2.0">`. If the local D1 has no rows yet (fresh checkout), the `<channel>` will simply have no `<item>` elements — that's valid RSS and acceptable; don't treat it as a failure.

**Verify**: response starts with `<?xml` and `Content-Type` header (check via `curl -sI http://localhost:8787/feed.xml`) is `application/rss+xml; charset=utf-8`.

### Step 3: Link the feed from the page head

In `public/index.html`, inside `<head>`, add (near the existing `<link rel="icon">` tag):
```html
<link rel="alternate" type="application/rss+xml" title="Crest" href="/feed.xml">
```
This lets browsers/feed readers auto-discover the feed from the page; it does not change any visible UI.

**Verify**: reload `http://localhost:8787/` with `wrangler dev` running; view source and confirm the `<link rel="alternate">` tag is present in `<head>`.

## Test plan

This repo has no test suite yet (see plan 001 / finding TEST-01 in the audit — out of scope here). Verification for this plan is the manual `curl` checks in Steps 2–3, plus:
- One additional manual check: submit the feed XML output to an XML well-formedness check, e.g. `curl -s http://localhost:8787/feed.xml | xmllint --noout -` (if `xmllint` is available in the executor's environment; if not, skip this check and rely on the `<?xml` / `<rss>` substring checks above — note which one you used in your completion report).
- Specifically exercise a story title containing `&`, `<`, or `"` if any exist in the local/remote data (e.g. `SELECT title FROM stories WHERE title LIKE '%&%' LIMIT 1`) to confirm the escaping helper actually fires; if no such row exists locally, this check is optional but should be noted as skipped, not silently omitted.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0.
- [ ] `curl -s http://localhost:8787/feed.xml` (with `wrangler dev` running) returns content starting with `<?xml version="1.0" encoding="UTF-8"?>`.
- [ ] `curl -sI http://localhost:8787/feed.xml` shows `content-type: application/rss+xml; charset=utf-8`.
- [ ] `grep -n 'rel="alternate"' public/index.html` finds the new `<link>` tag.
- [ ] No files outside `src/index.ts` and `public/index.html` are modified (`git status`).
- [ ] `plans/README.md` status row for plan 002 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The `/api/stories` route's query shape in "Current state" doesn't match what's actually in `src/index.ts` — the codebase has drifted, re-derive the new route from the live query instead of the excerpt above.
- You find yourself wanting to add a dependency (an XML/RSS library) — this feed is simple enough for a hand-written template plus the escaping helper; adding a dependency for this is out of scope and should be flagged back instead of done unilaterally.
- The deployed `workers.dev` URL in `wrangler.toml` differs from `https://crest.byt3h3ad.workers.dev` assumed above (e.g. a custom domain was added since this plan was written) — use whatever the actual current deployment URL is for the `<channel><link>` value instead.

## Maintenance notes

- If pagination semantics or the `stories` table schema change (e.g. a new column needed in the feed), this route's query must be updated in lockstep with `/api/stories` — they currently share the same column list by convention, not by shared code; consider extracting a shared query helper if they drift further.
- A reviewer should check that the XML escaping helper is actually applied to *all* user-controlled text fields (`title`, and the `description` text built from `points`/`num_comments` is safe since those are numbers, but if `description` content is ever extended to include `author` or other free-text fields, escape those too).
- Feed item count is hardcoded at 30 in this plan; if that should become configurable later, follow the existing `[vars]` pattern in `wrangler.toml` (see CREST-7 in `ARCHITECTURE.md` and the `SCORE_TARGET`/`WINDOW_DAYS`/etc. vars already there) rather than hardcoding a second magic number.
