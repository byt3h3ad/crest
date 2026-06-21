# Plan 005: Document `/feed.xml` and the `domain` filter in README

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 26117fd..HEAD -- README.md src/index.ts`
> If `src/index.ts` changed since this plan was written, re-read the
> `/api/stories` and `/feed.xml` handlers before writing docs for them — the
> behavior described below must match the live code, not this plan.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `26117fd`, 2026-06-21

## Why this matters

`README.md` documents setup, deploy, local dev, and the `[vars]` tuning
knobs, but never mentions that `GET /api/stories` accepts an optional
`domain` query parameter (shipped in `plans/003-domain-filter.md`, DONE) or
that `GET /feed.xml` exists at all (shipped in `plans/002-rss-feed.md`,
DONE). `ARCHITECTURE.md` mentions `domain` only in passing as part of the
frontend's JS helper description, and is explicitly maintained as a stale
historical document per `CLAUDE.md` gotcha #2 — it is not a substitute for
README coverage. Anyone (human or agent) reading only the README today
would not know either endpoint exists.

## Current state

`README.md` (52 lines total) has these sections, in order: title/intro,
"Setup & deploy", "Local development", "Tuning" (a table of `[vars]`), and
"`first_seen` semantics". There is no "API" or "Endpoints" section.

The two behaviors to document, as implemented today in `src/index.ts`:

- `GET /api/stories?page=<n>&domain=<hostname>` (`src/index.ts:107-170`):
  returns JSON `{ stories, page, hasMore, lastPolled, domain }`. `page`
  defaults to 1. `domain` is optional; when present, it filters to stories
  whose `url` hostname matches `domain` (with or without a `www.` prefix,
  exact host or any path under it) — see the `LIKE` clauses at
  `src/index.ts:124-137`. Response includes `Cache-Control: public,
  max-age=300`.
- `GET /feed.xml` (`src/index.ts:185-230`): returns an RSS 2.0 XML feed of
  the 30 most recent qualifying stories (`FEED_ITEM_LIMIT = 30`, no
  pagination), `Content-Type: application/rss+xml`. Linked from
  `public/index.html`'s `<head>` via
  `<link rel="alternate" type="application/rss+xml" ...>` for feed-reader
  auto-discovery.

The existing "Tuning" table in `README.md` (current full content):

```markdown
## Tuning

Set in `wrangler.toml`'s `[vars]` block (or the Cloudflare dashboard); removing a var falls back to its default below.

| Var | Meaning | Default |
| --- | --- | --- |
| `SCORE_TARGET` | Points threshold for inclusion | 150 |
| `WINDOW_DAYS` | How late a bloomer is still caught | 7 |
| `HITS_PER_PAGE` | Must exceed qualifying stories in the window | 1000 |
| `PAGE_SIZE` | Stories per page, API and frontend | 20 |

## `first_seen` semantics
```

Match this repo's README style: short prose paragraphs, occasional
Markdown tables, `##` section headers, backtick-quoted code/identifiers, no
nested bullet trees.

## Scope

**In scope** (the only file you should modify):
- `README.md`

**Out of scope** (do NOT touch):
- `ARCHITECTURE.md` — deliberately stale per `CLAUDE.md` gotcha #2, never
  "fix" or "sync" it.
- `src/index.ts`, `public/index.html` — no code changes in this plan.

## Git workflow

- Branch: `advisor/005-readme-endpoint-docs`
- Commit message style: short imperative title, optional 1-2 sentence body.
  Example from this repo's history (`git log` for commit `aa31cd2`):
  ```
  Add RSS feed endpoint at /feed.xml

  Exposes the 30 most recent qualifying stories as an RSS 2.0 feed, reusing
  the same stories query shape as /api/stories, and links it from the page
  head for feed-reader discovery.
  ```
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add an "Endpoints" section to README.md

Insert a new `## Endpoints` section between the existing "Local development"
section and the "Tuning" section. Suggested content (adjust wording to fit
the surrounding tone, but keep both endpoints and the example requests):

```markdown
## Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/stories?page=<n>&domain=<host>` | JSON: `{ stories, page, hasMore, lastPolled, domain }`. `page` defaults to 1. `domain` is optional and filters to stories hosted on that domain (with or without `www.`). |
| `GET /feed.xml` | RSS 2.0 feed of the 30 most recent qualifying stories. Linked from the page `<head>` for feed-reader auto-discovery. |

Both responses are cached for 5 minutes (`Cache-Control: public, max-age=300`).
```

**Verify**: `grep -n "## Endpoints" README.md` → one match.

### Step 2: Cross-check against the live behavior

Confirm the documented shape matches reality:

```bash
curl -s "https://hn.adhiraj.rocks/api/stories" | head -c 300
curl -s "https://hn.adhiraj.rocks/feed.xml" | head -c 300
```

Expected: the JSON response contains the keys `stories`, `page`, `hasMore`,
`lastPolled`, `domain`; the feed response starts with
`<?xml version="1.0" encoding="UTF-8"?>` and contains `<rss version="2.0">`.
If either disagrees with what you wrote in Step 1, fix the README to match
the live response, not the other way around.

## Test plan

This is a documentation-only change; there is no test runner in this repo
to extend. Step 2's `curl` checks are the verification.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "## Endpoints" README.md` → one match
- [ ] `grep -n "feed.xml" README.md` → at least one match
- [ ] `grep -n "domain" README.md` → at least one match
- [ ] Step 2's two `curl` checks both succeed and match the documented shape
- [ ] No files other than `README.md` are modified (`git status`)
- [ ] `plans/README.md` status row for plan 005 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The live `/api/stories` or `/feed.xml` response shape (Step 2) disagrees
  with the "Current state" section above in a way you can't resolve by
  just updating the wording (e.g. a field is missing entirely) — that
  suggests the code changed since this plan was written; report it rather
  than guessing at new behavior.

## Maintenance notes

- If plan 004 (LIKE-escaping fix) lands first or is in flight, it does not
  change the documented request/response shape for `domain` — no
  coordination needed between these two plans.
- Future endpoint additions should extend this same "Endpoints" table
  rather than starting a new section.
