# Deploying the catalog-refresh Worker + ingest job

Two separate pieces now, deployed two different ways:

- **The Worker** (this folder's `index.js`) is read-only — it serves `/catalog`,
  `/maneuvers`, `/decay-watch`, and `/ingest-status` from D1. Deployed the same
  dashboard-based, no-CLI way as the Copilot Worker.
- **The ingest job** (`.github/scripts/ingest-catalog.mjs` +
  `.github/workflows/catalog-ingest.yml`, at the repo root, not in this folder) fetches
  CelesTrak and writes to the same D1 database on a schedule. It runs on GitHub Actions,
  not on the Worker — see "Why the ingest job isn't in the Worker" below.

## 1. Create the D1 database

1. In the left sidebar, go to **Storage & Databases → D1 SQL Database**.
2. Click **Create database**. Name it `northern-shrike-catalog` (any name works, but the
   rest of this guide assumes that one).
3. Once created, open it and go to its **Console** tab.
4. Paste in the entire contents of `schema.sql` (in this folder) and run it. This creates
   the `tle_history` and `ingest_runs` tables. You can re-run it safely later — every
   statement uses `IF NOT EXISTS`.
5. Still on the database's own page, note its **Database ID** (shown near the top —
   this is different from the Worker binding name `DB` used below, and you'll need it
   for the GitHub Actions secrets in step 5).

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

If this Worker still has a **Cron Trigger** configured from an earlier version (Settings
→ Triggers), remove it — there's no `scheduled()` handler left in `index.js` to fire, so
a leftover trigger would just do nothing every time it fires. The ingest schedule now
lives in the GitHub Actions workflow instead (step 5).

## 4. Wire the frontend to the Worker

Set `CATALOG_WORKER_URL` in `index.html` to `https://<your-worker-subdomain>.workers.dev`
(same one-line flip as `COPILOT_WORKER_URL` was). Until you do that, the frontend keeps
using the static embedded catalog exactly as it does today — this Worker is inert to the
live site until that URL is set. This step doesn't depend on the ingest job having run
yet — `/catalog` just returns an empty-ish result until D1 has data in it.

## 5. Set up the GitHub Actions ingest job

This is what actually populates D1 with live CelesTrak data. Three repository secrets
are needed:

1. **`CF_ACCOUNT_ID`** — your Cloudflare account ID. Visible in the right sidebar on
   most pages of the Cloudflare dashboard (e.g. the Workers & Pages overview page).
2. **`CF_D1_DATABASE_ID`** — the D1 database's own ID, noted in step 1 above (its own
   dashboard page, not the Worker's `DB` binding name).
3. **`CF_API_TOKEN`** — a Cloudflare API token scoped to D1 write access on this
   account:
   - Cloudflare dashboard → **My Profile → API Tokens → Create Token**.
   - Use **Create Custom Token**.
   - Under **Permissions**, add an entry for **D1** with **Edit** access, scoped to
     your account.
   - Under **Account Resources**, restrict it to the specific account this D1 database
     lives in (not "All accounts") if that option is available — keeps the token as
     narrowly scoped as possible.
   - Create the token and copy it immediately (Cloudflare only shows it once).

Add all three to the GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**, one per value, using exactly the names above (the workflow file
reads them by these names).

Once the secrets are set, the workflow (`.github/workflows/catalog-ingest.yml`) will
run automatically every 6 hours. To test it immediately instead of waiting:

1. Go to the repo's **Actions** tab.
2. Select **Catalog ingest** in the left sidebar.
3. Click **Run workflow** (this is the `workflow_dispatch` trigger — the equivalent of
   the old Worker's `/trigger-ingest` endpoint, which no longer exists since the Worker
   doesn't do ingest anymore).
4. Click into the run to watch its log — every step (`Fetching group: ...`, insert
   progress, the final summary) is logged plainly for exactly this kind of first-run
   verification.

## 6. Verify it's actually working

- **The Actions run log itself** is the most direct signal — a green check means the
  script's own logic ran without throwing; look at the logged summary line
  (`groupsFetched`, `recordsSeen`, etc.) to see whether CelesTrak was actually reachable
  from GitHub's runners.
- **`GET https://<your-worker-subdomain>.workers.dev/ingest-status`** — the last 5
  ingest runs (now written by the GitHub Actions job instead of the Worker, into the
  same `ingest_runs` table), with counts and any error.
- **`GET .../catalog`** — the current live catalog as JSON, once at least one ingest run
  has completed.
- **`GET .../maneuvers?days=7`** and **`GET .../decay-watch?days=30`** — same as
  before, empty until enough TLE history has accumulated.

Note: these Worker endpoints check the `Origin` header and only allow
`https://mgdufour.github.io` (same restriction as the Copilot Worker) — so testing them
directly in a browser address bar will get a CORS-less raw response (that's fine, the
browser address bar doesn't send an `Origin` header the same way a page's own `fetch()`
does), but a `fetch()` call *from a different site* would be rejected. `curl` is
unaffected by CORS entirely (CORS is a browser-enforced restriction, not a server-side
one), so it always gets through regardless.

## Why the ingest job isn't in the Worker

It used to be — the Worker had a `scheduled()` handler doing exactly what the GitHub
Actions script does now. Every single ingest attempt from the Worker failed with a 522
(Cloudflare's "the origin never responded") on every CelesTrak group, consistently, for
24+ hours straight, while CelesTrak loaded fine from a normal browser on a different
network the whole time. Switching the Worker's fetches from concurrent to sequential
(to rule out a request-burst explanation) made zero difference — still 100% failure.
That points at something blocking or badly timing out Cloudflare Workers' shared egress
IP range specifically when talking to CelesTrak, which no change to the Worker's own
code could fix. GitHub Actions runners use a different IP range, so the same fetch logic
moved there instead, writing to D1 through its REST API rather than the Worker's
in-process binding (which a GitHub Actions job has no access to).
