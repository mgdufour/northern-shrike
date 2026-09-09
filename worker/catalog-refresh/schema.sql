-- Northern Shrike catalog-refresh D1 schema.
--
-- One row per *distinct* TLE ever observed for a tracked object — not one row per
-- ingest cycle. The ingest worker only inserts a new row when an object's TLE has
-- actually changed since the last one stored, so this table stays small (most objects
-- go a day or more between new TLE fits) while still holding exactly the history
-- maneuver detection needs: every point at which an object's orbit was re-fit.
CREATE TABLE IF NOT EXISTS tle_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  norad_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,     -- matches the frontend's CATS ids (station, navigation, ...)
  owner_code    TEXT NOT NULL,     -- matches RAW_OBJECTS' raw "o" field (ISS, US, CIS, PRC, ...)
  line1         TEXT NOT NULL,
  line2         TEXT NOT NULL,
  mean_motion   REAL NOT NULL,     -- revs/day, parsed from line2 cols 53-63 at ingest time
  inclination_deg REAL NOT NULL,   -- degrees, parsed from line2 cols 9-16 at ingest time
  fetched_at    TEXT NOT NULL      -- ISO8601 UTC — when this fetch cycle first observed this TLE
);

-- Supports both query shapes this schema exists for:
--  1. "Latest TLE per object" (GET /catalog) — MAX(fetched_at) per norad_id
--  2. "Full history for one object, newest first" (GET /maneuvers) — per-norad_id scan
CREATE INDEX IF NOT EXISTS idx_tle_history_norad_fetched
  ON tle_history (norad_id, fetched_at DESC);

-- Tracks each scheduled ingest run for visibility into whether the cron job is healthy —
-- separate from tle_history so "did the last run succeed" doesn't require scanning it.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  groups_fetched  INTEGER NOT NULL DEFAULT 0,
  records_seen    INTEGER NOT NULL DEFAULT 0,
  records_changed INTEGER NOT NULL DEFAULT 0,  -- how many got a new tle_history row
  records_skipped INTEGER NOT NULL DEFAULT 0,  -- malformed records that failed validation
  error           TEXT                          -- set if the run failed outright
);
