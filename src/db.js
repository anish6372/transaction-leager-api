const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Amounts are stored as integer minor units (cents) to avoid floating point drift.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  type         TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  description  TEXT NOT NULL DEFAULT '',
  reference_id TEXT NOT NULL CHECK (length(reference_id) > 0),
  transfer_id  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (account_id, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_txn_account_seq ON transactions (account_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_txn_account_type_seq ON transactions (account_id, type, seq DESC);

-- Ledger entries are append-only: enforced at the database level as well as the API.
CREATE TRIGGER IF NOT EXISTS transactions_no_update
BEFORE UPDATE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS transactions_no_delete
BEFORE DELETE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'transactions are immutable');
END;
`;

function openDatabase(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside a single write transaction. Commits on return, rolls back on throw,
// so a ledger entry and its balance update are always persisted together or not at all.
function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, withTransaction };
