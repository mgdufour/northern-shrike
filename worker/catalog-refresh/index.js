/*
 * Northern Shrike catalog-refresh Worker.
 *
 * Separate from the Copilot proxy worker (worker/index.js) — this one owns a D1
 * binding and has two jobs:
 *   1. scheduled(): on a Cron Trigger, pull the tracked-object catalog from CelesTrak
 *      per category group and insert a new tle_history row for any object whose TLE
 *      changed since the last time it was seen (see schema.sql).
 *   2. fetch(): serves GET /catalog (latest snapshot per object, shaped to match the
 *      frontend's RAW_OBJECTS array), GET /maneuvers?days=N (objects whose inclination
 *      jumped between consecutive TLEs within the window), GET /decay-watch?days=N
 *      (objects ranked by how fast their mean motion is climbing over that window — a
 *      trend-based decay signal, stronger than a single-snapshot perigee/drag guess),
 *      and GET /ingest-status (the last few cron runs, for checking the job is
 *      actually healthy).
 *
 * Deploy: see DEPLOY.md. Requires a D1 binding named DB (schema.sql) and a Cron Trigger.
 */

// CelesTrak GROUP ids mapped to the frontend's category ids (index.html: const CATS).
// GROUP values are CelesTrak's documented group names for gp.php.
const CELESTRAK_GROUPS = [
  { group: 'stations', category: 'station' },
  { group: 'gps-ops', category: 'navigation' },
  { group: 'galileo', category: 'navigation' },
  { group: 'glo-ops', category: 'navigation' },
  { group: 'geo', category: 'geo-comm' },
  { group: 'weather', category: 'weather' },
  { group: 'science', category: 'science' },
  { group: 'starlink', category: 'starlink' },
  { group: 'cubesat', category: 'cubesat' },
];

const ALLOWED_ORIGIN = 'https://mgdufour.github.io';

function corsHeaders(origin){
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

// Standard fixed-column TLE line-2 parsing (NORAD two-line element format) — the same
// column convention index.html already relies on elsewhere (e.g. NORAD ID from line 1).
function parseInclinationDeg(line2){ return parseFloat(line2.slice(8, 16)); }
function parseMeanMotion(line2){ return parseFloat(line2.slice(52, 63)); }
function parseNoradId(line1){ return line1.slice(2, 7).trim(); }

// KNOWN LIMITATION: neither CelesTrak format (json or tle) carries an owner/nation
// field at all, confirmed against real responses — so this always falls through to
// 'OTHER' for live-fetched objects today. The frontend's ownerBucketFor() already
// treats an unrecognized code as OTHER, so this degrades safely rather than breaking,
// but the Owner/Operator filter won't usefully bucket live data by nation until this
// is backed by a real NORAD-ID-to-country lookup (out of scope for the initial cut —
// the static RAW_OBJECTS snapshot still has accurate owner codes, this only affects
// objects sourced from the live catalog-refresh Worker).
function guessOwnerCode(record){
  return typeof record.OWNER === 'string' && record.OWNER ? record.OWNER : 'OTHER';
}

// CelesTrak's FORMAT=tle response is plain text, three lines per object (name, then
// the two TLE lines) with no separators between objects. Verified against a real
// response, cross-checked line-by-line against the same object's FORMAT=json numbers
// (inclination, RAAN, mean anomaly, mean motion, BSTAR all matched exactly) — FORMAT=json
// turned out not to carry TLE_LINE1/TLE_LINE2 at all (it returns the orbital elements as
// separate numeric fields instead), which is what made every record fail validation on
// the first real run. Shaped to match what normalizeRecord() already expects, so nothing
// downstream of this function needed to change.
function parseTleText(text){
  const lines = text.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.length > 0);
  const records = [];
  for (let i = 0; i + 2 < lines.length; i += 3){
    records.push({ OBJECT_NAME: lines[i].trim(), TLE_LINE1: lines[i + 1], TLE_LINE2: lines[i + 2] });
  }
  return records;
}

async function fetchGroup(group){
  const url = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=' + encodeURIComponent(group) + '&FORMAT=tle';
  // CelesTrak's own usage guidance asks API consumers to identify themselves via
  // User-Agent rather than send an anonymous/default one — a missing or generic UA is
  // a common reason a request gets rate-limited or blocked outright, which lines up
  // with the 403 seen on the heaviest-traffic group (starlink) in practice.
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'northern-shrike-catalog-refresh/1.0 (+https://github.com/mgdufour/northern-shrike)' },
  });
  if (!resp.ok) throw new Error('CelesTrak returned ' + resp.status + ' for group ' + group);
  const text = await resp.text();
  return parseTleText(text);
}

// Validates and normalizes one CelesTrak GP JSON record. Returns null (never throws)
// for a record missing required fields — one malformed record should not abort the
// whole ingest run.
function normalizeRecord(record, category){
  const name = record.OBJECT_NAME;
  const line1 = record.TLE_LINE1;
  const line2 = record.TLE_LINE2;
  if (typeof name !== 'string' || typeof line1 !== 'string' || typeof line2 !== 'string') return null;
  if (line1.length < 69 || line2.length < 69) return null;
  const noradId = parseNoradId(line1);
  const inclinationDeg = parseInclinationDeg(line2);
  const meanMotion = parseMeanMotion(line2);
  if (!noradId || !Number.isFinite(inclinationDeg) || !Number.isFinite(meanMotion)) return null;
  return { noradId, name, category, ownerCode: guessOwnerCode(record), line1, line2, inclinationDeg, meanMotion };
}

// D1's batch() sends many statements to the database in one round trip. The exact
// per-batch statement ceiling isn't something to guess at (same lesson as the NOAA
// field-name mismatch earlier) — 50 is a conservative chunk size chosen to stay well
// under any plausible limit, not a value taken from Cloudflare's own documented max.
const INSERT_BATCH_SIZE = 50;

const INSERT_TLE_SQL = `INSERT INTO tle_history
  (norad_id, name, category, owner_code, line1, line2, mean_motion, inclination_deg, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

async function runIngest(env){
  const db = env.DB;
  const startedAt = new Date().toISOString();
  let groupsFetched = 0, recordsSeen = 0, recordsChanged = 0, recordsSkipped = 0;
  let runError = null;

  // Fetch every CelesTrak group concurrently — these are independent HTTP calls, no
  // reason to make one wait for the previous one to finish.
  const settled = await Promise.allSettled(
    CELESTRAK_GROUPS.map(async ({ group, category }) => ({ category, records: await fetchGroup(group) }))
  );

  const normalized = [];
  settled.forEach((result, i) => {
    const { group } = CELESTRAK_GROUPS[i];
    if (result.status === 'rejected'){
      runError = (runError ? runError + '; ' : '') + group + ': ' + result.reason.message;
      return;
    }
    groupsFetched++;
    for (const raw of result.value.records){
      recordsSeen++;
      const rec = normalizeRecord(raw, result.value.category);
      if (!rec){ recordsSkipped++; continue; }
      normalized.push(rec);
    }
  });

  // One query to learn every object's latest stored TLE, instead of one query per
  // object — this (plus batched inserts below) is what makes ingesting a group the
  // size of Starlink's thousands of satellites tractable in a single request, where
  // a one-at-a-time check-then-write per object was not.
  const latestByNorad = new Map();
  if (normalized.length){
    const { results } = await db.prepare(
      `SELECT t.norad_id, t.line1, t.line2 FROM tle_history t
       INNER JOIN (SELECT norad_id, MAX(fetched_at) AS max_fetched FROM tle_history GROUP BY norad_id) m
         ON t.norad_id = m.norad_id AND t.fetched_at = m.max_fetched`
    ).all();
    for (const row of results) latestByNorad.set(row.norad_id, row);
  }

  const toInsert = normalized.filter(rec => {
    const existing = latestByNorad.get(rec.noradId);
    return !existing || existing.line1 !== rec.line1 || existing.line2 !== rec.line2;
  });

  for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE){
    const chunk = toInsert.slice(i, i + INSERT_BATCH_SIZE);
    try{
      await db.batch(chunk.map(rec => db.prepare(INSERT_TLE_SQL).bind(
        rec.noradId, rec.name, rec.category, rec.ownerCode, rec.line1, rec.line2, rec.meanMotion, rec.inclinationDeg, startedAt
      )));
      recordsChanged += chunk.length;
    } catch(e){
      // One bad batch shouldn't lose the rest — record the error and keep going.
      runError = (runError ? runError + '; ' : '') + 'insert batch at offset ' + i + ': ' + e.message;
    }
  }

  await db.prepare(
    `INSERT INTO ingest_runs (started_at, finished_at, groups_fetched, records_seen, records_changed, records_skipped, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(startedAt, new Date().toISOString(), groupsFetched, recordsSeen, recordsChanged, recordsSkipped, runError).run();

  return { groupsFetched, recordsSeen, recordsChanged, recordsSkipped, runError };
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
export { normalizeRecord, parseTleText, runIngest, serveCatalog, serveManeuvers, serveDecayWatch };

export default {
  async scheduled(event, env, ctx){
    ctx.waitUntil(runIngest(env));
  },
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
      if (url.pathname === '/trigger-ingest'){
        // Manual escape hatch for testing: fires the same ingest the Cron Trigger runs,
        // on demand, since the dashboard doesn't reliably expose a "fire now" button for
        // Cron Triggers across all account/dashboard versions. Not authenticated — same
        // posture as /catalog and /maneuvers (public reads); this just runs an ingest
        // against public CelesTrak data into your own D1, nothing sensitive to protect.
        return new Response(JSON.stringify(await runIngest(env)), { headers });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
    } catch(e){
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  },
};
