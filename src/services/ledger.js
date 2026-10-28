const crypto = require('node:crypto');
const { withTransaction } = require('../db');
const { badRequest, notFound, conflict, unprocessable } = require('../errors');
const { toCents, fromCents, MAX_AMOUNT } = require('../money');

const TYPES = ['credit', 'debit'];
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;

const accountView = (row) => ({
  id: row.id,
  name: row.name,
  balance: fromCents(row.balance),
  created_at: row.created_at,
});

const transactionView = (row) => ({
  id: row.id,
  account_id: row.account_id,
  type: row.type,
  amount: fromCents(row.amount),
  description: row.description,
  reference_id: row.reference_id,
  transfer_id: row.transfer_id,
  created_at: row.created_at,
});

function createLedger(db) {
  const q = {
    insertAccount: db.prepare('INSERT INTO accounts (id, name, balance, created_at) VALUES (?, ?, 0, ?)'),
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    getTxnByRef: db.prepare('SELECT * FROM transactions WHERE account_id = ? AND reference_id = ?'),
    getTxn: db.prepare('SELECT * FROM transactions WHERE id = ?'),
    insertTxn: db.prepare(
      `INSERT INTO transactions (id, account_id, type, amount, description, reference_id, transfer_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    credit: db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?'),
    // Conditional update: the debit only applies if funds are sufficient.
    debit: db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND balance >= ?'),
  };

  function requireAccount(id) {
    const row = typeof id === 'string' ? q.getAccount.get(id) : undefined;
    if (!row) throw notFound('ACCOUNT_NOT_FOUND', `Account '${id}' not found`);
    return row;
  }

  // Validates the fields shared by transactions and transfers.
  function validateEntry(body, errors) {
    const entry = {};
    const cents = toCents(body.amount);
    if (cents === null) {
      errors.push({ field: 'amount', message: `amount must be a number greater than 0, with at most 2 decimals, up to ${MAX_AMOUNT}` });
    } else entry.cents = cents;

    if (!isNonEmptyString(body.reference_id, 128)) {
      errors.push({ field: 'reference_id', message: 'reference_id is required (non-empty string, max 128 chars)' });
    } else entry.referenceId = body.reference_id.trim();

    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 500)) {
      errors.push({ field: 'description', message: 'description must be a string of at most 500 chars' });
    } else entry.description = (body.description ?? '').trim();
    return entry;
  }

  // Must be called inside withTransaction. Inserts the ledger row and applies it to the balance.
  function post({ accountId, type, cents, description, referenceId, transferId = null }) {
    const existing = q.getTxnByRef.get(accountId, referenceId);
    if (existing) {
      throw conflict('DUPLICATE_TRANSACTION', `A transaction with reference_id '${referenceId}' already exists for this account`, {
        transaction: transactionView(existing),
      });
    }
    if (type === 'debit') {
      const res = q.debit.run(cents, accountId, cents);
      if (res.changes === 0) {
        const { balance } = q.getAccount.get(accountId);
        throw unprocessable('INSUFFICIENT_BALANCE', `Insufficient balance: available ${fromCents(balance)}, requested ${fromCents(cents)}`);
      }
    } else {
      q.credit.run(cents, accountId);
    }
    const id = crypto.randomUUID();
    q.insertTxn.run(id, accountId, type, cents, description, referenceId, transferId, new Date().toISOString());
    return q.getTxn.get(id);
  }

  return {
    createAccount(body) {
      if (!isPlainObject(body)) throw badRequest('INVALID_REQUEST_BODY', 'Request body must be a JSON object');
      const errors = [];
      if (body.balance !== undefined) {
        errors.push({ field: 'balance', message: 'balance cannot be set by the client; accounts always start at 0' });
      }
      if (!isNonEmptyString(body.name, 100)) {
        errors.push({ field: 'name', message: 'name is required (non-empty string, max 100 chars)' });
      }
      if (errors.length) throw badRequest('VALIDATION_ERROR', 'Invalid request data', errors);

      const id = crypto.randomUUID();
      q.insertAccount.run(id, body.name.trim(), new Date().toISOString());
      return accountView(q.getAccount.get(id));
    },

    getAccount: (id) => accountView(requireAccount(id)),

    getBalance(id) {
      const account = requireAccount(id);
      return { account_id: account.id, balance: fromCents(account.balance) };
    },

    createTransaction(body) {
      if (!isPlainObject(body)) throw badRequest('INVALID_REQUEST_BODY', 'Request body must be a JSON object');
      const errors = [];
      if (typeof body.account_id !== 'string' || !body.account_id.trim()) {
        errors.push({ field: 'account_id', message: 'account_id is required' });
      }
      if (!TYPES.includes(body.type)) errors.push({ field: 'type', message: "type must be either 'credit' or 'debit'" });
      const entry = validateEntry(body, errors);
      if (errors.length) {
        const code = errors.length > 1 ? 'VALIDATION_ERROR'
          : errors[0].field === 'type' ? 'INVALID_TRANSACTION_TYPE'
          : errors[0].field === 'amount' ? 'INVALID_AMOUNT'
          : 'VALIDATION_ERROR';
        throw badRequest(code, errors.length === 1 ? errors[0].message : 'Invalid request data', errors);
      }

      return withTransaction(db, () => {
        requireAccount(body.account_id);
        return transactionView(post({ accountId: body.account_id, type: body.type, ...entry }));
      });
    },

    transfer(body) {
      if (!isPlainObject(body)) throw badRequest('INVALID_REQUEST_BODY', 'Request body must be a JSON object');
      const errors = [];
      for (const f of ['from_account_id', 'to_account_id']) {
        if (typeof body[f] !== 'string' || !body[f].trim()) errors.push({ field: f, message: `${f} is required` });
      }
      if (!errors.length && body.from_account_id === body.to_account_id) {
        errors.push({ field: 'to_account_id', message: 'Cannot transfer to the same account' });
      }
      const entry = validateEntry(body, errors);
      if (errors.length) throw badRequest('VALIDATION_ERROR', 'Invalid request data', errors);

      // Both legs run in one DB transaction: any failure rolls back the whole transfer.
      return withTransaction(db, () => {
        requireAccount(body.from_account_id);
        requireAccount(body.to_account_id);
        const transferId = crypto.randomUUID();
        const base = { cents: entry.cents, referenceId: entry.referenceId, transferId };
        const debit = post({
          ...base, accountId: body.from_account_id, type: 'debit',
          description: entry.description || `Transfer to ${body.to_account_id}`,
        });
        const credit = post({
          ...base, accountId: body.to_account_id, type: 'credit',
          description: entry.description || `Transfer from ${body.from_account_id}`,
        });
        return {
          transfer_id: transferId,
          amount: fromCents(entry.cents),
          reference_id: entry.referenceId,
          debit: transactionView(debit),
          credit: transactionView(credit),
          balances: {
            [body.from_account_id]: fromCents(q.getAccount.get(body.from_account_id).balance),
            [body.to_account_id]: fromCents(q.getAccount.get(body.to_account_id).balance),
          },
        };
      });
    },

    getTransaction(id) {
      const row = q.getTxn.get(id);
      if (!row) throw notFound('TRANSACTION_NOT_FOUND', `Transaction '${id}' not found`);
      return transactionView(row);
    },

    listTransactions(accountId, query) {
      const errors = [];
      const parsePositiveInt = (name, raw, def, max) => {
        if (raw === undefined) return def;
        if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || (max && Number(raw) > max)) {
          errors.push({ field: name, message: `${name} must be a positive integer${max ? ` (max ${max})` : ''}` });
          return def;
        }
        return Number(raw);
      };
      const page = parsePositiveInt('page', query.page, 1);
      const limit = parsePositiveInt('limit', query.limit, DEFAULT_LIMIT, MAX_LIMIT);
      let type;
      if (query.type !== undefined) {
        if (!TYPES.includes(query.type)) errors.push({ field: 'type', message: "type must be 'credit' or 'debit'" });
        else type = query.type;
      }
      if (errors.length) throw badRequest('INVALID_PAGINATION_PARAMETERS', 'Invalid query parameters', errors);

      requireAccount(accountId);
      const where = type ? 'account_id = ? AND type = ?' : 'account_id = ?';
      const params = type ? [accountId, type] : [accountId];
      const { total } = db.prepare(`SELECT COUNT(*) AS total FROM transactions WHERE ${where}`).get(...params);
      // Latest first; seq breaks ties between rows created in the same millisecond.
      const rows = db
        .prepare(`SELECT * FROM transactions WHERE ${where} ORDER BY created_at DESC, seq DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, (page - 1) * limit);
      return {
        data: rows.map(transactionView),
        pagination: { current_page: page, page_size: limit, total_records: total, total_pages: Math.ceil(total / limit) },
      };
    },
  };
}

module.exports = { createLedger };
