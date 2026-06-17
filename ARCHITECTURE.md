# Crest — HN Hot Stories Feed

A build brief for an implementation agent (Claude Code). It is self-contained: everything needed to produce the project is below, including the rationale for each non-obvious decision so they are not "optimized away." Use **pnpm**, not npm.

> **Crest** — a Hacker News feed showing only the stories that crested a score
> 

> threshold, newest first.
> 

---

## 1. What we're building

A tiny "Hacker News hot stories" website on Cloudflare Workers (free tier).

- A **scheduled** (cron) handler polls the Hacker News search API every 10 minutes and records stories that have crossed a score threshold into a database.
- A **static HTML page** lists those stories, newest first by *when our system first saw them cross the threshold*.
- A small **JSON API** (`GET /api/stories`) is the only dynamic endpoint; the page fetches it client-side.

No Telegram, no link shortener, no per-item fan-out. One Worker, one D1 database, one static page.

---

## 2. Stack

| Concern | Choice |
| --- | --- |
| Runtime | Cloudflare Workers (free plan) |
| Framework | Hono (TypeScript) |
| Storage | Cloudflare D1 (SQLite) |
| Frontend | Static `public/index.html`  • vanilla JS |
| Static serving | Workers Static Assets (`[assets]`) |
| Scheduling | Workers Cron Triggers |
| Package manager | **pnpm** |

---

## 3. Design decisions (do not change these without reason)

These were deliberated; the implementation must honor them.

1. **Poll via the HN Algolia search API, not the Firebase API.** Use `https://hn.algolia.com/api/v1/search_by_date`. The Firebase `topstories.json` + per-item `item/{id}.json` approach requires one subrequest *per story* (hundreds), which exceeds the free plan's 50 external subrequests per invocation. Algolia filters by score server-side and returns everything in **one** subrequest.
2. **`search_by_date`, not `/search`.** `/search` ranks by popularity, so its first page is the all-time top stories and never surfaces new ones. `search_by_date` orders strictly newest-first by post time, which is what discovery needs.
3. **Server-side score + recency filter.** `numericFilters=points>150,created_at_i>{now − 7 days}`. The score threshold and the recency window are evaluated by Algolia.
4. **7-day window + large `hitsPerPage`.** The window is the "late bloomer" tolerance — a story posted days ago that only now crosses the threshold is still caught. Because results are ordered by post time, `hitsPerPage` must be large enough that the window is not truncated from the old end (use 1000).
5. **`first_seen` ordering.** The page sorts by when our poller first observed the story, not by HN post time. This cannot be derived from the API — it requires the background poller plus persistence. (It is *not* page-load time.)
6. **D1, not KV, for the store.** The core operation is "ordered list + dedup," which is native SQL (`ORDER BY first_seen DESC`, unique `id`). KV has no sort/query, a 1,000 writes/day free cap, and ~60s eventual consistency. (KV would only suit an optional cache layer, which we are not building.)
7. **Insert only the diff.** Each poll re-sees the same rolling window, mostly already stored. Check which returned IDs already exist, then `INSERT OR IGNORE` only the new ones. Keeps writes proportional to genuinely new stories (a few dozen/day) and well inside D1's budget.
8. **Static file + JSON API split.** The page is a real static file served directly by Cloudflare. The Worker only serves data. Static assets are served ahead of the Worker, so only `/api/stories` invokes code.
9. **`Cache-Control: public, max-age=300` on the API.** Data only changes every 10 min (the poll interval), so a 5-minute cache guarantees the response refreshes at least once per poll cycle while cutting redundant D1 reads. (This drives the browser's HTTP cache; a dynamic Worker response is not auto-cached at the CF edge — acceptable here.)

---

## 4. Free-tier limits to respect

- **50** external subrequests per invocation → the single Algolia call satisfies this.
- **10 ms CPU** per request *and* per cron trigger (I/O waiting does not count) → JSON parsing of the response must stay light; see Gotchas.
- **100,000** requests/day → ample.
- **D1 free**: 5 GB storage, millions of reads, generous (~100k/day) writes → ample given diff-inserts.
- **5** cron triggers per account → we use one.

---

## 5. Project structure

```
crest/
├─ public/
│  └─ index.html        # static frontend
├─ src/
│  └─ index.ts          # Worker: GET /api/stories + scheduled poller
├─ schema.sql           # D1 table + index
├─ wrangler.toml        # config: D1 binding, static assets, cron
├─ tsconfig.json
├─ package.json
└─ .gitignore
```

---

## 6. Files

### 6.1 `package.json` (verbatim)

```json
{
  "name": "crest",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "schema": "wrangler d1 execute crest --remote --file=./schema.sql",
    "schema:local": "wrangler d1 execute crest --local --file=./schema.sql"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.6.0",
    "wrangler": "^4.0.0"
  }
}
```

Version ranges are caret; `pnpm install` resolves current versions. If anything is stale, install latest: `pnpm add hono` and `pnpm add -D wrangler @cloudflare/workers-types typescript`.

### 6.2 `tsconfig.json` (verbatim)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

### 6.3 `wrangler.toml` (verbatim; set a current `compatibility_date`)

```toml
name = "crest"
main = "src/index.ts"
compatibility_date = "2026-06-17"

# Serve the static frontend from ./public. A request that matches a file there
# ("/" -> index.html) is served directly; anything else (/api/stories) falls
# through to the Worker.
[assets]
directory = "./public"

# Created with: pnpm exec wrangler d1 create crest
# Paste the printed database_id below.
[[d1_databases]]
binding = "DB"
database_name = "crest"
database_id = "REPLACE_WITH_YOUR_DATABASE_ID"

# Poll Hacker News every 10 minutes.
[triggers]
crons = ["*/10 * * * *"]
```

### 6.4 `schema.sql` (verbatim)

```sql
CREATE TABLE IF NOT EXISTS stories (
  id           INTEGER PRIMARY KEY,   -- HN item id (Algolia objectID)
  title        TEXT    NOT NULL,
  url          TEXT,                  -- NULL for text posts (Ask HN, etc.)
  points       INTEGER NOT NULL,      -- score at the moment we first saw it
  num_comments INTEGER NOT NULL DEFAULT 0,
  author       TEXT,
  hn_created   INTEGER NOT NULL,      -- created_at_i: when posted to HN (unix sec)
  first_seen   INTEGER NOT NULL       -- when it entered our feed (unix sec)
);

CREATE INDEX IF NOT EXISTS idx_stories_first_seen ON stories (first_seen DESC);
```

### 6.5 `.gitignore`

```
node_modules
.wrangler
.dev.vars
```

(Commit `pnpm-lock.yaml`.)

### 6.6 `src/index.ts` — specification

#### Bindings / env

```tsx
export interface Env {
  DB: D1Database;
}
```

#### Constants (top of file)

```tsx
const SCORE_TARGET   = 150;   // points threshold
const WINDOW_DAYS    = 7;     // late-bloomer tolerance
const HITS_PER_PAGE  = 1000;  // must exceed qualifying stories in the window
const PAGE_LIMIT     = 100;   // rows the API returns
```

#### Algolia hit type (fields actually used)

`objectID: string`, `title: string | null`, `url: string | null`, `points: number | null`, `num_comments: number | null`, `author: string | null`, `created_at_i: number`.

#### `poll(env): Promise<void>` — exact algorithm

1. `now = Math.floor(Date.now() / 1000)`; `floor = now - WINDOW_DAYS * 86400`.
2. Build the request URL (URL-encode the numericFilters value):
    
    ```
    https://hn.algolia.com/api/v1/search_by_date
      ?tags=story
      &numericFilters=<encodeURIComponent(`points>${SCORE_TARGET},created_at_i>${floor}`)>
      &hitsPerPage=<HITS_PER_PAGE>
    ```
    
3. `fetch(url, { headers: { 'User-Agent': 'crest-worker' } })`. Throw if `!res.ok`.
4. Parse JSON as `{ hits: AlgoliaHit[] }`. Keep only hits where `title` is truthy and `typeof points === 'number'`. If none, return.
5. `ids = hits.map(h => Number(h.objectID))`. Query existing ids:
    
    ```sql
    SELECT id FROM stories WHERE id IN (?, ?, … one placeholder per id)
    ```
    
    Bind all ids; collect results into a `Set<number>`.
    
6. `fresh = hits` whose id is **not** in that set. If none, return.
7. Insert the fresh rows in one `env.DB.batch([...])`, each statement:
    
    ```sql
    INSERT OR IGNORE INTO stories
      (id, title, url, points, num_comments, author, hn_created, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ```
    
    Bind: `Number(objectID)`, `title`, `url ?? null`, `points ?? 0`, `num_comments ?? 0`, `author ?? null`, `created_at_i`, **`now`** (first_seen). Build one prepared statement and reuse it with `.bind(...)` per row inside the batch.
    

#### `GET /api/stories` — exact behavior

- Query:
    
    ```sql
    SELECT id, title, url, points, num_comments, hn_created, first_seen
      FROM stories
     ORDER BY first_seen DESC
     LIMIT ?            -- bind PAGE_LIMIT
    ```
    
- Set header `Cache-Control: public, max-age=300`.
- Respond JSON, mapping `num_comments → comments`:
    
    ```json
    {
      "stories": [
        {
          "id": 123,
          "title": "…",
          "url": "https://… or null",
          "points": 187,
          "comments": 42,
          "hn_created": 1718600000,
          "first_seen": 1718603600
        }
      ]
    }
    ```
    

#### Hono app

```tsx
const app = new Hono<{ Bindings: Env }>();
app.get('/api/stories', async (c) => { /* as above, c.env.DB */ });
```

Do **not** add a `'/'` route — `index.html` is served by static assets before the Worker runs, so it would be dead code.

#### Worker entry point

```tsx
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(poll(env));
  },
} satisfies ExportedHandler<Env>;
```

### 6.7 `public/index.html` — specification

Single self-contained file: inline `<style>` and one inline `<script>` (no framework, no build step, no external requests).

**Markup**

- `<title>` and `<h1>`: **"Crest"**.
- `<header>` with the `<h1>` and a muted subtitle: "Stories that crossed 150+ points, newest first." plus a `<span id="updated">`.
- `<ol id="list">` initially containing one `<li class="empty">Loading…</li>`.
- `<footer>`: "Sourced from the Hacker News (Algolia) API · refreshes every 10 minutes".

**Style direction** (keep minimal)

- System font stack; `max-width: 720px`; centered; ~2rem padding.
- `:root { color-scheme: light dark; }` so it adapts to OS theme.
- Links use HN orange `#ff6600`; meta text muted `#888`; subtle bottom border between stories.

**Script behavior**

1. `fetch('/api/stories')`; on non-OK, throw.
2. `const { stories } = await res.json()`; `now = Math.floor(Date.now()/1000)`.
3. Clear the list. Set `#updated` text to `"Updated " + ago(stories[0].first_seen, now)` when non-empty, else "".
4. Empty array → render one `<li class="empty">No stories yet — the poller runs every 10 minutes.</li>` and stop.
5. For each story build a `<li class="story">`:
    - `hnUrl = "https://news.ycombinator.com/item?id=" + s.id`.
    - `linkUrl = s.url || hnUrl`.
    - Title: `<a class="title" href=linkUrl rel="noopener">` with the title set via **`textContent`** (never `innerHTML`, to prevent markup injection).
    - If `s.url`, append `<span class="host"> (DOMAIN)</span>` where DOMAIN is the hostname minus a leading `www.`.
    - Meta `<div class="meta">`: `EMOJI + s.points + "+ points · "`, then an `<a href=hnUrl rel="noopener">` with text `s.comments + " comments"`, then `" · added " + ago(s.first_seen, now)`.
6. Catch any error → render one `<li class="empty">Couldn't load stories. Try refreshing.</li>`.

**Helper rules (must match these exactly)**

- `ago(fromUnix, now)`: `s = max(0, now - fromUnix)`; if ≥1 day → `"N day(s) ago"`; else if ≥1 hour → `"N hour(s) ago"`; else if ≥1 minute → `"N minute(s) ago"`; else `"just now"`.
- `EMOJI`: `climb = first_seen - hn_created`; `climb <= 4*3600` → `"🔥 "`; else `climb >= 2*86400` → `"❄️ "`; else `""`.
- `domain(u)`: `new URL(u).hostname.replace(/^www\./, '')`, wrapped in try/catch returning `""`.

(Relative times are computed client-side from `Date.now()` on every load, so the 300s API cache never makes them wrong — it can only delay a brand-new story.)

---

## 7. Setup & deploy (pnpm)

```bash
# 1. Install dependencies
pnpm install

# 2. Create the D1 database
pnpm exec wrangler d1 create crest
#    → copy the printed database_id into wrangler.toml

# 3. Create the table in the remote (deployed) DB
pnpm run schema

# 4. Typecheck, then deploy (uploads public/, registers the cron trigger)
pnpm run typecheck
pnpm run deploy
```

> **pnpm caveat:** `pnpm deploy` is a *built-in pnpm command* (workspace deployment) and will shadow the script. Always run the script as **`pnpm run deploy`**. As a rule, invoke project scripts with `pnpm run <name>`.
> 

The cron fires every 10 minutes. To populate immediately, trigger the poller once (below).

## 8. Local development

```bash
pnpm run schema:local        # create the table in the local D1
pnpm exec wrangler dev       # page at http://localhost:8787, API at /api/stories
```

Trigger the scheduled handler locally (otherwise it only runs on the cron): with `wrangler dev` running, hit its test endpoint — `curl "http://localhost:8787/__scheduled"` — or start with `pnpm exec wrangler dev --test-scheduled`.

## 9. Verification

- `pnpm run typecheck` must pass clean.
- `GET /api/stories` returns `{ "stories": [...] }` (empty array before the first successful poll).
- After one poll, the page lists stories newest-first; titles link out, the comment count links to the HN item, and "added X ago" reflects `first_seen`.

---

## 10. Tuning (constants in `src/index.ts`)

| Constant | Meaning | Default |
| --- | --- | --- |
| `SCORE_TARGET` | Points threshold for inclusion | 150 |
| `WINDOW_DAYS` | How late a bloomer is still caught | 7 |
| `HITS_PER_PAGE` | Must exceed qualifying stories in the window | 1000 |
| `PAGE_LIMIT` | Stories returned by the API / shown on the page | 100 |

Cache duration lives on the response header (`max-age=300`).

(CREST-7 optionally moves these four constants into Wrangler `[vars]`, with the values above as fallback defaults, so they can be changed without editing code.)

---

## 11. Gotchas / notes

- **Do not** revert to the Firebase `topstories` + per-item approach — it blows the 50-subrequest cap (see §3.1).
- **First-ever poll** parses the largest response (the whole window at once). If it ever bumps the 10 ms cron CPU limit, lower `HITS_PER_PAGE`; steady-state polls parse far less.
- **Edge caching**: the `Cache-Control` header drives the browser's cache only; Cloudflare does not auto-cache a dynamic Worker response at the edge without the Cache API. That is fine for this use case.
- **`first_seen` semantics**: it is the moment the *poller* observed the story over threshold — not HN post time, not page-load time. It exists only because the background cron writes it.
- **Late-bloomer edge case**: a story that crosses the threshold more than `WINDOW_DAYS` after posting, or that is pushed past `HITS_PER_PAGE` in the window, may be missed. Acceptable for a digest.
- **Routing**: static assets are served before the Worker; only non-file paths (i.e. `/api/stories`) reach the code. Keep the Hono app limited to the API.

---

## 12. Implementation backlog (stories)

Ordered; each builds on the previous. References (§) point to the detailed specs above — read them rather than re-deriving. Build and verify one story before starting the next.

### CREST-1 — Project scaffold & tooling

**Goal:** a Worker that runs locally with the toolchain in place.

**Tasks**

- Author `package.json` (§6.1), `tsconfig.json` (§6.2), `.gitignore` (§6.5).
- `pnpm install`, then `pnpm add hono` and `pnpm add -D wrangler @cloudflare/workers-types typescript` if versions need refreshing.
- Minimal `wrangler.toml` (§6.3): `name`, `main`, `compatibility_date`. The `[assets]`, `[[d1_databases]]`, and `[triggers]` blocks can be added in their own stories.
- Stub `src/index.ts`: a Hono app whose `GET /api/stories` returns `{ "stories": [] }`, exported via the Worker entry pattern (§6.6).

**Acceptance**

- `pnpm run typecheck` passes.
- `pnpm exec wrangler dev` serves; `GET /api/stories` → `{ "stories": [] }`.

**Depends on:** —

### CREST-2 — D1 database & schema

**Goal:** the store exists and is bound to the Worker.

**Tasks**

- `pnpm exec wrangler d1 create crest`; paste the `database_id` into `wrangler.toml`; add the `[[d1_databases]]` block with `binding = "DB"` (§6.3).
- Author `schema.sql` (§6.4).
- Apply it: `pnpm run schema` (remote) and `pnpm run schema:local` (local dev DB).
- Add the `DB: D1Database` field to `Env` (§6.6).

**Acceptance**

- `pnpm exec wrangler d1 execute crest --command "SELECT name FROM sqlite_master WHERE type IN ('table','index')"` lists `stories` and `idx_stories_first_seen`.
- `c.env.DB` is typed and usable in the Worker.

**Depends on:** CREST-1

### CREST-3 — Poller (scheduled handler)

**Goal:** the cron populates D1 from the HN Algolia API.

**Tasks**

- Add the constants and `AlgoliaHit` type (§6.6).
- Implement `poll(env)` exactly per the 7-step algorithm (§6.6): one `search_by_date` request, filter, existing-ID diff, batched `INSERT OR IGNORE` with `first_seen = now`.
- Wire the `scheduled` handler (`ctx.waitUntil(poll(env))`) and add `[triggers] crons = ["*/10 * * * *"]` (§6.3).

**Acceptance**

- Triggering the scheduled handler locally (§8) inserts rows.
- A **second** trigger inserts no duplicates (diff + `INSERT OR IGNORE` hold).
- Every inserted row has `points >= 150` and `first_seen` ≈ the poll time.
- The poll issues exactly **one** external subrequest.

**Depends on:** CREST-2

### CREST-4 — JSON API (fetch handler)

**Goal:** serve stored stories as JSON, newest-first.

**Tasks**

- Implement `GET /api/stories` (§6.6): the `ORDER BY first_seen DESC LIMIT PAGE_LIMIT` query, the `Cache-Control: public, max-age=300` header, and the response shape mapping `num_comments → comments`.

**Acceptance**

- Returns `{ "stories": [...] }` ordered by `first_seen` descending.
- `Cache-Control` header present with `max-age=300`.
- Returns `{ "stories": [] }` cleanly when the table is empty.

**Depends on:** CREST-2 (real rows once CREST-3 has run)

### CREST-5 — Static frontend

**Goal:** a real static page that renders the feed.

**Tasks**

- Author `public/index.html` (§6.7): markup, minimal style, and the render script with the exact `ago` / emoji / `domain` rules and the loading/empty/error states (`textContent` only — no `innerHTML` for data).
- Title and `<h1>` = "Crest".
- Add `[assets] directory = "./public"` to `wrangler.toml` (§6.3).

**Acceptance**

- `/` serves the page; only `/api/stories` reaches the Worker.
- With data present: stories render newest-first; title → article (or HN item when no URL); comment count → HN item; 🔥/❄️ and "added X ago" correct.
- Loading, empty, and error states all display.

**Depends on:** CREST-4

### CREST-6 — Deploy & end-to-end verification

**Goal:** live on Cloudflare, populated, on schedule.

**Tasks**

- `pnpm run typecheck`, then `pnpm run deploy` (note: `pnpm run`, never `pnpm deploy` — see §7 caveat).
- Confirm the 10-minute cron trigger is registered.
- Trigger one initial poll (or wait for the cron) to seed data.

**Acceptance**

- The deployed URL serves both the page and `/api/stories`.
- The cron shows a 10-minute schedule in the dashboard / wrangler output.
- The live page lists real HN stories, newest-first.

**Depends on:** CREST-3, CREST-5

### CREST-7 — Polish (optional)

**Goal:** production niceties — docs, an icon, and runtime-tunable thresholds.

**Tasks**

- [**README.md](http://README.md).** A short top-level README for whoever runs the repo (distinct from this spec, which is the build brief): one-line description, the §7 setup/deploy steps, the §10 tuning table, and a note on `first_seen` semantics (§11).
- **Favicon.** Add `public/favicon.svg` — a simple wave-crest mark in HN orange (`#ff6600`) — and reference it in `<head>`:
    
    ```html
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    ```
    
    It is served automatically as a static asset. Example starting point (adjust freely):
    
    ```html
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="6" fill="#ff6600"/>
      <path d="M4 21c4 0 4-8 8-8s4 8 8 8 4-8 8-8" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    </svg>
    ```
    
- **Configurable thresholds via vars.** Move the §10 constants into Wrangler `[vars]` so they can be changed in config — and edited live in the dashboard — without touching code:
    - Add to `wrangler.toml`:
        
        ```toml
        [vars]
        SCORE_TARGET = "150"
        WINDOW_DAYS = "7"
        HITS_PER_PAGE = "1000"
        PAGE_LIMIT = "100"
        ```
        
    - Extend `Env` with optional string fields for each. Read each as `Number(env.X)` and **fall back to the current hardcoded literal** when unset or `NaN`. Keep today's values (150 / 7 / 1000 / 100) as those fallbacks, so defaults are unchanged and the Worker still runs with no vars defined.
    - Vars arrive as **strings** — always parse and validate. No secrets are needed (none of these are sensitive).

**Acceptance**

- A clean checkout can be built and deployed following only `README.md`.
- The browser tab shows the favicon.
- Changing `SCORE_TARGET` (in `wrangler.toml` or the dashboard) and redeploying changes which stories are ingested, with no code edit; removing the vars entirely falls back to 150 / 7 / 1000 / 100.

**Depends on:** CREST-3, CREST-4, CREST-5 (touches the poller, the API limit, and the page head)