# RCA 007: Poller outage — Algolia dropped `points` as a filterable attribute

- **Date of incident**: 2026-07-08 17:50 UTC – 2026-07-09 07:30 UTC (~13h40m)
- **Detected**: 2026-07-09, via Cloudflare dashboard showing errors and no
  feed updates for 13 hours (user-reported; no automated alerting exists —
  see Follow-ups)
- **Resolved (workaround)**: 2026-07-09 07:26 UTC (deploy), verified live at
  07:30 UTC
- **Resolved (fully, upstream fixed)**: 2026-07-13, workaround reverted in
  `f973b8f` — see Update below
- **Fix commit**: `7da3c25` — "Fix poller outage: Algolia dropped points as
  a filterable attribute"
- **Severity**: feed stopped updating; no data loss, no user-facing errors
  (stale cached page kept serving)

## Summary

`hn.algolia.com`'s `search_by_date` endpoint began rejecting the poller's
`numericFilters=points>150` clause with `HTTP 400` sometime between
2026-07-08 17:50 UTC and 18:00 UTC. This was an undocumented, upstream
index-config change on Algolia/HN's side, not caused by any deploy of ours
(last prior deploy was 2026-07-01, and polling worked correctly for a full
week after that). Because `scheduled()` has no try/catch around `poll()`,
every cron tick after the break threw an unhandled error — populating the
Cloudflare dashboard's error count every 10 minutes for ~13.5 hours — and
because the error was thrown before the `meta` table check-in write, the
feed's "last checked" timestamp froze along with the data.

## Root cause

`poll()` (`src/index.ts:60`) built its Algolia query as:

```
https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points>150,created_at_i>{floor}&hitsPerPage=1000
```

As of 2026-07-08, this now returns:

```json
{"code":400,"message":"invalid numeric attribute(points), attribute not specified in numericAttributesForFiltering setting"}
```

Isolating the two `numericFilters` clauses confirmed `created_at_i` alone
still works (200) and `points` alone fails (400) — Algolia's index config
for this dataset no longer lists `points` in
`numericAttributesForFiltering`. No changelog, status page, or announcement
records this. The one place it would normally be tracked —
[`algolia/hn-search`](https://github.com/algolia/hn-search) on GitHub — was
archived (read-only) on 2026-02-10, five months before this broke, so
there's no live channel to report it to (see prior conversation; not
pursued further).

`src/index.ts:80` — `if (!res.ok) throw new Error(...)` — threw on every
poll from that point on, and `scheduled()` (`src/index.ts:243`) passes the
rejecting promise straight to `ctx.waitUntil()` with no handling, so the
error surfaced as a scheduled-event failure in the Cloudflare dashboard
every 10 minutes.

## Detection

D1 timestamps pinpointed the exact failure window:
- `stories.first_seen` (max): 2026-07-08 17:10:26 UTC (last story actually
  inserted)
- `meta.last_poll` (written on *every* successful check-in, even
  no-op ones): 2026-07-08 17:50:26 UTC (last successful run of any kind)
- Both frozen until the fix deployed — confirming the failure was a hard
  throw on every subsequent tick, not merely "no new qualifying stories."

D1/account-level checks ruled out other causes: D1 usage (84 writes/24h,
197 kB) was nowhere near free-tier quota; the worker's last deploy predated
the break by a week; wrangler auth/account were healthy.

## Fix

1. Dropped `points>{threshold}` from the Algolia `numericFilters` string —
   query by `created_at_i` only.
2. Apply the score threshold client-side instead, filtering the returned
   hits on the `points` field each hit still carries
   (`src/index.ts` `valid` filter).
3. Reduced `WINDOW_DAYS` default from `7` to `1` (see below for why).

Deployed via `pnpm run deploy` at 2026-07-09 07:26 UTC. Verified live: a
`wrangler tail` session caught the 07:30 UTC cron tick returning `Ok`, and
`meta.last_poll` advanced from `1783533026` to `1783582231`
(2026-07-08 17:50 UTC → 2026-07-09 07:30 UTC).

## Update 2026-07-13: upstream restored, workaround reverted

Confirmed via direct `curl` that `hn.algolia.com/api/v1/search_by_date` once
again accepts `numericFilters=points>150,created_at_i>{floor}` (`HTTP 200`,
was `400` since 2026-07-08). Algolia silently restored `points` to
`numericAttributesForFiltering` — no announcement, same as when it broke.

Reverted the workaround in full (commit `f973b8f`): server-side
`points>{threshold}` filtering restored, client-side score filter removed,
`WINDOW_DAYS` default back to `7`. Deployed and verified live — a
`wrangler tail` session caught the next cron tick returning `Ok`, and
`meta.last_poll` advanced to match (2026-07-13 17:40:38 UTC), with no `400`s.

The "known limitation" and its `WINDOW_DAYS`/1000-hit-cap consequence below
no longer apply as of this revert — left in place as a historical record of
what the workaround cost while it was active. Same for the Firebase
follow-up in the section after: it was scoped as a fix for that limitation,
so it's moot until/unless `points` filtering breaks again.

## Known limitation (accepted, not further fixed)

Algolia hard-caps `search_by_date` at 1000 total hits with no working
pagination past that — requesting `page=1` on an already-1000-hit query
returns `{"hits":[],"nbHits":0,"message":"you can only fetch the 1000 hits
for this query..."}` (matches
[algolia/hn-search#230](https://github.com/algolia/hn-search/issues/230)).

Previously, the `points>150` filter kept the result set small enough
(qualifying stories only) that 1000 hits comfortably covered the full
7-day `WINDOW_DAYS`. Without server-side score filtering, the query now
returns *all* stories regardless of score — measured at 6,668 stories in a
7-day window on 2026-07-09 — so the 1000-hit cap only reaches back **~20
hours**, not 7 days, regardless of `WINDOW_DAYS`'s configured value.

Rather than leave `WINDOW_DAYS=7` implying a guarantee the code can no
longer deliver, its default was lowered to `1` to reflect what the window
actually achieves today. This is a real behavior reduction: a story that
takes longer than ~20h to cross the score threshold will no longer be
caught as a "late bloomer." Accepted as-is; not addressed further this
round.

## Follow-ups considered, not actioned

- **Restore full late-bloomer coverage** by switching the data source to
  Firebase's `beststories.json` (already ranked by score, sidesteps the
  Algolia filtering/cap issue entirely) — bigger change, adds per-item
  `fetch` calls; not pursued this round.
- **No alerting on repeated scheduled-event failures** — this outage was
  caught by a human noticing the dashboard, ~13.5 hours after the first
  failed tick. There's no automated notification today (consistent with
  `CLAUDE.md`: typecheck is the only automated gate, no CI/test suite).
  Worth a plan if this class of silent-cron-failure recurs.
