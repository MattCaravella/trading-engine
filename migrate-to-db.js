#!/usr/bin/env node
/**
 * Migration Script — Import existing JSON/CSV/JSONL data into SQLite
 *
 * Usage: node migrate-to-db.js
 *
 * This script imports all existing trade data from JSON files into the
 * SQLite database. Original files are preserved as backup.
 *
 * Safe to run multiple times — uses INSERT OR IGNORE for orders and
 * equity snapshots to avoid duplicates.
 */

console.log('='.repeat(60));
console.log('  Trading System — JSON to SQLite Migration');
console.log('='.repeat(60));
console.log('');

const database = require('./database');

if (!database.db) {
  console.error('ERROR: Could not open SQLite database. Aborting.');
  process.exit(1);
}

console.log('Database initialized at trade_history/trading.db');
console.log('Starting migration...\n');

const results = database.migrateFromJSON();

console.log('');
if (results.errors && results.errors.length > 0) {
  console.log(`Migration completed with ${results.errors.length} error(s).`);
} else {
  console.log('Migration completed successfully.');
}

// Verify by querying the database
console.log('\n── Verification ──────────────────────────────────');
try {
  const orderCount = database.db.prepare('SELECT COUNT(*) as cnt FROM orders').get();
  const tradeCount = database.db.prepare('SELECT COUNT(*) as cnt FROM trades').get();
  const transCount = database.db.prepare('SELECT COUNT(*) as cnt FROM signal_transitions').get();
  const cycleCount = database.db.prepare('SELECT COUNT(*) as cnt FROM cycles').get();
  const equityCount = database.db.prepare('SELECT COUNT(*) as cnt FROM equity_snapshots').get();
  const govCount = database.db.prepare('SELECT COUNT(*) as cnt FROM governor_state').get();
  const engCount = database.db.prepare('SELECT COUNT(*) as cnt FROM engine_state').get();
  const calCount = database.db.prepare('SELECT COUNT(*) as cnt FROM calibration').get();

  console.log(`  orders table:             ${orderCount.cnt} rows`);
  console.log(`  trades table:             ${tradeCount.cnt} rows`);
  console.log(`  signal_transitions table: ${transCount.cnt} rows`);
  console.log(`  cycles table:             ${cycleCount.cnt} rows`);
  console.log(`  equity_snapshots table:   ${equityCount.cnt} rows`);
  console.log(`  governor_state table:     ${govCount.cnt} rows`);
  console.log(`  engine_state table:       ${engCount.cnt} rows`);
  console.log(`  calibration table:        ${calCount.cnt} rows`);
} catch (err) {
  console.error('Verification query failed:', err.message);
}

database.close();
console.log('\nDone. Original JSON files have been preserved.');
