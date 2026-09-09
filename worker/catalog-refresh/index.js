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
 *      jumped between consecutive TLEs within the window), and GET /ingest-status
 *      (the last few cron runs, for checking the job is actually healthy).
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

// Best-effort owner code from CelesTrak's own OWNER field if present; the frontend's
// existing ownerBucketFor() does the real bucketing and already treats an unrecognized
// code as OTHER, so a missing/unexpected value here degrades safely.
function guessOwnerCode(record){
  return typeof record.OWNER === 'string' && record.OWNER ? record.OWNER : 'OTHER';
}

async function fetchGroup(group){
  const url = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=' + encodeURIComponent(group) + '&FORMAT=json';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('CelesTrak returned ' + resp.status + ' for group ' + group);
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error('unexpected CelesTrak response shape for group ' + group);
  return data;
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

// Inserts a new tle_history row for `rec` only if its TLE differs from the most
// recently stored one for the same norad_id (or none exists yet). Returns true if a
// row was inserted, false if this was a no-op (unchanged TLE since last ingest).
async function ingestOne(db, rec, fetchedAt){
  const existing = await db.prepare(
    'SELECT line1, line2 FROM tle_history WHERE norad_id = ? ORDER BY fetched_at DESC LIMIT 1'
  ).bind(rec.noradId).first();
  if (existing && existing.line1 === rec.line1 && existing.line2 === rec.line2) return false;
  await db.prepare(
    `INSERT INTO tle_history (norad_id, name, category, owner_code, line1, line2, mean_motion, inclination_deg, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(rec.noradId, rec.name, rec.category, rec.ownerCode, rec.line1, rec.line2, rec.meanMotion, rec.inclinationDeg, fetchedAt).run();
  return true;
}

async function runIngest(env){
  const db = env.DB;
  const startedAt = new Date().toISOString();
  let groupsFetched = 0, recordsSeen = 0, recordsChanged = 0, recordsSkipped = 0;
  let runError = null;

  for (const { group, category } of CELESTRAK_GROUPS){
    try {
      const records = await fetchGroup(group);
      groupsFetched++;
      for (const raw of records){
        recordsSeen++;
        const rec = normalizeRecord(raw, category);
        if (!rec){ recordsSkipped++; continue; }
        const changed = await ingestOne(db, rec, startedAt);
        if (changed) recordsChanged++;
      }
    } catch (e){
      // One bad group shouldn't kill the whole run — record the error and keep going.
      runError = (runError ? runError + '; ' : '') + group + ': ' + e.message;
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

// Named exports exist only so a test harness can call these directly — Cloudflare
// Workers only ever invoke the default export below, so this has no runtime effect.
export { normalizeRecord, ingestOne, runIngest, serveCatalog, serveManeuvers };

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
