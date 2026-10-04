CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL CHECK (plan IN ('monthly', 'quarterly', 'lifetime')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'refunded')),
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  order_id TEXT,
  customer_email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL UNIQUE REFERENCES licenses(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  platform TEXT NOT NULL,
  machine_name TEXT,
  app_version TEXT,
  activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS activation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER REFERENCES licenses(id) ON DELETE SET NULL,
  license_key_hash TEXT NOT NULL,
  device_fingerprint TEXT,
  event_type TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_status_expires ON licenses(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_activation_events_created ON activation_events(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_order_id ON licenses(order_id) WHERE order_id IS NOT NULL;

INSERT OR IGNORE INTO licenses (license_key, plan, status, expires_at, order_id, customer_email)
VALUES
  ('AMZ-MONTH-DEV-0001', 'monthly', 'active', datetime('now', '+1 month'), 'dev-month', 'dev@example.com'),
  ('AMZ-QUARTER-DEV-0001', 'quarterly', 'active', datetime('now', '+3 months'), 'dev-quarter', 'dev@example.com'),
  ('AMZ-LIFE-DEV-0001', 'lifetime', 'active', NULL, 'dev-life', 'dev@example.com');
