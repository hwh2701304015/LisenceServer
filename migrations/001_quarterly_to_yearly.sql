PRAGMA foreign_keys=off;

CREATE TABLE IF NOT EXISTS licenses_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL CHECK (plan IN ('monthly', 'yearly', 'lifetime')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'refunded')),
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  order_id TEXT,
  customer_email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO licenses_new (
  id,
  license_key,
  plan,
  status,
  issued_at,
  expires_at,
  order_id,
  customer_email,
  created_at,
  updated_at
)
SELECT
  id,
  license_key,
  CASE plan WHEN 'quarterly' THEN 'yearly' ELSE plan END,
  status,
  issued_at,
  expires_at,
  order_id,
  customer_email,
  created_at,
  updated_at
FROM licenses;

DROP TABLE licenses;
ALTER TABLE licenses_new RENAME TO licenses;

CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_status_expires ON licenses(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_order_id ON licenses(order_id) WHERE order_id IS NOT NULL;

UPDATE licenses
SET
  license_key = 'AMZ-YEAR-DEV-0001',
  order_id = 'dev-year',
  expires_at = datetime('now', '+12 months')
WHERE license_key = 'AMZ-QUARTER-DEV-0001';

PRAGMA foreign_keys=on;
