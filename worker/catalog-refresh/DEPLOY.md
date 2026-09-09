# Deploying the catalog-refresh Worker

Same dashboard-based flow used for the Copilot Worker — no CLI, no local setup.
Everything below is a click-through in the Cloudflare dashboard (`dash.cloudflare.com`).

## 1. Create the D1 database

1. In the left sidebar, go to **Storage & Databases → D1 SQL Database**.
2. Click **Create database**. Name it `northern-shrike-catalog` (any name works, but the
   rest of this guide assumes that one).
3. Once created, open it and go to its **Console** tab.
4. Paste in the entire contents of `schema.sql` (in this folder) and run it. This creates
   the `tle_history` and `ingest_runs` tables. You can re-run it safely later — every
   statement uses `IF NOT EXISTS`.

## 2. Create the Worker

1. **Workers & Pages → Create application → Workers**, same as before — pick the blank/
   "Hello World" starting point.
2. Name it something like `northern-shrike-catalog-refresh`.
3. Once deployed, click **Edit code** to open the Quick Edit editor.
4. Select all the placeholder code, delete it, and paste in the full contents of
   `index.js` from this folder.
5. Click **Deploy** (or Save and Deploy) in the editor.

## 3. Bind the D1 database to the Worker

1. On the Worker's own page (not the D1 page), go to **Settings → Variables and
   Bindings** (or **Bindings**, depending on the current dashboard layout).
2. Add a **D1 database binding**:
   - Variable name: `DB` — this must be exactly `DB`, it's what `env.DB` refers to in
     `index.js`.
   - D1 database: select `northern-shrike-catalog` (the one created in step 1).
3. Save. The dashboard will redeploy the Worker automatically with the binding attached.

## 4. Add the Cron Trigger

1. Same Worker → **Settings → Triggers** (or **Trigger Events**).
2. Add a **Cron Trigger**. A reasonable starting schedule is every 6 hours:
   `0 */6 * * *`. (CelesTrak's own data doesn't update much faster than that for most
   objects, so there's little value going shorter — and it keeps D1 usage low.)
3. Save.

At this point the ingest job will start running on its own schedule. You don't need to
wait for the first Cron firing to test it — see the next section.

## 5. Verify it's actually working

The Worker also serves a small HTTP API (same CORS-restricted-to-your-Pages-origin
pattern as the Copilot Worker) you can use to check on it:

- **Trigger an ingest run manually**, without waiting for the cron schedule: on the
  Worker's page, there's usually a **Triggers → Cron Triggers → Trigger event** button
  (or similar — "Send test event" in some dashboard versions) that fires `scheduled()`
  once immediately. Use this the first time so you don't have to wait up to 6 hours to
  see if it worked.
- **`GET https://<your-worker-subdomain>.workers.dev/ingest-status`** — the last 5 ingest
  runs, with counts (`recordsChanged`, `recordsSkipped`, etc.) and any error. If
  `recordsSeen` is 0 across the board, CelesTrak's response shape probably doesn't match
  what `normalizeRecord()` in `index.js` expects (it needs `OBJECT_NAME`, `TLE_LINE1`,
  `TLE_LINE2` on each record) — worth opening
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json` directly in a
  browser tab to compare against what the code expects, the same way we diagnosed the
  NOAA space-weather field mismatch earlier.
- **`GET .../catalog`** — the current live catalog as JSON, once at least one ingest run
  has completed.
- **`GET .../maneuvers?days=7`** — anything flagged as a possible maneuver in the last 7
  days (empty until enough history has accumulated for at least one object to have two
  distinct TLEs in that window).

Note: these endpoints check the `Origin` header and only allow
`https://mgdufour.github.io` (same restriction as the Copilot Worker) — so testing them
directly in a browser address bar will get a CORS-less raw response (that's fine, the
browser address bar doesn't send an `Origin` header the same way a page's own `fetch()`
does), but a `fetch()` call *from a different site* would be rejected. If you want to
poke at it from a tool like curl instead, that's unaffected by CORS entirely (CORS is a
browser-enforced restriction, not a server-side one) — `curl` will always get through.

## 6. Wire the frontend to it

Once you've confirmed `/catalog` returns real data, set `CATALOG_WORKER_URL` in
`index.html` to `https://<your-worker-subdomain>.workers.dev` (same one-line flip as
`COPILOT_WORKER_URL` was). Until you do that, the frontend keeps using the static
embedded catalog exactly as it does today — this Worker is inert to the live site until
that URL is set.
