-- Migration: SePay billing (orders table + plan_expires_at)
-- Run once against the EXISTING database (schema.sql already has these
-- statements for anyone creating a fresh DB from scratch):
--
--   npx wrangler d1 execute smart-translation-db --local  --file=./migrations/0001_billing.sql
--   npx wrangler d1 execute smart-translation-db --remote --file=./migrations/0001_billing.sql
--
-- ALTER TABLE ADD COLUMN errors if the column already exists — safe to ignore
-- ("duplicate column name") if you accidentally run this twice.

ALTER TABLE users ADD COLUMN plan_expires_at INTEGER;

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  plan        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER DEFAULT (unixepoch()),
  paid_at     INTEGER,
  sepay_tx_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_sepay_tx ON orders(sepay_tx_id);
