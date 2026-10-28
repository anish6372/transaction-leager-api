const { openDatabase } = require('./db');
const { createApp } = require('./app');

const port = process.env.PORT || 3000;
const dbFile = process.env.DB_FILE || 'data/ledger.db';

const db = openDatabase(dbFile);
const server = createApp(db).listen(port, () => {
  console.log(`Ledger API listening on http://localhost:${port} (db: ${dbFile})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
