# Plan 001: Add a CLAUDE.md capturing this repo's agent-session gotchas

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c37464c..HEAD -- src/index.ts wrangler.toml README.md ARCHITECTURE.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on
> a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `c37464c`, 2026-06-18

## Why this matters

This repo is built and maintained almost entirely by Claude Code sessions, each starting with zero memory of the last. In the two sessions that built this repo so far, two non-obvious facts had to be rediscovered the hard way: (1) the D1 binding in `wrangler.toml` is named `crest`, not the `DB` name used throughout the original build brief (`ARCHITECTURE.md`), and (2) D1 caps bound parameters at 100 per statement, which isn't mentioned in `ARCHITECTURE.md` at all and forced a deviation from its literal spec (chunking the existing-ID lookup in `poll()`). A short `CLAUDE.md` stating these facts up front saves the next session from re-deriving them from error messages, and gives it the one fact it needs before touching `package.json`'s scripts: `pnpm deploy` is a *built-in pnpm command* that silently shadows the `deploy` script, so it must always be invoked as `pnpm run deploy`.

## Current state

- `ARCHITECTURE.md` (repo root) — the original build brief. Still says `binding = "DB"` in its `wrangler.toml` spec (§6.3) and `Env.DB` in its `src/index.ts` spec (§6.6). This is intentionally left as a historical document — do not edit it as part of this plan.
- `README.md` (repo root) — user-facing setup/deploy/tuning docs. Does not mention binding names or D1 limits at all (it's written for a human running the repo, not an agent extending it).
- `wrangler.toml:13-16` (current, actual):
  ```toml
  [[d1_databases]]
  binding = "crest"
  database_name = "crest"
  database_id = "d7b01de9-212d-43e5-9334-b0ad707809df"
  ```
- `src/index.ts:1-9` (current, actual):
  ```ts
  import { Hono } from 'hono';

  export interface Env {
    crest: D1Database;
    SCORE_TARGET?: string;
    WINDOW_DAYS?: string;
    HITS_PER_PAGE?: string;
    PAGE_SIZE?: string;
  }
  ```
- `src/index.ts:68-79` (current, actual) — the D1 100-bound-parameter chunking, not documented anywhere else in the repo:
  ```ts
  const ids = valid.map((h) => Number(h.objectID));
  const existingIds = new Set<number>();
  // D1 caps bound parameters at 100 per statement, so chunk the lookup.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(', ');
    const existing = await env.crest.prepare(
      `SELECT id FROM stories WHERE id IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<{ id: number }>();
    for (const r of existing.results) existingIds.add(r.id);
  }
  ```
- `package.json:5-11` (current, actual):
  ```json
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "schema": "wrangler d1 execute crest --remote --file=./schema.sql",
    "schema:local": "wrangler d1 execute crest --local --file=./schema.sql"
  },
  ```

There is no existing `CLAUDE.md`/`AGENTS.md` anywhere in the repo to use as a pattern — this is a new file.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|---------------------------|---------------------|
| Typecheck | `pnpm run typecheck`      | exit 0, no errors (this plan touches no `.ts`, so this just confirms nothing else broke) |

## Scope

**In scope** (the only file you should create):
- `CLAUDE.md` (repo root, new file)

**Out of scope** (do NOT touch, even though they look related):
- `ARCHITECTURE.md` — historical build brief, intentionally left as-is even though some of its bindings/constants are stale (it documents the *original* spec, not current state).
- `README.md` — user-facing docs; don't duplicate `CLAUDE.md` content into it or vice versa, they serve different audiences.
- Any source file under `src/` or `public/` — this plan is documentation-only.

## Git workflow

- Branch: `advisor/001-claude-md` (no existing branch-naming convention in this repo's 2-commit history, so this is a reasonable default)
- Single commit, message style matching the repo's existing commits (imperative, no prefix tag): e.g. `Add CLAUDE.md with agent-session gotchas`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write `CLAUDE.md`

Create `CLAUDE.md` at the repo root with the following sections. Keep it short — this is a gotchas file, not a tutorial (that's what `README.md` and `ARCHITECTURE.md` are for).

Required content (adapt wording, keep all facts):

1. **One-line project description** — a Hacker News hot-stories feed on Cloudflare Workers; point to `README.md` for setup/deploy and `ARCHITECTURE.md` for the original design rationale.
2. **`pnpm run deploy`, never bare `pnpm deploy`** — state that `pnpm deploy` is pnpm's own built-in workspace-deploy command and silently shadows the project's `deploy` script. Same caveat applies to any other script name that collides with a built-in pnpm command — always use `pnpm run <script>`.
3. **D1 binding is named `crest`, not `DB`** — `wrangler.toml`'s `[[d1_databases]]` binding and `Env` in `src/index.ts` both use `crest`. Note that `ARCHITECTURE.md`'s original spec used `DB`; the binding was renamed during initial build-out and `ARCHITECTURE.md` was deliberately left untouched as a historical document, so don't "fix" `Env.crest` back to `Env.DB` to match it.
4. **D1 caps bound parameters at 100 per statement** — not mentioned in `ARCHITECTURE.md`. `poll()` in `src/index.ts` chunks the existing-ID lookup into batches of 100 ids per query for this reason (see `src/index.ts` around the `existingIds` loop). Any new query that binds a variable number of values (one per row/id) must chunk the same way.
5. **Schema changes need both environments** — `pnpm run schema:local` (local D1, used by `wrangler dev`) and `pnpm run schema` (remote/deployed D1) must both be run after editing `schema.sql`; they are not synced automatically.
6. **Verification command** — `pnpm run typecheck` is the only automated gate in this repo today (no test suite, no CI). State that plainly so an agent doesn't assume a `pnpm test` exists.

**Verify**: `pnpm run typecheck` → exit 0 (confirms the repo's only gate is unaffected by adding a doc file).

## Test plan

No code changes, so no new tests. This plan's only verification is the typecheck command above plus the done criteria below.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `CLAUDE.md` exists at the repo root and contains all six points listed in Step 1.
- [ ] `pnpm run typecheck` exits 0.
- [ ] `git status` shows only `CLAUDE.md` added — no other files modified.
- [ ] `plans/README.md` status row for plan 001 updated to DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- The binding in `wrangler.toml` is no longer `crest` (e.g. someone renamed it again) — the excerpt in "Current state" no longer matches reality, so re-verify before writing fact #3.
- The chunking loop in `src/index.ts` no longer exists or no longer chunks at 100 — re-verify fact #4 against the live code before writing it.
- You're tempted to add content beyond the six points above ("while I'm here, document the whole architecture") — this file is intentionally a gotchas list, not a second `ARCHITECTURE.md`. Stop and keep it short instead.

## Maintenance notes

- Whoever adds the next non-obvious, hard-won fact about this repo (a new free-tier limit discovered the hard way, another naming mismatch, etc.) should append it here rather than letting the next session rediscover it.
- If `ARCHITECTURE.md` is ever updated to match current reality (e.g. binding renamed in the spec too), re-check whether fact #3 is still needed.
