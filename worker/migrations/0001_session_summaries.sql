-- Migration 0001 — session history summaries.
--
-- Adds a lightweight per-plan summary table read by the History view. No FK
-- and only nullable summary columns, so an anonymous client UUID with no
-- user_profiles row can still record history (unlike the legacy
-- session_history table). Purely additive — safe to run on production.
--
-- Apply:
--   wrangler d1 execute zenith-db --file=worker/migrations/0001_session_summaries.sql            (local)
--   wrangler d1 execute zenith-db --remote --file=worker/migrations/0001_session_summaries.sql   (production)

CREATE TABLE IF NOT EXISTS session_summaries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT NOT NULL,
    timestamp         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    location_name     TEXT,
    lat               REAL,
    lon               REAL,
    aperture_mm       REAL,
    target_count      INTEGER,
    moon_illumination REAL,
    bortle            INTEGER,
    seeing_median     REAL,
    top_target        TEXT,
    top_target_type   TEXT,
    session_summary   TEXT,
    mode              TEXT NOT NULL DEFAULT 'observer'
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_user_ts
    ON session_summaries(user_id, timestamp DESC);
