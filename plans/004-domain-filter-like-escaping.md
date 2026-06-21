# Plan 004: Escape LIKE metacharacters in the `/api/stories` domain filter

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 26117fd..HEAD -- src/index.ts`
> If `src/index.ts` changed since this plan was written, compare the
> "Current state" excerpt below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `26117fd`, 2026-06-21

## Why this matters

`GET /api/stories?domain=<value>` binds `<value>` directly into SQL `LIKE`
patterns without escaping the SQL wildcard characters `%` and `_`. Verified
live against the deployed site: `GET /api/stories?domain=%25` (URL-encoded
`%`) returns all 20 stories — the same as no filter at all — instead of zero
(no story's URL hostname is literally `%`). A visitor who clicks the
"Filtered by X" link gets a correct filter, but anyone hitting the API
directly with a `%` or `_` in the `domain` value gets a silently broken
filter that looks like it worked (200 OK, a full page of results) but
isn't actually filtering. This is a correctness bug in a public API
contract, not just an edge case.

## Current state

- `src/index.ts` — single-file Hono Worker. The `/api/stories` handler
  (starts line 107) builds two query variants depending on whether
  `domain` was passed.

Exact code today (`src/index.ts:107-146`):

```ts
app.get('/api/stories', async (c) => {
  const pageSize = envNumber(c.env.PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const offset = (page - 1) * pageSize;
  const domainFilter = c.req.query('domain');

  // Fetch one extra row to know if a next page exists, without a separate COUNT query.
  type StoryRow = {
    id: number;
    title: string;
    url: string | null;
    points: number;
    num_comments: number;
    hn_created: number;
    first_seen: number;
  };

  const { results } = domainFilter
    ? await c.env.crest.prepare(
        `SELECT id, title, url, points, num_comments, hn_created, first_seen
           FROM stories
          WHERE (
            url LIKE 'http://' || ?1 OR url LIKE 'http://' || ?1 || '/%'
            OR url LIKE 'https://' || ?1 OR url LIKE 'https://' || ?1 || '/%'
            OR url LIKE 'http://www.' || ?1 OR url LIKE 'http://www.' || ?1 || '/%'
            OR url LIKE 'https://www.' || ?1 OR url LIKE 'https://www.' || ?1 || '/%'
          )
          ORDER BY first_seen DESC
          LIMIT ?2 OFFSET ?3`,
      )
        .bind(domainFilter, pageSize + 1, offset)
        .all<StoryRow>()
    : await c.env.crest.prepare(
        `SELECT id, title, url, points, num_comments, hn_created, first_seen
           FROM stories
          ORDER BY first_seen DESC
          LIMIT ? OFFSET ?`,
      )
        .bind(pageSize + 1, offset)
        .all<StoryRow>();
```

`domainFilter` comes straight from `c.req.query('domain')` — fully
user-controlled, never sanitized. It's bound as `?1` and concatenated into
eight `LIKE` patterns. SQLite's `LIKE` treats `%` (any sequence) and `_`
(any single char) in **both** the pattern literal and any value
concatenated into it as wildcards — there is no automatic escaping for
bound parameters used this way.

The frontend (`public/index.html`) only ever sends real hostnames extracted
via `new URL(u).hostname`, which never contain `%`/`_`, so the UI path is
unaffected. This is purely an API-contract problem for direct callers.

D1 is SQLite-compatible and supports the standard `LIKE ... ESCAPE
'<char>'` clause, which makes the named escape character match itself
literally instead of acting as an escape trigger for `%`/`_` immediately
following it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm run typecheck` | exit 0, no errors |
| Local DB schema | `pnpm run schema:local` | exit 0 (idempotent, `CREATE TABLE IF NOT EXISTS`) |
| Run locally | `pnpm exec wrangler dev` | prints `Ready on http://127.0.0.1:8787` |
| Insert test rows (local D1, separate terminal while `wrangler dev` is running) | see Step 3 | exit 0 |

There is no test runner in this repo (`CLAUDE.md`: "`pnpm run typecheck` is
the only automated gate"). Verification here means manual `curl` checks
against `wrangler dev` with deterministic expected JSON, not a test
command — that matches how the prior domain-filter plan (`plans/003-...`)
was verified.

## Scope

**In scope** (the only file you should modify):
- `src/index.ts`

**Out of scope** (do NOT touch, even though related):
- `public/index.html` — the frontend never sends `%`/`_` in `domain`, no
  change needed there.
- The non-filtered query branch (lines 139-146) — it has no user input in
  the `LIKE`-adjacent path, nothing to escape.
- Anything about pagination, `page`, or the `meta`/`last_poll` query.

## Git workflow

- Branch: `advisor/004-domain-filter-like-escaping`
- Commit message style: short imperative title, then a 1-2 sentence body
  explaining what changed and why. Example from this repo's history
  (`git log` for commit `aa31cd2`):
  ```
  Add RSS feed endpoint at /feed.xml

  Exposes the 30 most recent qualifying stories as an RSS 2.0 feed, reusing
  the same stories query shape as /api/stories, and links it from the page
  head for feed-reader discovery.
  ```
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a LIKE-literal escaping helper

Add this function near the top of `src/index.ts`, right after the existing
`envNumber` helper (after line 21, before the `AlgoliaHit` interface):

```ts
// Escape SQLite LIKE metacharacters in a user-controlled value so '%' and
// '_' match themselves literally instead of acting as wildcards. Pair with
// `ESCAPE '\'` on every LIKE clause that binds the escaped value.
function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
```

**Verify**: `pnpm run typecheck` → exit 0, no errors.

### Step 2: Escape the bound value and add `ESCAPE` to every LIKE clause

In the `/api/stories` handler, replace the domain-filter branch so it binds
the escaped value and every `LIKE` has an `ESCAPE '\'` clause. Replace:

```ts
  const { results } = domainFilter
    ? await c.env.crest.prepare(
        `SELECT id, title, url, points, num_comments, hn_created, first_seen
           FROM stories
          WHERE (
            url LIKE 'http://' || ?1 OR url LIKE 'http://' || ?1 || '/%'
            OR url LIKE 'https://' || ?1 OR url LIKE 'https://' || ?1 || '/%'
            OR url LIKE 'http://www.' || ?1 OR url LIKE 'http://www.' || ?1 || '/%'
            OR url LIKE 'https://www.' || ?1 OR url LIKE 'https://www.' || ?1 || '/%'
          )
          ORDER BY first_seen DESC
          LIMIT ?2 OFFSET ?3`,
      )
        .bind(domainFilter, pageSize + 1, offset)
        .all<StoryRow>()
```

with:

```ts
  const { results } = domainFilter
    ? await c.env.crest.prepare(
        `SELECT id, title, url, points, num_comments, hn_created, first_seen
           FROM stories
          WHERE (
            url LIKE 'http://' || ?1 ESCAPE '\' OR url LIKE 'http://' || ?1 || '/%' ESCAPE '\'
            OR url LIKE 'https://' || ?1 ESCAPE '\' OR url LIKE 'https://' || ?1 || '/%' ESCAPE '\'
            OR url LIKE 'http://www.' || ?1 ESCAPE '\' OR url LIKE 'http://www.' || ?1 || '/%' ESCAPE '\'
            OR url LIKE 'https://www.' || ?1 ESCAPE '\' OR url LIKE 'https://www.' || ?1 || '/%' ESCAPE '\'
          )
          ORDER BY first_seen DESC
          LIMIT ?2 OFFSET ?3`,
      )
        .bind(escapeLikeLiteral(domainFilter), pageSize + 1, offset)
        .all<StoryRow>()
```

Only the bound `?1` value is escaped — the literal `'/%'` suffixes
hardcoded in the SQL string are intentional wildcards (they mean "or
anything under this path") and must NOT be escaped or changed.

**Verify**: `pnpm run typecheck` → exit 0, no errors.

### Step 3: Verify the fix against a local D1 instance

1. Start the dev server in one terminal: `pnpm exec wrangler dev` → wait
   for `Ready on http://127.0.0.1:8787`.
2. In a second terminal, insert two known rows into the local D1 so there's
   something to filter:
   ```bash
   pnpm exec wrangler d1 execute crest --local --command "INSERT OR IGNORE INTO stories (id, title, url, points, num_comments, author, hn_created, first_seen) VALUES (999001, 'Test story A', 'https://example.com/a', 200, 10, 'tester', 1700000000, 1700000000), (999002, 'Test story B', 'https://other.com/b', 200, 5, 'tester', 1700000000, 1700000000)"
   ```
   Expected: exit 0, output mentions 2 rows written.
3. Confirm normal filtering still works:
   ```bash
   curl -s "http://127.0.0.1:8787/api/stories?domain=example.com"
   ```
   Expected: JSON with `"stories"` containing exactly the `999001` row
   (title `"Test story A"`), not `999002`.
4. Confirm the bug is fixed — a literal `%` in `domain` must NOT act as a
   wildcard:
   ```bash
   curl -s "http://127.0.0.1:8787/api/stories?domain=%25"
   ```
   Expected: `"stories": []` (empty array) — no story's hostname is
   literally `%`. Before this fix, this returned both test rows (and in
   production, all 20 stories on the page).
5. Confirm `_` is also treated literally:
   ```bash
   curl -s "http://127.0.0.1:8787/api/stories?domain=exampl_.com"
   ```
   Expected: `"stories": []` — `_` must not match the `e` in `example.com`.
6. Stop `wrangler dev` (Ctrl+C in its terminal). The local D1 file under
   `.wrangler/` is gitignored; no cleanup of the test rows is required, but
   you may re-run `pnpm run schema:local` if you want a clean slate (it's
   `CREATE TABLE IF NOT EXISTS`, non-destructive — it will NOT remove the
   test rows; that's expected and fine).

## Test plan

This repo has no test runner (`pnpm run typecheck` is the only automated
gate, per `CLAUDE.md`). The manual `curl` checks in Step 3 are the
verification for this plan — there's no `*.test.ts` file to add. Do not
introduce a test framework as part of this plan; that's a separate,
unselected finding (see `plans/README.md`, "Findings considered and
rejected").

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] Step 3.3 (`domain=example.com`) returns only the `999001` test row
- [ ] Step 3.4 (`domain=%25`) returns `"stories": []`
- [ ] Step 3.5 (`domain=exampl_.com`) returns `"stories": []`
- [ ] `grep -n "ESCAPE" src/index.ts` shows 8 occurrences (one per LIKE clause)
- [ ] No files outside `src/index.ts` are modified (`git status`)
- [ ] `plans/README.md` status row for plan 004 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/index.ts:124-137` doesn't match the "Current state"
  excerpt above (the file has drifted since this plan was written).
- D1 rejects the `ESCAPE '\'` syntax (some SQLite builds require the
  escape character to be passed differently). If so, report the exact
  error — do not silently fall back to stripping `%`/`_` from the input
  instead, since that changes user-visible behavior (a domain containing
  those characters, however unlikely, would become unfilterable rather
  than filterable).
- `wrangler dev` fails to start for reasons unrelated to this change (e.g.
  missing D1 binding) — that's an environment problem, not something to
  fix as part of this plan.

## Maintenance notes

- Any future query that binds user input into a `LIKE` pattern must use
  `escapeLikeLiteral()` + `ESCAPE '\'` the same way — this is now the
  established pattern in this file, not a one-off.
- If the `domain` filter is ever extended to accept patterns with
  intentional wildcards (e.g. a future `*.example.com` syntax), that's a
  deliberate design change and should NOT reuse `escapeLikeLiteral()`
  as-is — it would need its own translation from "user wildcard syntax" to
  "SQL LIKE syntax."
- A reviewer should check that the live deployed site's `?domain=%25`
  behavior changes from "returns everything" to "returns nothing" after
  this ships (same curl check as Step 3.4, against the deployed URL).
