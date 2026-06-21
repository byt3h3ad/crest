import { Hono } from 'hono';

export interface Env {
  crest: D1Database;
  SCORE_TARGET?: string;
  WINDOW_DAYS?: string;
  HITS_PER_PAGE?: string;
  PAGE_SIZE?: string;
}

const DEFAULT_SCORE_TARGET = 150; // points threshold
const DEFAULT_WINDOW_DAYS = 7; // late-bloomer tolerance
const DEFAULT_HITS_PER_PAGE = 1000; // must exceed qualifying stories in the window
const DEFAULT_PAGE_SIZE = 20; // stories per page

// Vars arrive as strings (or unset); fall back to the default on unset or NaN.
function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

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

interface StoryRow {
  id: number;
  title: string;
  url: string | null;
  points: number;
  num_comments: number;
  hn_created: number;
  first_seen: number;
}

async function poll(env: Env): Promise<void> {
  const scoreTarget = envNumber(env.SCORE_TARGET, DEFAULT_SCORE_TARGET);
  const windowDays = envNumber(env.WINDOW_DAYS, DEFAULT_WINDOW_DAYS);
  const hitsPerPage = envNumber(env.HITS_PER_PAGE, DEFAULT_HITS_PER_PAGE);

  const now = Math.floor(Date.now() / 1000);
  const floor = now - windowDays * 86400;

  const numericFilters = `points>${scoreTarget},created_at_i>${floor}`;
  const url =
    `https://hn.algolia.com/api/v1/search_by_date` +
    `?tags=story` +
    `&numericFilters=${encodeURIComponent(numericFilters)}` +
    `&hitsPerPage=${hitsPerPage}`;

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
  const pageSize = envNumber(c.env.PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const offset = (page - 1) * pageSize;
  const domainFilter = c.req.query('domain');

  // Fetch one extra row to know if a next page exists, without a separate COUNT query.
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
    domain: domainFilter ?? null,
  });
});

const FEED_ITEM_LIMIT = 30; // fixed batch size for the RSS feed (no pagination)

// Escape XML special characters in user-controlled text before interpolating
// into the feed template.
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

app.get('/feed.xml', async (c) => {
  const { results } = await c.env.crest.prepare(
    `SELECT id, title, url, points, num_comments, hn_created, first_seen
       FROM stories
      ORDER BY first_seen DESC
      LIMIT ?`,
  )
    .bind(FEED_ITEM_LIMIT)
    .all<StoryRow>();

  const items = results
    .map((s) => {
      const hnUrl = `https://news.ycombinator.com/item?id=${s.id}`;
      const linkUrl = s.url || hnUrl;
      const pubDate = new Date(s.first_seen * 1000).toUTCString();
      return `    <item>
      <title>${escapeXml(s.title)}</title>
      <link>${escapeXml(linkUrl)}</link>
      <guid isPermaLink="false">crest-${s.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(`${s.points} points · ${s.num_comments} comments`)}</description>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Crest</title>
    <link>https://crest.byt3h3ad.workers.dev/</link>
    <description>Stories that crossed 150+ points, newest first.</description>
${items}
  </channel>
</rss>`;

  c.header('Cache-Control', 'public, max-age=300');
  return c.body(xml, 200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(poll(env));
  },
} satisfies ExportedHandler<Env>;
