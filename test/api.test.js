const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

let server, base, db;

before(async () => {
  db = openDatabase(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); db.close(); });

async function call(method, path, body, raw) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {},
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: await res.json() };
}

let refCounter = 0;
const ref = () => `ref-${++refCounter}`;
const newAccount = async (name = 'Alice') => (await call('POST', '/accounts', { name })).body;
const txn = (account_id, type, amount, extra = {}) =>
  call('POST', '/transactions', { account_id, type, amount, reference_id: ref(), description: 'test', ...extra });
const balanceOf = async (id) => (await call('GET', `/accounts/${id}/balance`)).body.balance;

describe('accounts', () => {
  test('creates account with zero balance and system fields', async () => {
    const res = await call('POST', '/accounts', { name: '  Alice ' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Alice');
    assert.equal(res.body.balance, 0);
    assert.ok(res.body.id);
    assert.ok(!Number.isNaN(Date.parse(res.body.created_at)));
  });

  test('ids are unique', async () => {
    const a = await newAccount();
    const b = await newAccount();
    assert.notEqual(a.id, b.id);
  });

  test('client cannot set initial balance', async () => {
    const res = await call('POST', '/accounts', { name: 'Bob', balance: 500 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  test('name is required', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 5 }]) {
      const res = await call('POST', '/accounts', body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
  });

  test('malformed JSON and non-object bodies are rejected', async () => {
    const bad = await call('POST', '/accounts', undefined, '{oops');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_REQUEST_BODY');
    const arr = await call('POST', '/accounts', []);
    assert.equal(arr.status, 400);
    assert.equal(arr.body.error.code, 'INVALID_REQUEST_BODY');
  });
});

describe('transactions', () => {
  test('credit increases and debit decreases balance', async () => {
    const { id } = await newAccount();
    const c = await txn(id, 'credit', 100);
    assert.equal(c.status, 201);
    assert.equal(c.body.type, 'credit');
    assert.equal(c.body.amount, 100);
    assert.equal(await balanceOf(id), 100);
    assert.equal((await txn(id, 'credit', 50)).status, 201);
    assert.equal(await balanceOf(id), 150);
    assert.equal((await txn(id, 'debit', 30)).status, 201);
    assert.equal(await balanceOf(id), 120);
  });

  test('balance consistency example from the spec', async () => {
    const { id } = await newAccount();
    await txn(id, 'credit', 100);
    await txn(id, 'credit', 50);
    await txn(id, 'debit', 30);
    await txn(id, 'debit', 20);
    assert.equal(await balanceOf(id), 100);
  });

  test('debit with insufficient balance is rejected and balance unchanged', async () => {
    const { id } = await newAccount();
    await txn(id, 'credit', 100);
    const res = await txn(id, 'debit', 150);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'INSUFFICIENT_BALANCE');
    assert.equal(await balanceOf(id), 100);
    const list = await call('GET', `/accounts/${id}/transactions`);
    assert.equal(list.body.pagination.total_records, 1); // rejected txn is not recorded
  });

  test('debit of the exact balance is allowed', async () => {
    const { id } = await newAccount();
    await txn(id, 'credit', 100);
    assert.equal((await txn(id, 'debit', 100)).status, 201);
    assert.equal(await balanceOf(id), 0);
  });

  test('duplicate reference_id on same account returns 409 and changes nothing', async () => {
    const { id } = await newAccount();
    const body = { account_id: id, type: 'credit', amount: 40, reference_id: 'dup-1', description: 'x' };
    const first = await call('POST', '/transactions', body);
    assert.equal(first.status, 201);
    const second = await call('POST', '/transactions', body);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'DUPLICATE_TRANSACTION');
    assert.equal(second.body.error.details.transaction.id, first.body.id);
    assert.equal(await balanceOf(id), 40);
    assert.equal((await call('GET', `/accounts/${id}/transactions`)).body.pagination.total_records, 1);
  });

  test('same reference_id may be used on different accounts', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const body = { type: 'credit', amount: 10, reference_id: 'shared-ref' };
    assert.equal((await call('POST', '/transactions', { ...body, account_id: a.id })).status, 201);
    assert.equal((await call('POST', '/transactions', { ...body, account_id: b.id })).status, 201);
  });

  test('validation errors', async () => {
    const { id } = await newAccount();
    const missingAccount = await txn('nope', 'credit', 10);
    assert.equal(missingAccount.status, 404);
    assert.equal(missingAccount.body.error.code, 'ACCOUNT_NOT_FOUND');

    const badType = await txn(id, 'refund', 10);
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.code, 'INVALID_TRANSACTION_TYPE');

    for (const amount of [0, -5, '10', null, 1.005, NaN, 1e12]) {
      const res = await txn(id, 'credit', amount);
      assert.equal(res.status, 400, `amount ${amount}`);
      assert.equal(res.body.error.code, 'INVALID_AMOUNT');
    }

    for (const reference_id of [undefined, '', '  ', 7]) {
      const res = await txn(id, 'credit', 10, { reference_id });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }

    const noAccountId = await call('POST', '/transactions', { type: 'credit', amount: 1, reference_id: 'x' });
    assert.equal(noAccountId.status, 400);
    assert.equal(await balanceOf(id), 0);
  });

  test('decimal amounts are exact', async () => {
    const { id } = await newAccount();
    for (let i = 0; i < 10; i++) await txn(id, 'credit', 0.1);
    assert.equal(await balanceOf(id), 1);
    await txn(id, 'debit', 0.3);
    assert.equal(await balanceOf(id), 0.7);
  });

  test('transactions are immutable via the API', async () => {
    const { id } = await newAccount();
    const t = (await txn(id, 'credit', 10)).body;
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await call(method, `/transactions/${t.id}`, method === 'DELETE' ? undefined : { amount: 999 });
      assert.equal(res.status, 405);
      assert.equal(res.body.error.code, 'TRANSACTION_IMMUTABLE');
    }
    assert.deepEqual((await call('GET', `/transactions/${t.id}`)).body, t);
    assert.equal(await balanceOf(id), 10);
  });

  test('transactions are immutable at the database level', async () => {
    const { id } = await newAccount();
    const t = (await txn(id, 'credit', 10)).body;
    assert.throws(() => db.prepare('UPDATE transactions SET amount = 1 WHERE id = ?').run(t.id), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM transactions WHERE id = ?').run(t.id), /immutable/);
  });

  test('database refuses a negative balance', () => {
    const id = (db.prepare("SELECT id FROM accounts LIMIT 1").get()).id;
    assert.throws(() => db.prepare('UPDATE accounts SET balance = -1 WHERE id = ?').run(id), /CHECK/);
  });

  test('failure after the balance update rolls everything back (atomicity)', async () => {
    const { id } = await newAccount();
    await txn(id, 'credit', 100);
    db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON transactions WHEN NEW.reference_id = 'boom'
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    try {
      const res = await txn(id, 'debit', 40, { reference_id: 'boom' });
      assert.equal(res.status, 500);
      assert.equal(await balanceOf(id), 100); // debit was rolled back
    } finally {
      db.exec('DROP TRIGGER fail_insert');
    }
  });

  test('concurrent debits never overdraw', async () => {
    const { id } = await newAccount();
    await txn(id, 'credit', 100);
    const results = await Promise.all(Array.from({ length: 10 }, () => txn(id, 'debit', 30)));
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal(await balanceOf(id), 10);
  });
});

describe('balance', () => {
  test('returns account_id and balance', async () => {
    const { id } = await newAccount();
    await txn(id, 'credit', 25);
    assert.deepEqual((await call('GET', `/accounts/${id}/balance`)).body, { account_id: id, balance: 25 });
  });

  test('unknown account returns 404', async () => {
    const res = await call('GET', '/accounts/missing/balance');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ACCOUNT_NOT_FOUND');
  });
});

describe('transaction history', () => {
  let id;
  before(async () => {
    id = (await newAccount('History')).id;
    for (let i = 1; i <= 7; i++) await txn(id, 'credit', i, { description: `credit ${i}` });
    for (let i = 1; i <= 3; i++) await txn(id, 'debit', 1, { description: `debit ${i}` });
  });

  test('returns all types, latest first, with pagination metadata', async () => {
    const res = await call('GET', `/accounts/${id}/transactions`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.pagination, { current_page: 1, page_size: 10, total_records: 10, total_pages: 1 });
    assert.equal(res.body.data[0].description, 'debit 3');
    assert.equal(res.body.data[9].description, 'credit 1');
    const times = res.body.data.map((t) => t.created_at);
    assert.deepEqual(times, [...times].sort().reverse());
  });

  test('filters by type', async () => {
    const credits = await call('GET', `/accounts/${id}/transactions?type=credit`);
    assert.equal(credits.body.pagination.total_records, 7);
    assert.ok(credits.body.data.every((t) => t.type === 'credit'));
    const debits = await call('GET', `/accounts/${id}/transactions?type=debit`);
    assert.equal(debits.body.pagination.total_records, 3);
  });

  test('paginates', async () => {
    const p1 = await call('GET', `/accounts/${id}/transactions?page=1&limit=4`);
    const p3 = await call('GET', `/accounts/${id}/transactions?page=3&limit=4`);
    const p4 = await call('GET', `/accounts/${id}/transactions?page=4&limit=4`);
    assert.deepEqual(p1.body.pagination, { current_page: 1, page_size: 4, total_records: 10, total_pages: 3 });
    assert.equal(p1.body.data.length, 4);
    assert.equal(p3.body.data.length, 2);
    assert.equal(p4.body.data.length, 0);
  });

  test('rejects invalid query parameters', async () => {
    for (const qs of ['page=0', 'page=-1', 'page=abc', 'limit=0', 'limit=1000', 'limit=1.5', 'type=refund']) {
      const res = await call('GET', `/accounts/${id}/transactions?${qs}`);
      assert.equal(res.status, 400, qs);
      assert.equal(res.body.error.code, 'INVALID_PAGINATION_PARAMETERS');
    }
  });

  test('unknown account returns 404', async () => {
    assert.equal((await call('GET', '/accounts/missing/transactions')).status, 404);
  });
});

describe('transfers', () => {
  const transfer = (from, to, amount, extra = {}) =>
    call('POST', '/transfers', { from_account_id: from, to_account_id: to, amount, reference_id: ref(), ...extra });

  test('moves money atomically between accounts', async () => {
    const a = await newAccount('A');
    const b = await newAccount('B');
    await txn(a.id, 'credit', 100);
    await txn(b.id, 'credit', 50);
    const res = await transfer(a.id, b.id, 30);
    assert.equal(res.status, 201);
    assert.equal(res.body.debit.account_id, a.id);
    assert.equal(res.body.credit.account_id, b.id);
    assert.equal(res.body.debit.transfer_id, res.body.credit.transfer_id);
    assert.equal(await balanceOf(a.id), 70);
    assert.equal(await balanceOf(b.id), 80);
  });

  test('insufficient funds: nothing changes', async () => {
    const a = await newAccount('A');
    const b = await newAccount('B');
    await txn(a.id, 'credit', 10);
    const res = await transfer(a.id, b.id, 20);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'INSUFFICIENT_BALANCE');
    assert.equal(await balanceOf(a.id), 10);
    assert.equal(await balanceOf(b.id), 0);
  });

  test('missing destination account: nothing changes', async () => {
    const a = await newAccount('A');
    await txn(a.id, 'credit', 10);
    const res = await transfer(a.id, 'ghost', 5);
    assert.equal(res.status, 404);
    assert.equal(await balanceOf(a.id), 10);
  });

  test('failure on the credit leg rolls back the debit leg', async () => {
    const a = await newAccount('A');
    const b = await newAccount('B');
    await txn(a.id, 'credit', 100);
    // Pre-existing reference on the destination makes the second leg fail as a duplicate.
    await call('POST', '/transactions', { account_id: b.id, type: 'credit', amount: 1, reference_id: 'taken' });
    const res = await transfer(a.id, b.id, 40, { reference_id: 'taken' });
    assert.equal(res.status, 409);
    assert.equal(await balanceOf(a.id), 100);
    assert.equal(await balanceOf(b.id), 1);
    assert.equal((await call('GET', `/accounts/${a.id}/transactions`)).body.pagination.total_records, 1);
  });

  test('duplicate transfer reference is rejected without effect', async () => {
    const a = await newAccount('A');
    const b = await newAccount('B');
    await txn(a.id, 'credit', 100);
    const body = { from_account_id: a.id, to_account_id: b.id, amount: 10, reference_id: 'tr-1' };
    assert.equal((await call('POST', '/transfers', body)).status, 201);
    assert.equal((await call('POST', '/transfers', body)).status, 409);
    assert.equal(await balanceOf(a.id), 90);
    assert.equal(await balanceOf(b.id), 10);
  });

  test('validation: same account, bad amount, missing fields', async () => {
    const a = await newAccount('A');
    assert.equal((await transfer(a.id, a.id, 5)).status, 400);
    assert.equal((await transfer(a.id, 'x', -5)).status, 400);
    assert.equal((await call('POST', '/transfers', {})).status, 400);
  });
});

describe('misc', () => {
  test('unknown routes return a consistent 404', async () => {
    const res = await call('GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  test('health check', async () => {
    assert.deepEqual((await call('GET', '/health')).body, { status: 'ok' });
  });
});
