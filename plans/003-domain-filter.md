# Plan 003: Add a clickable domain filter to `/api/stories` and the frontend

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 9b8e4aa..HEAD -- src/index.ts public/index.html`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on
> a mismatch, treat it as a STOP condition.
>
> **Reconciled 2026-06-18**: this plan was originally planned at `c37464c`.
> Plan 002 (RSS feed) landed in between and touched both in-scope files —
> it appended a new `/feed.xml` route after `/api/stories` in `src/index.ts`
> (no change to the `/api/stories` handler itself) and added one `<link>`
> line in `public/index.html`'s `<head>`. The excerpts below are re-verified
> against the post-002 code; only the `public/index.html` line numbers
> shifted by +1 from the original plan.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: MED (the SQL filter pattern below is the part to scrutinize — see "Why a LIKE pattern, not a domain column")
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `9b8e4aa`, 2026-06-18 (reconciled; originally `c37464c`)

## Why this matters

`public/index.html` already extracts and displays each story's domain (the `.host` span, via the `domain()` helper) but does nothing with it beyond display. Turning that existing extraction into a clickable filter is a small UI addition, and doing the filtering server-side (rather than only on the currently-loaded page of 20 rows) means a click actually surfaces all matching stories across the whole table, not just whatever happens to be on the page the user was looking at.

## Current state

- `public/index.html:70-76` (current, actual) — the existing domain-extraction helper, reused as-is by this plan:
  ```js
  function domain(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
  ```
- `public/index.html:138-143` (current, actual) — where the domain is currently only ever displayed, never clickable:
  ```js
  if (s.url) {
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = ' (' + domain(s.url) + ')';
    li.appendChild(host);
  }
  ```
- `public/index.html:94-168` — the `load(page)` function. Relevant excerpt (full function is longer; this shows the fetch call and pager wiring this plan must extend):
  ```js
  const pager = document.getElementById('pager');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const pageLabel = document.getElementById('pageLabel');
  let currentPage = 1;

  prevBtn.onclick = () => load(currentPage - 1);
  nextBtn.onclick = () => load(currentPage + 1);

  async function load(page) {
    const list = document.getElementById('list');
    const checked = document.getElementById('checked');
    const updated = document.getElementById('updated');
    try {
      const res = await fetch('/api/stories?page=' + page);
      if (!res.ok) throw new Error('bad response');
      const { stories, hasMore, lastPolled } = await res.json();
      const now = Math.floor(Date.now() / 1000);

      currentPage = page;
      pager.hidden = page === 1 && !hasMore;
      pageLabel.textContent = 'Page ' + page;
      prevBtn.disabled = page === 1;
      nextBtn.disabled = !hasMore;
      ...
  ```
- `src/index.ts:107-151` (current, actual) — the `/api/stories` handler this plan extends with an optional `domain` query param:
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
      .all<{ ... }>();
    ...
  ```

### Why a LIKE pattern, not a domain column

The `stories` table (`schema.sql`) stores the full `url`, not an extracted domain — there is no domain column to filter on directly, and adding one would require a schema migration plus a backfill of existing rows, which is out of scope for this plan (flagged as a possible follow-up in "Maintenance notes"). Instead, this plan matches the domain against `url` using SQL `LIKE`, anchored on the URL scheme so `?domain=abc.com` cannot accidentally match `https://notabc.com/...`. D1/SQLite support **numbered parameters** (`?1`, `?2`, ...) which can be bound once and referenced multiple times in the same statement — use this so the domain value is bound a single time despite appearing in multiple `LIKE` branches (matching both with and without a `www.` prefix, and both `http://` and `https://`):

```sql
WHERE (
  url LIKE 'http://' || ?1 OR url LIKE 'http://' || ?1 || '/%'
  OR url LIKE 'https://' || ?1 OR url LIKE 'https://' || ?1 || '/%'
  OR url LIKE 'http://www.' || ?1 OR url LIKE 'http://www.' || ?1 || '/%'
  OR url LIKE 'https://www.' || ?1 OR url LIKE 'https://www.' || ?1 || '/%'
)
```

This is exact-domain matching (anchored at the scheme and terminated at `/` or end-of-string), not a substring match — `?domain=abc.com` will not match `https://evil-abc.com/`. **Known limitation, acceptable for this plan**: SQL `LIKE`'s `_` and `%` are wildcard characters; if a domain ever legitimately contains a literal `%` or `_` (it won't in practice — these aren't valid hostname characters), it would behave as a wildcard rather than a literal match. Since `domain` originates from `new URL(...).hostname` values which cannot contain `%` or `_` as anything but valid hostname/IDN characters, this is not exploitable, just worth knowing.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|---------------------------|---------------------|
| Typecheck | `pnpm run typecheck`      | exit 0, no errors   |
| Local dev | `pnpm exec wrangler dev`  | serves on `http://localhost:8787` |

## Scope

**In scope** (the only files you should modify):
- `src/index.ts` (add the optional `domain` query param and `WHERE` clause to `/api/stories`)
- `public/index.html` (make the `.host` span clickable, add filter state + a "clear filter" affordance, pass `domain` through to `fetch`)

**Out of scope** (do NOT touch, even though they look related):
- `schema.sql` — no new column, no migration (see "Why a LIKE pattern, not a domain column" above).
- `/feed.xml` (plan 002, if it exists by the time you run this) — do not add filtering there; out of scope for this plan.
- Combining the domain filter with pagination's `hasMore` semantics beyond what's specified in Step 1 — don't invent additional query params (e.g. sort order, multi-domain filters).

## Git workflow

- Branch: `advisor/003-domain-filter`
- Single commit, message style matching the repo's existing commits: e.g. `Add clickable domain filter to the stories feed`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend `/api/stories` with an optional `domain` query param

In `src/index.ts`'s `/api/stories` handler:

- Read `const domainFilter = c.req.query('domain');` (will be `undefined` when absent — same `c.req.query()` pattern already used for `page`).
- When `domainFilter` is set, add the `WHERE` clause from "Why a LIKE pattern, not a domain column" above to the existing `SELECT` query, and bind it as an **additional** parameter. Since the existing query uses plain `?` placeholders (positional) for `LIMIT`/`OFFSET`, switch this query specifically to numbered placeholders (`?1` for the domain, `?2`/`?3` for `LIMIT pageSize + 1`/`OFFSET`) so the repeated domain reference works — i.e. when filtering, bind as `.bind(domainFilter, pageSize + 1, offset)`; when not filtering, keep today's unfiltered query and `.bind(pageSize + 1, offset)` unchanged. Implement this as two branches (build a different SQL string depending on whether `domainFilter` is present) rather than trying to make one query string handle both cases — keep it simple.
- Echo the active filter back in the JSON response so the frontend can show "Filtered by: X" state without tracking it separately: add `domain: domainFilter ?? null` to the response object (alongside the existing `page`, `hasMore`, `lastPolled`).
- Do not change the response shape of `stories[]` items themselves — same fields as today.

**Verify**: `pnpm run typecheck` → exit 0.

### Step 2: Manual verification of the new query param

With `pnpm exec wrangler dev` running and at least one story with a non-null `url` in the local D1:
```bash
curl -s 'http://localhost:8787/api/stories?domain=github.com' | head -c 300
```
Confirm the response is valid JSON with a `"domain":"github.com"` field, and that every story in `"stories"` (if any) has a `url` whose hostname is `github.com` or `www.github.com`. Then confirm the *unfiltered* case still works exactly as before:
```bash
curl -s 'http://localhost:8787/api/stories?page=1' | head -c 300
```
should be unchanged from current behavior (no `domain` key needed in this case — or `"domain":null` per Step 1 — either is acceptable as long as it's consistent with what you implemented).

**Verify**: both `curl` calls return valid JSON; the filtered call only returns matching rows.

### Step 3: Make the domain span clickable in the frontend

In `public/index.html`:

- Add a module-level filter variable near the existing `let currentPage = 1;` (around line 92): `let currentDomain = null;`.
- In `load(page)`, change the fetch call to include the domain when set:
  ```js
  const params = new URLSearchParams({ page: String(page) });
  if (currentDomain) params.set('domain', currentDomain);
  const res = await fetch('/api/stories?' + params.toString());
  ```
- In the per-story render loop (around the `.host` span excerpt above), turn the host span into a clickable element: change it from a `<span>` to an `<a href="#">` (or keep the `<span>` and attach a click handler — either is fine, but it must be keyboard-focusable, so prefer the `<a href="#">` approach for free accessibility), with a click handler that calls `load(1)` after setting `currentDomain = domain(s.url)` and calls `e.preventDefault()` to avoid navigating.
- Add a small filter-state indicator near the existing `#checked`/`#updated` subtitle spans (reuse that line rather than adding new DOM structure): when `currentDomain` is set, show something like `Filtered by ${currentDomain} (clear)` where "(clear)" is itself a clickable element that sets `currentDomain = null` and calls `load(1)`.
- Reset `currentDomain = null` is **not** needed on normal page navigation (prev/next) — the filter should persist across pages until explicitly cleared, matching how `currentPage` already persists.

**Verify**: with `wrangler dev` running, load `http://localhost:8787/`, click a domain in parentheses next to any story with a URL, and confirm: (a) the list re-renders showing only stories from that domain, (b) a "Filtered by ... (clear)" indicator appears, (c) clicking "(clear)" returns to the unfiltered list at page 1.

## Test plan

This repo has no test suite yet (out of scope here, see plan 001). Verification is the manual `curl` and browser checks in Steps 2–3. If plan 001 (vitest-pool-workers setup) has already landed by the time this plan executes, add one test case to whatever test file it created covering `/api/stories?domain=`: a story with `url = 'https://www.example.com/foo'` should match `?domain=example.com`, and a story with `url = 'https://notexample.com/'` should **not** match `?domain=example.com` — this is the anchoring behavior the LIKE pattern exists to guarantee. If plan 001 hasn't landed, skip this and note it as deferred.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0.
- [ ] `curl -s 'http://localhost:8787/api/stories?domain=github.com'` (with at least one matching local row) returns only rows whose `url` hostname matches `github.com` or `www.github.com`.
- [ ] `curl -s 'http://localhost:8787/api/stories?page=1'` (no `domain` param) returns the same `stories` array shape as before this plan (no regressions to the unfiltered path).
- [ ] `grep -n "currentDomain" public/index.html` shows it used in both the fetch-building code and a click handler.
- [ ] No files outside `src/index.ts` and `public/index.html` are modified (`git status`).
- [ ] `plans/README.md` status row for plan 003 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The `/api/stories` query in "Current state" doesn't match the live code (drift) — re-derive the filter branch from the actual current query rather than the excerpt.
- D1 rejects the numbered-placeholder (`?1`, `?2`, ...) syntax in your environment's wrangler/D1 version — this plan assumes it's supported (SQLite native feature); if `.bind()` throws or the query errors specifically on this, fall back to repeating the domain value once per `LIKE` branch with plain `?` placeholders (8 occurrences of the same bound value) instead of debugging the numbered-param path further, and note the change in your completion report.
- You find the `stories` table already has thousands of rows and the `LIKE`-based filter is measurably slow in local testing — this plan does not add an index for this filter (the existing `idx_stories_first_seen` index doesn't help a `url LIKE` predicate). If this turns out to matter, report it rather than adding an index unilaterally, since indexing `url` for a prefix-`LIKE` pattern needs care (SQLite can only use an index for `LIKE` when the pattern is anchored at the start — these patterns are, via `'http://' || ?1`, but confirm with `EXPLAIN QUERY PLAN` before deciding it's needed).

## Maintenance notes

- If a domain column is ever added to `stories` (e.g. because this LIKE-based approach turns out to need indexing), this filter should be rewritten to use it; the frontend's `currentDomain`/click-handler logic in `public/index.html` would not need to change, only the SQL in `src/index.ts`.
- A reviewer should confirm the anchoring actually prevents `?domain=abc.com` from matching `https://notabc.com/...` — this is the entire point of the multi-branch `LIKE` pattern over a naive `url LIKE '%' || ?1 || '%'`, and is easy to regress by "simplifying" the WHERE clause later.
- This plan deliberately does not touch `/feed.xml` (plan 002) — if that plan has landed, consider as a follow-up (not part of this plan) whether the feed should support the same filter.
