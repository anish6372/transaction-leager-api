const express = require('express');
const { createLedger } = require('./services/ledger');
const { AppError } = require('./errors');

function createApp(db) {
  const ledger = createLedger(db);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.post('/accounts', (req, res) => res.status(201).json(ledger.createAccount(req.body)));
  app.get('/accounts/:id', (req, res) => res.json(ledger.getAccount(req.params.id)));
  app.get('/accounts/:id/balance', (req, res) => res.json(ledger.getBalance(req.params.id)));
  app.get('/accounts/:id/transactions', (req, res) =>
    res.json(ledger.listTransactions(req.params.id, req.query)));

  app.post('/transactions', (req, res) => res.status(201).json(ledger.createTransaction(req.body)));
  app.get('/transactions/:id', (req, res) => res.json(ledger.getTransaction(req.params.id)));
  // Transactions are immutable: no update/delete through the API.
  app.all(['/transactions', '/transactions/:id'], (req, res, next) => {
    if (['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      res.set('Allow', req.params.id ? 'GET' : 'POST');
      throw new AppError(405, 'TRANSACTION_IMMUTABLE', 'Transactions cannot be modified or deleted');
    }
    next();
  });

  app.post('/transfers', (req, res) => res.status(201).json(ledger.transfer(req.body)));

  app.use((req, res, next) => next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`)));

  // Single error shape: { error: { code, message, details? } }
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let e = err;
    if (err.type === 'entity.parse.failed') e = new AppError(400, 'INVALID_REQUEST_BODY', 'Request body is not valid JSON');
    else if (err.type === 'entity.too.large') e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    else if (!(err instanceof AppError)) {
      console.error(err);
      e = new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
    }
    const body = { code: e.code, message: e.message };
    if (e.details) body.details = e.details;
    res.status(e.status).json({ error: body });
  });

  return app;
}

module.exports = { createApp };
