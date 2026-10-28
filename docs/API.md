# API Documentation

Base URL: `http://localhost:3000`. All bodies are JSON (`Content-Type: application/json`).

## Error format

Every error uses the same shape:

```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "Insufficient balance: available 100, requested 150", "details": [] } }
```

`details` is optional (field-level errors, or the existing transaction for duplicates).

| HTTP | code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing/invalid fields (`details` lists each field) |
| 400 | `INVALID_REQUEST_BODY` | Malformed JSON, or body is not an object |
| 400 | `INVALID_TRANSACTION_TYPE` | `type` is not `credit`/`debit` |
| 400 | `INVALID_AMOUNT` | Not a number, `<= 0`, > 2 decimals, or too large |
| 400 | `INVALID_PAGINATION_PARAMETERS` | Bad `page`, `limit` or `type` query value |
| 404 | `ACCOUNT_NOT_FOUND` | Unknown account id |
| 404 | `TRANSACTION_NOT_FOUND` / `NOT_FOUND` | Unknown transaction / route |
| 405 | `TRANSACTION_IMMUTABLE` | PUT/PATCH/DELETE on a transaction |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` already used on that account |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 10 KB |
| 422 | `INSUFFICIENT_BALANCE` | Debit/transfer exceeds balance |
| 500 | `INTERNAL_ERROR` | Unexpected failure (details never leaked) |

---

## POST /accounts

Request: `{ "name": "Alice" }`. `balance`, `id` and `created_at` cannot be set by the client (sending `balance` returns 400).

`201 Created`
```json
{ "id": "6f1c...-uuid", "name": "Alice", "balance": 0, "created_at": "2026-10-28T15:00:00.000Z" }
```

## GET /accounts/:id

`200` returns the same account object. `404 ACCOUNT_NOT_FOUND` if unknown.

## GET /accounts/:id/balance

`200`
```json
{ "account_id": "6f1c...", "balance": 100 }
```

## POST /transactions

| Field | Type | Rules |
|---|---|---|
| `account_id` | string | required, must exist |
| `type` | string | `"credit"` or `"debit"` |
| `amount` | number | `> 0`, max 2 decimals |
| `reference_id` | string | required, unique per account, max 128 chars |
| `description` | string | optional, max 500 chars |

`201 Created`
```json
{
  "id": "b2e0...", "account_id": "6f1c...", "type": "credit", "amount": 100,
  "description": "top up", "reference_id": "r1", "transfer_id": null,
  "created_at": "2026-10-28T15:00:01.000Z"
}
```

Other outcomes:
- `422 INSUFFICIENT_BALANCE`: debit larger than balance. Nothing is recorded; balance unchanged.
- `409 DUPLICATE_TRANSACTION`: same `reference_id` on the same account. No new transaction, balance unchanged; the original is returned in `error.details.transaction`.
- `404 ACCOUNT_NOT_FOUND`, `400` validation errors as listed above.

## GET /transactions/:id

`200` returns one transaction. `404 TRANSACTION_NOT_FOUND`.

`PUT`, `PATCH`, `DELETE` on `/transactions` or `/transactions/:id` return `405 TRANSACTION_IMMUTABLE`.

## GET /accounts/:id/transactions

Query params (all optional):

| Param | Default | Notes |
|---|---|---|
| `type` | both | `credit` or `debit` |
| `page` | 1 | positive integer |
| `limit` | 10 | positive integer, max 100 |

Sorted latest first by `created_at`.

`200`
```json
{
  "data": [ { "id": "...", "type": "debit", "amount": 30, "...": "..." } ],
  "pagination": { "current_page": 1, "page_size": 10, "total_records": 25, "total_pages": 3 }
}
```

## POST /transfers (bonus)

Request:
```json
{ "from_account_id": "A", "to_account_id": "B", "amount": 30, "reference_id": "t-1", "description": "rent" }
```

Debits A and credits B in one atomic database transaction; if anything fails, neither leg is persisted.

`201 Created`
```json
{
  "transfer_id": "...", "amount": 30, "reference_id": "t-1",
  "debit":  { "account_id": "A", "type": "debit",  "amount": 30, "transfer_id": "..." },
  "credit": { "account_id": "B", "type": "credit", "amount": 30, "transfer_id": "..." },
  "balances": { "A": 70, "B": 80 }
}
```

Errors: `400` (same account, invalid fields), `404 ACCOUNT_NOT_FOUND` (either account), `409 DUPLICATE_TRANSACTION` (reference already used on either account), `422 INSUFFICIENT_BALANCE`.

## GET /health

`200 { "status": "ok" }`
