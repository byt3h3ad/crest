# Plan 006: Deduplicate the story-row type between `/api/stories` and `/feed.xml`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 26117fd..HEAD -- src/index.ts`
> If `src/index.ts` changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on
> a mismatch (especially if the two row shapes have diverged), treat it as a
> STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `26117fd`, 2026-06-21

## Why this matters

`src/index.ts` defines the same story-row shape twice, as two separate
anonymous/local TypeScript types, once for the `/api/stories` handler and
once for `/feed.xml`. Both `SELECT` statements already select the exact
same seven columns in the exact same order. This is harmless today, but
it's a duplication that will silently drift if a column is ever added to
one query and not the other — the type checker won't catch the mismatch
because the two types aren't related. Extracting one shared type removes
that risk and makes the file's intent ("there is one story-row shape this
file deals with") explicit.

## Current state

`src/index.ts` has two independent definitions of the same shape:

1. Inside the `/api/stories` handler (`src/index.ts:113-122`):
   ```ts
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
   ```

2. Inline as a generic-type-argument object literal in the `/feed.xml`
   handler (`src/index.ts:192-201`):
   ```ts
     .bind(FEED_ITEM_LIMIT)
     .all<{
       id: number;
       title: string;
       url: string | null;
       points: number;
       num_comments: number;
       hn_created: number;
       first_seen: number;
     }>();
   ```

Both `SELECT` statements (lines 126-127 and 187-188) select exactly:
`id, title, url, points, num_comments, hn_created, first_seen` — same
columns, same order. The shapes are identical today.

The file already declares module-level interfaces for the Algolia response
shape (`AlgoliaHit`, `AlgoliaResponse`, lines 23-35) above the `poll()`
function — that's the existing convention for "shared row shape used by
more than one place in this file." Follow it.

## Scope

**In scope** (the only file you should modify):
- `src/index.ts`

**Out of scope** (do NOT touch):
- `public/index.html` — it consumes the JSON/XML over the wire, not the
  TypeScript type; no change needed there.
- The actual SQL `SELECT` column lists — do not add, remove, or reorder
  columns as part of this refactor. If you find a reason they should
  differ, that's a STOP condition (see below), not something to silently
  "fix" while you're in there.

## Git workflow

- Branch: `advisor/006-dedupe-story-row-type`
- Commit message style: short imperative title, optional 1-2 sentence body.
  Example from this repo's history (`git log` for commit `7eaada1`):
  ```
  Add clickable domain filter to the stories feed
  ```
  (a single-line message is also acceptable for a small mechanical change
  like this one).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a shared `StoryRow` interface

Add this interface at module level, directly after the `AlgoliaResponse`
interface (after line 35, before `async function poll`):

```ts
interface StoryRow {
  id: number;
  title: string;
  url: string | null;
  points: number;
  num_comments: number;
  hn_created: number;
  first_seen: number;
}
```

**Verify**: `pnpm run typecheck` → exit 0 (the old local `StoryRow` type
inside the `/api/stories` handler still shadows this one at this point —
that's expected until Step 2).

### Step 2: Remove the local `StoryRow` type from `/api/stories`

In the `/api/stories` handler, delete this block (`src/index.ts:113-122`):

```ts
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

```

Keep the comment `// Fetch one extra row to know if a next page exists,
without a separate COUNT query.` — move it to sit directly above the
`domainFilter ? ... : ...` query block it actually describes, since that
comment is about the pagination technique, not the type definition. The
handler's two `.all<StoryRow>()` calls (in both the domain-filter and
non-filter query branches) now resolve to the module-level interface from
Step 1 — no other change needed there.

**Verify**: `pnpm run typecheck` → exit 0, no errors.

### Step 3: Use the shared type in `/feed.xml`

In the `/feed.xml` handler, replace the inline object-literal type
argument (`src/index.ts:192-201`):

```ts
    .bind(FEED_ITEM_LIMIT)
    .all<{
      id: number;
      title: string;
      url: string | null;
      points: number;
      num_comments: number;
      hn_created: number;
      first_seen: number;
    }>();
```

with:

```ts
    .bind(FEED_ITEM_LIMIT)
    .all<StoryRow>();
```

**Verify**: `pnpm run typecheck` → exit 0, no errors.

## Test plan

This repo has no test runner; this is a type-level refactor with no
behavior change. `pnpm run typecheck` passing, plus the runtime smoke
check in Step 4, is the verification — there's nothing to add to a test
suite that doesn't exist.

### Step 4: Runtime smoke check

Behavior must be byte-for-byte identical before and after this change
(it's a pure type refactor, the SQL and JSON/XML output are untouched).
Confirm both endpoints still respond correctly:

```bash
pnpm exec wrangler dev &
sleep 2
curl -s "http://127.0.0.1:8787/api/stories" | head -c 200
curl -s "http://127.0.0.1:8787/feed.xml" | head -c 200
```

Expected: both return valid responses in the same shape as before this
change (JSON with a `stories` array; XML starting with
`<?xml version="1.0"`). Stop `wrangler dev` afterward.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `grep -n "interface StoryRow" src/index.ts` → exactly one match
- [ ] `grep -n "type StoryRow" src/index.ts` → no matches (the old local
      `type` alias is gone, replaced by the module-level `interface`)
- [ ] `grep -c "\.all<StoryRow>()" src/index.ts` → 3 (the two `/api/stories`
      query branches plus `/feed.xml`)
- [ ] Step 4's two `curl` checks both succeed
- [ ] No files other than `src/index.ts` are modified (`git status`)
- [ ] `plans/README.md` status row for plan 006 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The two `SELECT` statements' column lists have diverged from each other
  (i.e. they no longer select the same seven columns in the same order) —
  that means the shapes are no longer actually identical, and unifying the
  type would be incorrect. Report this rather than forcing one shape onto
  both queries.
- `pnpm run typecheck` fails after Step 2 or Step 3 in a way not explained
  by a simple import/visibility issue.

## Maintenance notes

- Any future endpoint that selects this same column set should reuse the
  `StoryRow` interface rather than redefining it a third time.
- If `/api/stories` and `/feed.xml` ever need genuinely different fields
  (e.g. `/feed.xml` adding an `author` byline), that's a legitimate reason
  to split the type again — don't force divergent needs into one shared
  shape just because this plan unified them.
