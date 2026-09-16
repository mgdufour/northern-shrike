/*
 * Northern Shrike catalog-refresh Worker.
 *
 * Read-only now. This used to also own the CelesTrak ingest job (a scheduled() handler
 * firing on a Cron Trigger), but every ingest attempt from here failed with a 522
 * (Cloudflare's "origin never responded") on every single CelesTrak group, consistently,
 * for 24+ hours straight — while CelesTrak loaded fine from a normal browser on a
 * different network the whole time. Switching the fetches from concurrent to sequential
 * made zero difference (still 100% failure), which rules out a request-burst/rate-limit
 * explanation and points at something blocking or badly timing out Cloudflare Workers'
 * shared egress IP range specifically — not fixable by anything this Worker does.
 *
 * The ingest job now lives in .github/workflows/catalog-ingest.yml +
 * .github/scripts/ingest-catalog.mjs, running on GitHub Actions' own runners (a
 * different IP range) and writing to this same D1 database via its REST API instead of
 * the in-Worker binding used here. This file's only remaining job is serving reads:
 *   GET /catalog          — latest TLE snapshot per object, shaped to match the
 *                            frontend's RAW_OBJECTS array
 *   GET /maneuvers?days=N — objects whose inclination jumped between consecutive TLEs
 *                            within the window
 *   GET /decay-watch?days=N — objects ranked by how fast their mean motion is climbing
 *                            over that window (a trend-based decay signal)
 *   GET /ingest-status    — the last few ingest runs (now written by the GitHub Actions
 *                            job instead of this Worker, but the same ingest_runs table)
 *
 * Deploy: see DEPLOY.md. Requires a D1 binding named DB (schema.sql). No Cron Trigger
 * needed anymore — remove it from this Worker's Settings -> Triggers if one is still
 * configured from before.
 */

const ALLOWED_ORIGIN = 'https://mgdufour.github.io';

function corsHeaders(origin){
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

async function serveCatalog(db){
  const { results } = await db.prepare(`
    SELECT t.norad_id, t.name, t.category, t.owner_code, t.line1, t.line2 FROM tle_history t
    INNER JOIN (SELECT norad_id, MAX(fetched_at) AS max_fetched FROM tle_history GROUP BY norad_id) m
      ON t.norad_id = m.norad_id AND t.fetched_at = m.max_fetched
  `).all();
  // Shaped to match RAW_OBJECTS entries (index.html): { n, l1, l2, c, o }.
  return results.map(r => ({ n: r.name, l1: r.line1, l2: r.line2, c: r.category, o: r.owner_code }));
}

// Flags objects whose inclination jumped between two consecutive stored TLEs within
// the lookback window. Inclination is the signal, not mean motion, because ordinary
// atmospheric drag changes mean motion continuously but does not change inclination —
// an inclination jump is a much cleaner "something happened" signal than a mean-motion
// change, which normal orbital decay produces on its own without any maneuver at all.
// INCLINATION_JUMP_THRESHOLD_DEG is a starting-point heuristic, not a validated
// detector — tune it once real history accumulates and you can see what ordinary
// fit-to-fit noise looks like for objects that are NOT maneuvering.
const INCLINATION_JUMP_THRESHOLD_DEG = 0.05;

async function serveManeuvers(db, days){
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await db.prepare(
    'SELECT norad_id, name, category, inclination_deg, mean_motion, fetched_at FROM tle_history WHERE fetched_at >= ? ORDER BY norad_id, fetched_at ASC'
  ).bind(cutoff).all();

  const byObject = new Map();
  for (const row of results){
    if (!byObject.has(row.norad_id)) byObject.set(row.norad_id, []);
    byObject.get(row.norad_id).push(row);
  }

  const flagged = [];
  for (const [noradId, rows] of byObject){
    for (let i = 1; i < rows.length; i++){
      const deltaIncl = Math.abs(rows[i].inclination_deg - rows[i - 1].inclination_deg);
      if (deltaIncl >= INCLINATION_JUMP_THRESHOLD_DEG){
        flagged.push({
          noradId, name: rows[i].name, category: rows[i].category,
          inclinationBeforeDeg: rows[i - 1].inclination_deg, inclinationAfterDeg: rows[i].inclination_deg,
          deltaInclinationDeg: +deltaIncl.toFixed(4),
          meanMotionBefore: rows[i - 1].mean_motion, meanMotionAfter: rows[i].mean_motion,
          observedBetween: [rows[i - 1].fetched_at, rows[i].fetched_at],
        });
      }
    }
  }
  flagged.sort((a, b) => b.deltaInclinationDeg - a.deltaInclinationDeg);
  return flagged;
}

// Ranks objects by how fast their mean motion is climbing over the lookback window —
// mean motion (revs/day) rises as an orbit's altitude drops, because a smaller orbit
// has a shorter period (Kepler's third law), so a sustained upward trend is a real
// decay signal, not just noise like a single day-to-day wobble would be. This is a
// meaningfully stronger read than estimateDecayRisk's single-snapshot perigee+BSTAR
// guess (index.html) because it's derived from what the object's orbit has actually
// been doing over time, not a guess from today's elements alone.
//
// Deliberately NOT filtered to a "flagged" subset the way serveManeuvers() is: every
// orbiting object has *some* drag-driven trend, so there's no natural jump/no-jump
// threshold the way there is for a sudden inclination change. Instead this returns
// every object with enough history, ranked steepest-climbing first, and leaves capping
// to a top-N to the caller (matches listCloseApproaches/topConcerns in index.html).
// DECAY_WATCH_MIN_DAYS_SPAN guards against a same-day refetch registering as a
// "trend" from pure fit-to-fit noise rather than real multi-day movement.
const DECAY_WATCH_MIN_DAYS_SPAN = 1;

async function serveDecayWatch(db, days){
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await db.prepare(
    'SELECT norad_id, name, category, mean_motion, fetched_at FROM tle_history WHERE fetched_at >= ? ORDER BY norad_id, fetched_at ASC'
  ).bind(cutoff).all();

  const byObject = new Map();
  for (const row of results){
    if (!byObject.has(row.norad_id)) byObject.set(row.norad_id, []);
    byObject.get(row.norad_id).push(row);
  }

  const ranked = [];
  for (const [noradId, rows] of byObject){
    if (rows.length < 2) continue; // need at least two observations to compute any trend at all
    const first = rows[0], last = rows[rows.length - 1];
    const daysSpan = (new Date(last.fetched_at).getTime() - new Date(first.fetched_at).getTime()) / 86400000;
    if (daysSpan < DECAY_WATCH_MIN_DAYS_SPAN) continue;
    const meanMotionTrendPerDay = (last.mean_motion - first.mean_motion) / daysSpan;
    ranked.push({
      noradId, name: last.name, category: last.category,
      meanMotionTrendPerDay: +meanMotionTrendPerDay.toFixed(6),
      meanMotionNow: last.mean_motion,
      observationCount: rows.length,
      observedOverDays: +daysSpan.toFixed(1),
      firstObservedAt: first.fetched_at, lastObservedAt: last.fetched_at,
    });
  }
  ranked.sort((a, b) => b.meanMotionTrendPerDay - a.meanMotionTrendPerDay);
  return ranked;
}

// Named exports exist only so a test harness can call these directly — Cloudflare
// Workers only ever invoke the default export below, so this has no runtime effect.
export { serveCatalog, serveManeuvers, serveDecayWatch };

export default {
  async fetch(request, env){
    const origin = request.headers.get('Origin') || '';
    const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const url = new URL(request.url);
    try{
      if (url.pathname === '/catalog'){
        return new Response(JSON.stringify(await serveCatalog(env.DB)), { headers });
      }
      if (url.pathname === '/maneuvers'){
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 90);
        return new Response(JSON.stringify(await serveManeuvers(env.DB, days)), { headers });
      }
      if (url.pathname === '/decay-watch'){
        // Default window is longer than /maneuvers' (30d vs 7d): a mean-motion trend
        // needs more separation between observations to mean anything, where an
        // inclination jump is visible between any two consecutive TLEs.
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 180);
        return new Response(JSON.stringify(await serveDecayWatch(env.DB, days)), { headers });
      }
      if (url.pathname === '/ingest-status'){
        const { results } = await env.DB.prepare('SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 5').all();
        return new Response(JSON.stringify(results), { headers });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
    } catch(e){
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  },
};
