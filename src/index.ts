import { Hono } from 'hono';

export interface Env {
  crest: D1Database;
}

const SCORE_TARGET = 150; // points threshold
const WINDOW_DAYS = 7; // late-bloomer tolerance
const HITS_PER_PAGE = 1000; // must exceed qualifying stories in the window
const PAGE_SIZE = 20; // stories per page

interface AlgoliaHit {
  objectID: string;
  title: string | null;
  url: string | null;
  points: number | null;
  num_comments: number | null;
  author: string | null;
  created_at_i: number;
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
}

async function poll(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const floor = now - WINDOW_DAYS * 86400;

  const numericFilters = `points>${SCORE_TARGET},created_at_i>${floor}`;
  const url =
    `https://hn.algolia.com/api/v1/search_by_date` +
    `?tags=story` +
    `&numericFilters=${encodeURIComponent(numericFilters)}` +
    `&hitsPerPage=${HITS_PER_PAGE}`;

  const res = await fetch(url, { headers: { 'User-Agent': 'crest-worker' } });
  if (!res.ok) throw new Error(`Algolia request failed: ${res.status}`);

  const { hits } = (await res.json()) as AlgoliaResponse;

  // Record every successful check-in, even if nothing new qualified, so the
  // frontend can show "last checked" instead of looking stale between hits.
  await env.crest
    .prepare(`INSERT INTO meta (k, v) VALUES ('last_poll', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .bind(now)
    .run();

  const valid = hits.filter((h) => h.title && typeof h.points === 'number');
  if (valid.length === 0) return;

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

  const fresh = valid.filter((h) => !existingIds.has(Number(h.objectID)));
  if (fresh.length === 0) return;

  const insert = env.crest.prepare(
    `INSERT OR IGNORE INTO stories
      (id, title, url, points, num_comments, author, hn_created, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.crest.batch(
    fresh.map((h) =>
      insert.bind(
        Number(h.objectID),
        h.title,
        h.url ?? null,
        h.points ?? 0,
        h.num_comments ?? 0,
        h.author ?? null,
        h.created_at_i,
        now,
      ),
    ),
  );
}

const app = new Hono<{ Bindings: Env }>();

app.get('/api/stories', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Fetch one extra row to know if a next page exists, without a separate COUNT query.
  const { results } = await c.env.crest.prepare(
    `SELECT id, title, url, points, num_comments, hn_created, first_seen
       FROM stories
      ORDER BY first_seen DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(PAGE_SIZE + 1, offset)
    .all<{
      id: number;
      title: string;
      url: string | null;
      points: number;
      num_comments: number;
      hn_created: number;
      first_seen: number;
    }>();

  const hasMore = results.length > PAGE_SIZE;

  const lastPoll = await c.env.crest
    .prepare(`SELECT v FROM meta WHERE k = 'last_poll'`)
    .first<{ v: number }>();

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    stories: results.slice(0, PAGE_SIZE).map((r) => ({
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

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(poll(env));
  },
} satisfies ExportedHandler<Env>;
