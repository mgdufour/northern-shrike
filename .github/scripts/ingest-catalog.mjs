/*
 * Northern Shrike catalog ingest — GitHub Actions version.
 *
 * This replaces the Cloudflare Worker's own scheduled() ingest (worker/catalog-refresh/
 * index.js previously had this logic; it's been stripped from there). Every ingest run
 * from the Worker itself failed with a 522 (Cloudflare's "origin never responded") on
 * every single CelesTrak group, consistently, for 24+ hours straight — while CelesTrak
 * loaded fine from a normal browser on a different network the whole time. Switching
 * from concurrent to sequential fetches made zero difference (still 100% failure), which
 * rules out a request-burst/rate-limit explanation and points at something blocking or
 * badly timing out Cloudflare Workers' shared egress IP range specifically. GitHub
 * Actions runners use a completely different IP range, so this script does the same
 * fetch+diff+write job from there instead.
 *
 * The Worker keeps serving /catalog, /maneuvers, /decay-watch, /ingest-status exactly as
 * before — those never touched CelesTrak, only D1, so they were never part of the
 * problem. This script writes to the same D1 database via Cloudflare's D1 REST API
 * (https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{id}/query)
 * instead of the in-Worker binding, since a GitHub Actions job has no access to that
 * binding.
 *
 * Required environment variables (set as GitHub Actions repository secrets — see
 * worker/catalog-refresh/DEPLOY.md):
 *   CF_ACCOUNT_ID      — Cloudflare account ID (dashboard sidebar, most account pages)
 *   CF_D1_DATABASE_ID  — the D1 database's own ID (its dashboard page, NOT the Worker's
 *                         binding name "DB")
 *   CF_API_TOKEN       — a Cloudflare API token scoped to D1 edit access on this account
 *
 * NOTE ON THE D1 REST API SHAPE: the exact response envelope (specifically whether
 * `result` comes back as a single object or an array with one entry per statement) was
 * researched but could not be directly verified against a live response before this
 * script's first real run — this sandbox's network policy blocks
 * developers.cloudflare.com outright. d1Query() below handles both possible shapes
 * defensively, and fails loudly (logs the full raw response) on anything else, rather
 * than silently mishandling it. If the first run fails at the D1-query step, the logged
 * response is what to paste back for a quick fix — same pattern used earlier this
 * session for the CelesTrak TLE-format mismatch.
 */

function requireEnv(name){
  const v = process.env[name];
  if (!v) throw new Error('Missing required environment variable: ' + name + ' (set it as a GitHub Actions secret)');
  return v;
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

async function d1Query(sql, params){
  const accountId = requireEnv('CF_ACCOUNT_ID');
  const databaseId = requireEnv('CF_D1_DATABASE_ID');
  const token = requireEnv('CF_API_TOKEN');

  const resp = await fetch(
    CF_API_BASE + '/accounts/' + accountId + '/d1/database/' + databaseId + '/query',
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params: params || [] }),
    }
  );

  let body = null;
  try { body = await resp.json(); } catch (e) { /* handled by the !body check below */ }

  if (!resp.ok || !body || body.success !== true){
    console.error('D1 REST API query failed.');
    console.error('HTTP status:', resp.status);
    console.error('SQL (first 300 chars):', sql.slice(0, 300));
    console.error('Raw response body:', JSON.stringify(body));
    throw new Error('D1 REST API query failed — see logged response above');
  }

  // Defensive normalization: Cloudflare's own docs and third-party examples disagreed
  // on whether `result` is a single per-statement object or an array of them, and this
  // couldn't be checked against a live response ahead of time. Handle both.
  const entries = Array.isArray(body.result) ? body.result : [body.result];
  const results = entries.flatMap(e => (e && Array.isArray(e.results)) ? e.results : []);
  return results;
}

// ---- Below this line: ported near-verbatim from worker/catalog-refresh/index.js's
// now-removed ingest functions (fetchGroup, parseTleText, normalizeRecord, etc.) — same
// parsing logic, same CelesTrak endpoint and User-Agent, same validation. Only the fetch
// runtime (Node here vs the Workers runtime there) and the D1 access method differ. ----

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

function parseInclinationDeg(line2){ return parseFloat(line2.slice(8, 16)); }
function parseMeanMotion(line2){ return parseFloat(line2.slice(52, 63)); }
function parseNoradId(line1){ return line1.slice(2, 7).trim(); }

function guessOwnerCode(record){
  return typeof record.OWNER === 'string' && record.OWNER ? record.OWNER : 'OTHER';
}

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
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'northern-shrike-catalog-ingest/1.0 (+https://github.com/mgdufour/northern-shrike)' },
  });
  if (!resp.ok) throw new Error('CelesTrak returned ' + resp.status + ' for group ' + group);
  const text = await resp.text();
  return parseTleText(text);
}

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

const INSERT_TLE_SQL = `INSERT INTO tle_history
  (norad_id, name, category, owner_code, line1, line2, mean_motion, inclination_deg, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Concurrency-limited (not fully sequential, not fully parallel): D1's REST API is a
// robust managed endpoint, not a small origin like CelesTrak, so a modest concurrency
// level here is safe and meaningfully faster than one-at-a-time — without relying on
// D1's multi-statement-per-call batching, whose exact param-binding behavior across
// combined statements wasn't something this session could verify against a live
// response ahead of time either. One INSERT per call keeps each request's shape the
// simplest, best-confirmed one.
const INSERT_CONCURRENCY = 10;

async function insertConcurrencyLimited(rows, fetchedAt){
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CONCURRENCY){
    const chunk = rows.slice(i, i + INSERT_CONCURRENCY);
    await Promise.all(chunk.map(rec => d1Query(INSERT_TLE_SQL, [
      rec.noradId, rec.name, rec.category, rec.ownerCode, rec.line1, rec.line2, rec.meanMotion, rec.inclinationDeg, fetchedAt,
    ])));
    inserted += chunk.length;
    console.log('  inserted ' + inserted + '/' + rows.length);
  }
}

async function main(){
  const startedAt = new Date().toISOString();
  let groupsFetched = 0, recordsSeen = 0, recordsChanged = 0, recordsSkipped = 0;
  let runError = null;

  const normalized = [];
  for (const { group, category } of CELESTRAK_GROUPS){
    console.log('Fetching group: ' + group);
    let records;
    try{
      records = await fetchGroup(group);
    } catch(e){
      console.error('  failed: ' + e.message);
      runError = (runError ? runError + '; ' : '') + group + ': ' + e.message;
      continue;
    }
    groupsFetched++;
    console.log('  got ' + records.length + ' records');
    for (const raw of records){
      recordsSeen++;
      const rec = normalizeRecord(raw, category);
      if (!rec){ recordsSkipped++; continue; }
      normalized.push(rec);
    }
  }

  console.log('Checking latest stored TLE per object for changes...');
  const latestByNorad = new Map();
  if (normalized.length){
    const rows = await d1Query(
      `SELECT t.norad_id, t.line1, t.line2 FROM tle_history t
       INNER JOIN (SELECT norad_id, MAX(fetched_at) AS max_fetched FROM tle_history GROUP BY norad_id) m
         ON t.norad_id = m.norad_id AND t.fetched_at = m.max_fetched`
    );
    for (const row of rows) latestByNorad.set(row.norad_id, row);
  }

  const toInsert = normalized.filter(rec => {
    const existing = latestByNorad.get(rec.noradId);
    return !existing || existing.line1 !== rec.line1 || existing.line2 !== rec.line2;
  });

  console.log(toInsert.length + ' changed records to insert (of ' + normalized.length + ' seen).');
  try{
    await insertConcurrencyLimited(toInsert, startedAt);
    recordsChanged = toInsert.length;
  } catch(e){
    runError = (runError ? runError + '; ' : '') + 'insert failed: ' + e.message;
  }

  await d1Query(
    `INSERT INTO ingest_runs (started_at, finished_at, groups_fetched, records_seen, records_changed, records_skipped, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [startedAt, new Date().toISOString(), groupsFetched, recordsSeen, recordsChanged, recordsSkipped, runError]
  );

  console.log('Done.', { groupsFetched, recordsSeen, recordsChanged, recordsSkipped, runError });
  if (runError && groupsFetched === 0){
    // Every group failed — exit non-zero so the GitHub Actions run shows red and you
    // get notified, rather than a quiet green run that did nothing.
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Ingest run failed:', e);
  process.exit(1);
});
