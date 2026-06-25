-- Smart Translation — D1 Schema
-- Run: npx wrangler d1 execute smart-translation-db --file=./schema.sql --remote

-- ── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,   -- UUID
  email          TEXT UNIQUE NOT NULL,
  token_hash     TEXT,               -- SHA-256 of bearer token (null until first login)
  is_subscribed  INTEGER DEFAULT 1,  -- 1 = subscribed; flip to 0 when launching paid tier
  created_at     INTEGER DEFAULT (unixepoch())
);

-- ── Auth codes (6-digit, 10 min TTL) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT    NOT NULL,       -- SHA-256 of the 6-digit code
  expires_at INTEGER NOT NULL
);

-- ── Vocabulary (full array per user, last-write-wins) ──────────────────────
CREATE TABLE IF NOT EXISTS vocab (
  user_id    TEXT PRIMARY KEY,
  data_json  TEXT    NOT NULL DEFAULT '[]',
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── User settings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    TEXT PRIMARY KEY,
  data_json  TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── User profile ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_profile (
  user_id    TEXT PRIMARY KEY,
  data_json  TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
