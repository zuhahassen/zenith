-- Migration 0002: magic-link auth tables (users, auth_tokens, sessions).
-- Additive only — guest mode is unaffected. Apply with:
--   wrangler d1 execute zenith-db --remote --file=worker/migrations/0002_auth.sql --config=worker/wrangler.toml

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    created_at    TEXT NOT NULL,
    display_name  TEXT,
    last_seen     TEXT
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    token       TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_email ON auth_tokens(email);

CREATE TABLE IF NOT EXISTS sessions (
    jti         TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
