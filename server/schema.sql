-- Smart Translation — D1 Schema
-- Run: npx wrangler d1 execute smart-translation-db --file=./schema.sql --remote

-- ── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,   -- UUID
  email            TEXT UNIQUE NOT NULL,
  token_hash       TEXT,               -- SHA-256 of bearer token (null until first login)
  is_subscribed    INTEGER DEFAULT 1,  -- legacy flag, unused now — plan_expires_at is the source of truth
  plan_expires_at  INTEGER,            -- unix seconds; NULL or in the past = free tier
  created_at       INTEGER DEFAULT (unixepoch())
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

-- ── Orders (SePay VietQR checkout) ────────────────────────────────────────
-- One row per checkout attempt. `id` doubles as the VietQR transfer content
-- (des= param) so the webhook can match an incoming bank transaction back to
-- a specific order without any SePay-side order API.
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,             -- e.g. SMTCA1B2C3D4
  user_id     TEXT NOT NULL,
  plan        TEXT NOT NULL,                -- 'monthly' | 'annual'
  amount      INTEGER NOT NULL,             -- VND
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | paid
  created_at  INTEGER DEFAULT (unixepoch()),
  paid_at     INTEGER,
  sepay_tx_id TEXT,                         -- SePay transaction `id` — dedupe key for webhook retries
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_sepay_tx ON orders(sepay_tx_id);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
