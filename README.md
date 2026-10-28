# Transaction Ledger API

A backend API for a simple transaction ledger: create accounts, post credit/debit transactions, read balances and paginated history, and (bonus) transfer money atomically between accounts.

- **Stack:** Node.js 22+, Express 4, SQLite (Node's built-in `node:sqlite`, no native build step)
- **Dependencies:** just `express`. Tests use Node's built-in test runner.
- Full endpoint reference: [docs/API.md](docs/API.md)

## Run locally

Requires **Node.js >= 22.13**.

```bash
npm install
npm start          # http://localhost:3000, data stored in data/ledger.db
npm test           # 33 integration tests against an in-memory database
```

Config via env vars: `PORT` (default `3000`), `DB_FILE` (default `data/ledger.db`).

### Quick demo

```bash
# create an account
curl -s -X POST localhost:3000/accounts -H 'content-type: application/json' -d '{"name":"Alice"}'

# credit 100 (use the returned id)
curl -s -X POST localhost:3000/transactions -H 'content-type: application/json' \
  -d '{"account_id":"<ID>","type":"credit","amount":100,"reference_id":"r1","description":"top up"}'

curl -s localhost:3000/accounts/<ID>/balance
curl -s "localhost:3000/accounts/<ID>/transactions?type=credit&page=1&limit=10"
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/accounts` | Create account (balance always starts at 0) |
| GET | `/accounts/:id` | Get account |
| GET | `/accounts/:id/balance` | Get `account_id` + `balance` |
| POST | `/transactions` | Add a credit or debit |
| GET | `/transactions/:id` | Get one transaction |
| GET | `/accounts/:id/transactions` | History: `type`, `page`, `limit`; latest first |
| POST | `/transfers` | Bonus: atomic account-to-account transfer |
| PUT/PATCH/DELETE | `/transactions...` | Always `405 TRANSACTION_IMMUTABLE` |

## Design

```
src/
  server.js            process entry (env config, graceful shutdown)
  app.js               Express wiring, routes, uniform error handler
  db.js                schema, constraints, triggers, withTransaction()
  money.js             amount validation / integer-cent conversion
  errors.js            AppError + helpers
  services/ledger.js   all business rules (validation, balances, transfers)
test/api.test.js       integration tests
```

How each requirement is met:

- **Atomicity.** A transaction row and its balance update run inside one `BEGIN IMMEDIATE ... COMMIT`; any error triggers `ROLLBACK`. Transfers run both legs in a single DB transaction, so a partial transfer is impossible (tested by forcing the second leg to fail).
- **No overdraft, even under concurrency.** Debits use a conditional `UPDATE ... WHERE balance >= amount`, plus a `CHECK (balance >= 0)` constraint as a backstop. Writes take the SQLite write lock up front (`BEGIN IMMEDIATE`), so concurrent requests are serialized (tested with 10 parallel debits).
- **Idempotency / duplicates.** `UNIQUE (account_id, reference_id)` in the DB; the service also checks first so it can return the existing transaction. A duplicate returns `409 DUPLICATE_TRANSACTION` with the original in `error.details.transaction`, and changes nothing. The same `reference_id` is fine on a different account.
- **Immutability.** There are no update/delete routes (explicit `405`), and DB triggers abort any `UPDATE`/`DELETE` on `transactions`.
- **Balance consistency.** The balance is only ever changed together with a ledger row, in the same DB transaction, so it always equals the sum of valid credits minus debits. Rejected requests write nothing.
- **Money precision.** Amounts are stored as integer cents, not floats (`10 x 0.10 == 1.00`).
- **Validation and errors.** One error shape everywhere: `{ "error": { "code", "message", "details?" } }` with meaningful HTTP codes (400 validation, 404 not found, 405 immutable, 409 duplicate, 422 insufficient balance).

## Assumptions

1. **Currency:** single, unspecified currency. Amounts are JSON numbers with at most 2 decimal places, `> 0` and `<= 1,000,000,000`. Strings like `"10"` are rejected.
2. **IDs:** accounts and transactions get server-generated UUIDs; clients cannot supply `id` or `created_at`.
3. **Initial balance:** if a client sends `balance` when creating an account, the request is rejected with `400` rather than silently ignored, so the client learns it isn't allowed.
4. **Transaction creation:** `account_id` goes in the request body of `POST /transactions` (matching the spec's transaction fields), not the URL.
5. **Duplicate response:** `409 Conflict` (not a silent `200`) with the existing transaction in `details`; clients can treat it as "already applied".
6. **Rejected debits are not stored** in the ledger. Only valid, applied transactions exist, which keeps "balance = sum of all transactions" exactly true.
7. **Duplicate check precedes the balance check**, so replaying an old debit reports "duplicate", not "insufficient balance".
8. **Transfers:** `reference_id` is required and recorded on both legs (once per account), so retrying the same transfer is rejected as a duplicate. Both legs share a `transfer_id`. Transferring to the same account is a `400`.
9. **`description`** is optional (max 500 chars); `reference_id` is a trimmed non-empty string up to 128 chars. `type` is case-sensitive lowercase.
10. **Pagination:** `page` default 1, `limit` default 10, max 100; `total_pages` is 0 when there are no records; a page beyond the end returns an empty `data` array. Ties on `created_at` are ordered by insertion order.
11. **No authentication / authorization** (not in scope). Account deletion is not offered.
12. **SQLite** is chosen for zero-setup local running; `node:sqlite` is flagged experimental in Node 22, which is why scripts pass `--no-warnings`. The service layer is DB-agnostic enough to port to Postgres by swapping `db.js` and the prepared statements.
