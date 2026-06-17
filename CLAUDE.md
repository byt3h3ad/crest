# CLAUDE.md

Crest is a Hacker News hot-stories feed running on Cloudflare Workers. See
`README.md` for setup/deploy/tuning instructions, and `ARCHITECTURE.md` for
the original design rationale (note: some details there are stale — see
below).

This file is a short list of non-obvious, hard-won facts about this repo.
It is not a tutorial — keep it that way.

## Gotchas

1. **Always run `pnpm run deploy`, never bare `pnpm deploy`.** `pnpm deploy`
   is pnpm's own built-in workspace-deploy command and silently shadows this
   project's `deploy` script (`wrangler deploy`). The same caveat applies to
   any other script name that collides with a built-in pnpm command — always
   invoke project scripts as `pnpm run <script>`.

2. **The D1 binding is named `crest`, not `DB`.** Both `wrangler.toml`'s
   `[[d1_databases]]` binding and the `Env` interface in `src/index.ts` use
   `crest`. `ARCHITECTURE.md`'s original spec used `DB` — the binding was
   renamed during initial build-out, and `ARCHITECTURE.md` was deliberately
   left untouched as a historical document. Don't "fix" `Env.crest` back to
   `Env.DB` to match it.

3. **D1 caps bound parameters at 100 per statement.** This isn't mentioned
   in `ARCHITECTURE.md` at all. `poll()` in `src/index.ts` chunks the
   existing-ID lookup into batches of 100 ids per query (see the
   `existingIds` loop) for this reason. Any new query that binds a variable
   number of values (one per row/id) must chunk the same way.

4. **Schema changes need both environments.** After editing `schema.sql`,
   run both `pnpm run schema:local` (local D1, used by `wrangler dev`) and
   `pnpm run schema` (remote/deployed D1) — they are not synced
   automatically.

5. **`pnpm run typecheck` is the only automated gate.** There is no test
   suite and no CI in this repo today. Don't assume a `pnpm test` script
   exists.
