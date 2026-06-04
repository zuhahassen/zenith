-- Zenith D1 schema.
--
-- Apply with:
--   wrangler d1 execute zenith-db --file=worker/schema.sql              (local dev)
--   wrangler d1 execute zenith-db --remote --file=worker/schema.sql     (production)

-- User profile + preference state. user_id is a client-generated UUID.
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id           TEXT PRIMARY KEY,
    location_history  TEXT NOT NULL DEFAULT '[]',  -- JSON array of {lat, lon, label, ts}
    equipment         TEXT NOT NULL DEFAULT '{}',  -- JSON: {aperture_mm, focal_length_mm, mount, ...}
    mode              TEXT NOT NULL DEFAULT 'observer'  -- 'observer' | 'astrophotographer'
        CHECK (mode IN ('observer', 'astrophotographer')),
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per generated plan. Used for preference learning and debriefs.
CREATE TABLE IF NOT EXISTS session_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    plan        TEXT NOT NULL,            -- JSON: full response payload from /api/plan
    conditions  TEXT NOT NULL,            -- JSON: weather + sky snapshot at plan time
    timestamp   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES user_profiles(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_history_user_ts
    ON session_history(user_id, timestamp DESC);

-- Hourly weather observations keyed by a coarsened location hash.
-- This is the ML training set for the seeing predictor.
CREATE TABLE IF NOT EXISTS weather_logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    location_hash  TEXT NOT NULL,         -- e.g. geohash(lat, lon, precision=5)
    timestamp      TIMESTAMP NOT NULL,
    features       TEXT NOT NULL          -- JSON: full feature dict from api/ml/features.py
);

CREATE INDEX IF NOT EXISTS idx_weather_logs_loc_ts
    ON weather_logs(location_hash, timestamp DESC);

-- Thumbs up/down feedback on individual targets. Feeds the Claude planner so
-- it can favour liked objects and avoid disliked ones on future plans.
CREATE TABLE IF NOT EXISTS target_feedback (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    target_name  TEXT NOT NULL,
    rating       INTEGER NOT NULL,          -- 1 (up), -1 (down), 0 (cleared)
    note         TEXT,
    timestamp    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_target_feedback_user
    ON target_feedback(user_id, timestamp DESC);

-- Speeds up the crowdsourced community-favorites aggregation, which groups by
-- target and reads the latest rating per (user, target).
CREATE INDEX IF NOT EXISTS idx_target_feedback_target
    ON target_feedback(target_name, user_id, timestamp DESC);

-- Lightweight per-plan summary, written at the edge after each successful
-- /api/plan-ai response and read back by the History view. Distinct from the
-- legacy session_history table (which stores full JSON blobs and carries a
-- FOREIGN KEY to user_profiles): this one has no FK and only nullable summary
-- columns, so an anonymous client UUID with no profile row can still record
-- history. Safe additive migration — pure CREATE, no change to existing tables.
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
