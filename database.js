/**
 * Database — SQLite Persistence Layer
 *
 * Replaces individual JSON/CSV/JSONL files with a single SQLite database.
 * Uses better-sqlite3 (synchronous API) for simplicity and reliability.
 *
 * Database file: trade_history/trading.db
 *
 * All operations are wrapped in try-catch so the system never crashes
 * due to a SQLite issue. Falls back to JSON where applicable.
 */

const Database = require('better-sqlite3');
const fs   = require('fs');
const path = require('path');

const DB_PATH     = path.join(__dirname, 'trade_history/trading.db');
const HISTORY_DIR = path.join(__dirname, 'trade_history');

// ─── Ensure directory exists ────────────────────────────────────────────────
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// ─── Initialize database ────────────────────────────────────────────────────
let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (err) {
  console.error('[Database] Failed to open SQLite database:', err.message);
  db = null;
}

// ─── Create tables ──────────────────────────────────────────────────────────
function createTables() {
  if (!db) return;
  try {
    db.exec(`
      -- All trade orders (replaces trade_history.csv + individual JSON files)
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        qty INTEGER,
        type TEXT,
        time_in_force TEXT,
        status TEXT,
        submitted_at TEXT,
        filled_at TEXT,
        filled_avg_price REAL,
        reason TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Closed trade analysis (replaces performance_ledger.json)
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        entry_price REAL,
        exit_price REAL,
        qty INTEGER,
        pnl_pct REAL,
        pnl_dollar REAL,
        is_win INTEGER,
        exit_reason TEXT,
        holding_hours REAL,
        sources TEXT,
        buy_reason TEXT,
        entry_time TEXT,
        exit_time TEXT,
        order_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Signal state transitions (replaces signal_transitions.jsonl)
      CREATE TABLE IF NOT EXISTS signal_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT,
        ticker TEXT,
        source TEXT,
        score REAL,
        direction TEXT,
        from_state TEXT,
        to_state TEXT,
        reason TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Trading cycle snapshots (replaces cycle_log.jsonl)
      CREATE TABLE IF NOT EXISTS cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equity REAL,
        positions INTEGER,
        total_signals INTEGER,
        confirmed INTEGER,
        executed INTEGER,
        rejected INTEGER,
        rejections TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Daily equity snapshots (replaces equity_curve.json)
      CREATE TABLE IF NOT EXISTS equity_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE,
        equity REAL,
        positions INTEGER,
        buys INTEGER,
        sells INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Governor state (replaces governor_state.json)
      CREATE TABLE IF NOT EXISTS governor_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Engine state (replaces engine_state.json)
      CREATE TABLE IF NOT EXISTS engine_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Strategy calibration (replaces calibration.json)
      CREATE TABLE IF NOT EXISTS calibration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        adjusted_weights TEXT,
        killed_strategies TEXT,
        source_stats TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (err) {
    console.error('[Database] Failed to create tables:', err.message);
  }
}

// ─── Create indexes ─────────────────────────────────────────────────────────
function createIndexes() {
  if (!db) return;
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);
      CREATE INDEX IF NOT EXISTS idx_orders_submitted_at ON orders(submitted_at);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_exit_reason ON trades(exit_reason);
      CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
      CREATE INDEX IF NOT EXISTS idx_signal_transitions_ticker ON signal_transitions(ticker);
      CREATE INDEX IF NOT EXISTS idx_signal_transitions_signal_id ON signal_transitions(signal_id);
      CREATE INDEX IF NOT EXISTS idx_signal_transitions_created_at ON signal_transitions(created_at);
      CREATE INDEX IF NOT EXISTS idx_equity_snapshots_date ON equity_snapshots(date);
    `);
  } catch (err) {
    console.error('[Database] Failed to create indexes:', err.message);
  }
}

// Initialize on load
createTables();
createIndexes();

// ─── Prepared statements (lazy-initialized) ─────────────────────────────────
let _stmts = {};

function getStmt(name, sql) {
  if (!db) return null;
  if (!_stmts[name]) {
    try {
      _stmts[name] = db.prepare(sql);
    } catch (err) {
      console.error(`[Database] Failed to prepare statement '${name}':`, err.message);
      return null;
    }
  }
  return _stmts[name];
}

// ═══════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════

function insertOrder(order) {
  if (!db) return;
  try {
    const stmt = getStmt('insertOrder', `
      INSERT OR REPLACE INTO orders (id, symbol, side, qty, type, time_in_force, status, submitted_at, filled_at, filled_avg_price, reason, raw_json)
      VALUES (@id, @symbol, @side, @qty, @type, @time_in_force, @status, @submitted_at, @filled_at, @filled_avg_price, @reason, @raw_json)
    `);
    if (!stmt) return;
    stmt.run({
      id: order.id || null,
      symbol: order.symbol || null,
      side: order.side || null,
      qty: parseInt(order.qty) || null,
      type: order.type || order.order_type || null,
      time_in_force: order.time_in_force || null,
      status: order.status || null,
      submitted_at: order.submitted_at || null,
      filled_at: order.filled_at || null,
      filled_avg_price: order.filled_avg_price ? parseFloat(order.filled_avg_price) : null,
      reason: order.engine_reason || null,
      raw_json: JSON.stringify(order),
    });
  } catch (err) {
    console.error('[Database] insertOrder error:', err.message);
  }
}

function getOrderById(id) {
  if (!db) return null;
  try {
    const stmt = getStmt('getOrderById', 'SELECT * FROM orders WHERE id = ?');
    if (!stmt) return null;
    const row = stmt.get(id);
    if (row && row.raw_json) {
      try { row.parsed = JSON.parse(row.raw_json); } catch {}
    }
    return row || null;
  } catch (err) {
    console.error('[Database] getOrderById error:', err.message);
    return null;
  }
}

function getOrdersBySymbol(symbol) {
  if (!db) return [];
  try {
    const stmt = getStmt('getOrdersBySymbol', 'SELECT * FROM orders WHERE symbol = ? ORDER BY submitted_at DESC');
    if (!stmt) return [];
    return stmt.all(symbol);
  } catch (err) {
    console.error('[Database] getOrdersBySymbol error:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADES (closed)
// ═══════════════════════════════════════════════════════════════════════════

function insertTrade(trade) {
  if (!db) return;
  try {
    const stmt = getStmt('insertTrade', `
      INSERT INTO trades (symbol, entry_price, exit_price, qty, pnl_pct, pnl_dollar, is_win, exit_reason, holding_hours, sources, buy_reason, entry_time, exit_time, order_id)
      VALUES (@symbol, @entry_price, @exit_price, @qty, @pnl_pct, @pnl_dollar, @is_win, @exit_reason, @holding_hours, @sources, @buy_reason, @entry_time, @exit_time, @order_id)
    `);
    if (!stmt) return;
    stmt.run({
      symbol: trade.symbol || null,
      entry_price: trade.entryPrice != null ? trade.entryPrice : (trade.entry_price != null ? trade.entry_price : null),
      exit_price: trade.exitPrice != null ? trade.exitPrice : (trade.exit_price != null ? trade.exit_price : null),
      qty: trade.qty != null ? parseInt(trade.qty) : null,
      pnl_pct: trade.pnlPct != null ? trade.pnlPct : (trade.pnl_pct != null ? trade.pnl_pct : null),
      pnl_dollar: trade.pnlDollar != null ? trade.pnlDollar : (trade.pnl_dollar != null ? trade.pnl_dollar : null),
      is_win: trade.isWin != null ? (trade.isWin ? 1 : 0) : (trade.is_win != null ? trade.is_win : null),
      exit_reason: trade.exitReason || trade.exit_reason || null,
      holding_hours: trade.holdingHours != null ? trade.holdingHours : (trade.holding_hours != null ? trade.holding_hours : null),
      sources: JSON.stringify(trade.sources || []),
      buy_reason: trade.buyReason || trade.buy_reason || null,
      entry_time: trade.entryTime || trade.entry_time || null,
      exit_time: trade.exitTime || trade.exit_time || null,
      order_id: trade.orderId || trade.order_id || null,
    });
  } catch (err) {
    console.error('[Database] insertTrade error:', err.message);
  }
}

function getAllTrades() {
  if (!db) return [];
  try {
    const stmt = getStmt('getAllTrades', 'SELECT * FROM trades ORDER BY created_at ASC');
    if (!stmt) return [];
    const rows = stmt.all();
    return rows.map(_parseTradeRow);
  } catch (err) {
    console.error('[Database] getAllTrades error:', err.message);
    return [];
  }
}

function getTradesBySymbol(symbol) {
  if (!db) return [];
  try {
    const stmt = getStmt('getTradesBySymbol', 'SELECT * FROM trades WHERE symbol = ? ORDER BY created_at ASC');
    if (!stmt) return [];
    return stmt.all(symbol).map(_parseTradeRow);
  } catch (err) {
    console.error('[Database] getTradesBySymbol error:', err.message);
    return [];
  }
}

function getTradeStats() {
  if (!db) return null;
  try {
    const stmt = getStmt('getTradeStats', `
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN is_win = 0 THEN 1 ELSE 0 END) as losses,
        ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
        ROUND(SUM(pnl_dollar), 2) as total_pnl_dollar,
        ROUND(AVG(holding_hours), 1) as avg_holding_hours,
        ROUND(CAST(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0) * 100, 1) as win_rate
      FROM trades
    `);
    if (!stmt) return null;
    return stmt.get();
  } catch (err) {
    console.error('[Database] getTradeStats error:', err.message);
    return null;
  }
}

function isOrderProcessed(orderId) {
  if (!db) return false;
  try {
    const stmt = getStmt('isOrderProcessed', 'SELECT COUNT(*) as cnt FROM trades WHERE order_id = ?');
    if (!stmt) return false;
    const row = stmt.get(orderId);
    return row && row.cnt > 0;
  } catch (err) {
    console.error('[Database] isOrderProcessed error:', err.message);
    return false;
  }
}

function _parseTradeRow(row) {
  if (!row) return row;
  return {
    ...row,
    // Map snake_case DB columns back to camelCase used by the app
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    pnlPct: row.pnl_pct,
    pnlDollar: row.pnl_dollar,
    isWin: row.is_win === 1,
    exitReason: row.exit_reason,
    holdingHours: row.holding_hours,
    sources: _parseJSON(row.sources, []),
    buyReason: row.buy_reason,
    entryTime: row.entry_time,
    exitTime: row.exit_time,
    orderId: row.order_id,
  };
}

function _parseJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════════

function insertSignalTransition(transition) {
  if (!db) return;
  try {
    const stmt = getStmt('insertSignalTransition', `
      INSERT INTO signal_transitions (signal_id, ticker, source, score, direction, from_state, to_state, reason)
      VALUES (@signal_id, @ticker, @source, @score, @direction, @from_state, @to_state, @reason)
    `);
    if (!stmt) return;
    stmt.run({
      signal_id: transition.signalId || transition.signal_id || null,
      ticker: transition.ticker || null,
      source: transition.source || null,
      score: transition.score != null ? transition.score : null,
      direction: transition.direction || null,
      from_state: transition.from || transition.from_state || null,
      to_state: transition.to || transition.to_state || null,
      reason: transition.reason || null,
    });
  } catch (err) {
    console.error('[Database] insertSignalTransition error:', err.message);
  }
}

function getSignalHistory(signalId) {
  if (!db) return [];
  try {
    const stmt = getStmt('getSignalHistory', 'SELECT * FROM signal_transitions WHERE signal_id = ? ORDER BY created_at ASC');
    if (!stmt) return [];
    return stmt.all(signalId);
  } catch (err) {
    console.error('[Database] getSignalHistory error:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CYCLES
// ═══════════════════════════════════════════════════════════════════════════

function insertCycle(cycle) {
  if (!db) return;
  try {
    const stmt = getStmt('insertCycle', `
      INSERT INTO cycles (equity, positions, total_signals, confirmed, executed, rejected, rejections)
      VALUES (@equity, @positions, @total_signals, @confirmed, @executed, @rejected, @rejections)
    `);
    if (!stmt) return;
    stmt.run({
      equity: cycle.equity != null ? cycle.equity : null,
      positions: cycle.positions != null ? cycle.positions : null,
      total_signals: cycle.total != null ? cycle.total : (cycle.total_signals != null ? cycle.total_signals : null),
      confirmed: cycle.confirmed != null ? cycle.confirmed : null,
      executed: cycle.executed != null ? cycle.executed : null,
      rejected: cycle.rejected != null ? cycle.rejected : null,
      rejections: cycle.rejections ? JSON.stringify(cycle.rejections) : null,
    });
  } catch (err) {
    console.error('[Database] insertCycle error:', err.message);
  }
}

function getRecentCycles(n) {
  if (!db) return [];
  try {
    const stmt = getStmt('getRecentCycles', 'SELECT * FROM cycles ORDER BY created_at DESC LIMIT ?');
    if (!stmt) return [];
    const rows = stmt.all(n);
    return rows.map(row => ({
      ...row,
      rejections: _parseJSON(row.rejections, {}),
    }));
  } catch (err) {
    console.error('[Database] getRecentCycles error:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EQUITY SNAPSHOTS
// ═══════════════════════════════════════════════════════════════════════════

function upsertEquitySnapshot(snapshot) {
  if (!db) return;
  try {
    const stmt = getStmt('upsertEquitySnapshot', `
      INSERT OR REPLACE INTO equity_snapshots (date, equity, positions, buys, sells)
      VALUES (@date, @equity, @positions, @buys, @sells)
    `);
    if (!stmt) return;
    stmt.run({
      date: snapshot.date || new Date().toISOString().slice(0, 10),
      equity: snapshot.equity != null ? snapshot.equity : null,
      positions: snapshot.positions != null ? snapshot.positions : null,
      buys: snapshot.buys != null ? snapshot.buys : null,
      sells: snapshot.sells != null ? snapshot.sells : null,
    });
  } catch (err) {
    console.error('[Database] upsertEquitySnapshot error:', err.message);
  }
}

function getEquityCurve() {
  if (!db) return [];
  try {
    const stmt = getStmt('getEquityCurve', 'SELECT * FROM equity_snapshots ORDER BY date ASC');
    if (!stmt) return [];
    return stmt.all();
  } catch (err) {
    console.error('[Database] getEquityCurve error:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GOVERNOR STATE
// ═══════════════════════════════════════════════════════════════════════════

function getGovernorState() {
  if (!db) return null;
  try {
    const stmt = getStmt('getGovernorState', 'SELECT key, value FROM governor_state');
    if (!stmt) return null;
    const rows = stmt.all();
    if (rows.length === 0) return null;
    const state = {};
    for (const row of rows) {
      try { state[row.key] = JSON.parse(row.value); } catch { state[row.key] = row.value; }
    }
    return state;
  } catch (err) {
    console.error('[Database] getGovernorState error:', err.message);
    return null;
  }
}

function saveGovernorState(state) {
  if (!db) return;
  try {
    const stmt = getStmt('saveGovernorState', `
      INSERT OR REPLACE INTO governor_state (key, value, updated_at)
      VALUES (@key, @value, datetime('now'))
    `);
    if (!stmt) return;
    const saveTransaction = db.transaction((s) => {
      for (const [key, value] of Object.entries(s)) {
        stmt.run({ key, value: JSON.stringify(value) });
      }
    });
    saveTransaction(state);
  } catch (err) {
    console.error('[Database] saveGovernorState error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE STATE
// ═══════════════════════════════════════════════════════════════════════════

function getEngineState() {
  if (!db) return null;
  try {
    const stmt = getStmt('getEngineState', 'SELECT key, value FROM engine_state');
    if (!stmt) return null;
    const rows = stmt.all();
    if (rows.length === 0) return null;
    const state = {};
    for (const row of rows) {
      try { state[row.key] = JSON.parse(row.value); } catch { state[row.key] = row.value; }
    }
    return state;
  } catch (err) {
    console.error('[Database] getEngineState error:', err.message);
    return null;
  }
}

function saveEngineState(state) {
  if (!db) return;
  try {
    const stmt = getStmt('saveEngineState', `
      INSERT OR REPLACE INTO engine_state (key, value, updated_at)
      VALUES (@key, @value, datetime('now'))
    `);
    if (!stmt) return;
    const saveTransaction = db.transaction((s) => {
      for (const [key, value] of Object.entries(s)) {
        stmt.run({ key, value: JSON.stringify(value) });
      }
    });
    saveTransaction(state);
  } catch (err) {
    console.error('[Database] saveEngineState error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CALIBRATION
// ═══════════════════════════════════════════════════════════════════════════

function insertCalibration(cal) {
  if (!db) return;
  try {
    const stmt = getStmt('insertCalibration', `
      INSERT INTO calibration (adjusted_weights, killed_strategies, source_stats)
      VALUES (@adjusted_weights, @killed_strategies, @source_stats)
    `);
    if (!stmt) return;
    stmt.run({
      adjusted_weights: cal.adjustedWeights ? JSON.stringify(cal.adjustedWeights) : (cal.adjusted_weights || null),
      killed_strategies: cal.killedStrategies ? JSON.stringify(cal.killedStrategies) : (cal.killed_strategies || null),
      source_stats: cal.sourceStats ? JSON.stringify(cal.sourceStats) : (cal.source_stats || null),
    });
  } catch (err) {
    console.error('[Database] insertCalibration error:', err.message);
  }
}

function getLatestCalibration() {
  if (!db) return null;
  try {
    const stmt = getStmt('getLatestCalibration', 'SELECT * FROM calibration ORDER BY created_at DESC LIMIT 1');
    if (!stmt) return null;
    const row = stmt.get();
    if (!row) return null;
    return {
      ...row,
      adjustedWeights: _parseJSON(row.adjusted_weights, {}),
      killedStrategies: _parseJSON(row.killed_strategies, []),
      sourceStats: _parseJSON(row.source_stats, {}),
    };
  } catch (err) {
    console.error('[Database] getLatestCalibration error:', err.message);
    return null;
  }
}

function getCalibrationHistory(days) {
  if (!db) return [];
  try {
    const stmt = getStmt('getCalibrationHistory', `
      SELECT * FROM calibration
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC
    `);
    if (!stmt) return [];
    return stmt.all(days).map(row => ({
      ...row,
      adjustedWeights: _parseJSON(row.adjusted_weights, {}),
      killedStrategies: _parseJSON(row.killed_strategies, []),
      sourceStats: _parseJSON(row.source_stats, {}),
    }));
  } catch (err) {
    console.error('[Database] getCalibrationHistory error:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION — Import existing JSON/CSV/JSONL files
// ═══════════════════════════════════════════════════════════════════════════

function migrateFromJSON() {
  if (!db) {
    console.error('[Migration] Database not available');
    return { success: false, error: 'Database not available' };
  }

  const results = {
    orders: 0,
    trades: 0,
    signalTransitions: 0,
    cycles: 0,
    equitySnapshots: 0,
    governorState: false,
    engineState: false,
    errors: [],
  };

  // 1. Migrate individual order JSON files
  console.log('[Migration] Importing order JSON files...');
  try {
    const orderFiles = fs.readdirSync(HISTORY_DIR)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}_.*\.json$/) && !f.includes('performance') && !f.includes('equity') && !f.includes('governor') && !f.includes('engine') && !f.includes('calibration') && !f.includes('congress'));

    const insertOrderStmt = db.prepare(`
      INSERT OR IGNORE INTO orders (id, symbol, side, qty, type, time_in_force, status, submitted_at, filled_at, filled_avg_price, reason, raw_json)
      VALUES (@id, @symbol, @side, @qty, @type, @time_in_force, @status, @submitted_at, @filled_at, @filled_avg_price, @reason, @raw_json)
    `);

    const migrateOrders = db.transaction((files) => {
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
          if (!data.id) continue;
          insertOrderStmt.run({
            id: data.id,
            symbol: data.symbol || null,
            side: data.side || null,
            qty: parseInt(data.qty) || null,
            type: data.type || data.order_type || null,
            time_in_force: data.time_in_force || null,
            status: data.status || null,
            submitted_at: data.submitted_at || null,
            filled_at: data.filled_at || null,
            filled_avg_price: data.filled_avg_price ? parseFloat(data.filled_avg_price) : null,
            reason: data.engine_reason || null,
            raw_json: JSON.stringify(data),
          });
          results.orders++;
        } catch (err) {
          results.errors.push(`Order file ${f}: ${err.message}`);
        }
      }
    });
    migrateOrders(orderFiles);
    console.log(`[Migration]   Orders: ${results.orders} imported from ${orderFiles.length} files`);
  } catch (err) {
    results.errors.push(`Order migration: ${err.message}`);
    console.error('[Migration]   Order migration failed:', err.message);
  }

  // 2. Migrate performance_ledger.json (trades)
  console.log('[Migration] Importing performance ledger...');
  try {
    const ledgerFile = path.join(HISTORY_DIR, 'performance_ledger.json');
    if (fs.existsSync(ledgerFile)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      const trades = ledger.trades || [];

      const insertTradeStmt = db.prepare(`
        INSERT INTO trades (symbol, entry_price, exit_price, qty, pnl_pct, pnl_dollar, is_win, exit_reason, holding_hours, sources, buy_reason, entry_time, exit_time, order_id)
        VALUES (@symbol, @entry_price, @exit_price, @qty, @pnl_pct, @pnl_dollar, @is_win, @exit_reason, @holding_hours, @sources, @buy_reason, @entry_time, @exit_time, @order_id)
      `);

      const migrateTrades = db.transaction((tradeList) => {
        for (const t of tradeList) {
          insertTradeStmt.run({
            symbol: t.symbol || null,
            entry_price: t.entryPrice != null ? t.entryPrice : null,
            exit_price: t.exitPrice != null ? t.exitPrice : null,
            qty: t.qty != null ? parseInt(t.qty) : null,
            pnl_pct: t.pnlPct != null ? t.pnlPct : null,
            pnl_dollar: t.pnlDollar != null ? t.pnlDollar : null,
            is_win: t.isWin ? 1 : 0,
            exit_reason: t.exitReason || null,
            holding_hours: t.holdingHours != null ? t.holdingHours : null,
            sources: JSON.stringify(t.sources || []),
            buy_reason: t.buyReason || null,
            entry_time: t.entryTime || null,
            exit_time: t.exitTime || null,
            order_id: t.orderId || null,
          });
          results.trades++;
        }
      });
      migrateTrades(trades);
      console.log(`[Migration]   Trades: ${results.trades} imported`);
    } else {
      console.log('[Migration]   No performance_ledger.json found');
    }
  } catch (err) {
    results.errors.push(`Trade migration: ${err.message}`);
    console.error('[Migration]   Trade migration failed:', err.message);
  }

  // 3. Migrate signal_transitions.jsonl
  console.log('[Migration] Importing signal transitions...');
  try {
    const transFile = path.join(HISTORY_DIR, 'signal_transitions.jsonl');
    if (fs.existsSync(transFile)) {
      const lines = fs.readFileSync(transFile, 'utf8').split('\n').filter(l => l.trim());

      const insertTransStmt = db.prepare(`
        INSERT INTO signal_transitions (signal_id, ticker, source, score, direction, from_state, to_state, reason)
        VALUES (@signal_id, @ticker, @source, @score, @direction, @from_state, @to_state, @reason)
      `);

      const migrateTransitions = db.transaction((lineList) => {
        for (const line of lineList) {
          try {
            const data = JSON.parse(line);
            insertTransStmt.run({
              signal_id: data.signalId || null,
              ticker: data.ticker || null,
              source: data.source || null,
              score: data.score != null ? data.score : null,
              direction: data.direction || null,
              from_state: data.from || null,
              to_state: data.to || null,
              reason: data.reason || null,
            });
            results.signalTransitions++;
          } catch (err) {
            results.errors.push(`Signal transition line: ${err.message}`);
          }
        }
      });
      migrateTransitions(lines);
      console.log(`[Migration]   Signal transitions: ${results.signalTransitions} imported`);
    } else {
      console.log('[Migration]   No signal_transitions.jsonl found');
    }
  } catch (err) {
    results.errors.push(`Signal transition migration: ${err.message}`);
    console.error('[Migration]   Signal transition migration failed:', err.message);
  }

  // 4. Migrate cycle_log.jsonl
  console.log('[Migration] Importing cycle log...');
  try {
    const cycleFile = path.join(HISTORY_DIR, 'cycle_log.jsonl');
    if (fs.existsSync(cycleFile)) {
      const lines = fs.readFileSync(cycleFile, 'utf8').split('\n').filter(l => l.trim());

      const insertCycleStmt = db.prepare(`
        INSERT INTO cycles (equity, positions, total_signals, confirmed, executed, rejected, rejections, created_at)
        VALUES (@equity, @positions, @total_signals, @confirmed, @executed, @rejected, @rejections, @created_at)
      `);

      const migrateCycles = db.transaction((lineList) => {
        for (const line of lineList) {
          try {
            const data = JSON.parse(line);
            insertCycleStmt.run({
              equity: data.equity != null ? data.equity : null,
              positions: data.positions != null ? data.positions : null,
              total_signals: data.total != null ? data.total : null,
              confirmed: data.confirmed != null ? data.confirmed : null,
              executed: data.executed != null ? data.executed : null,
              rejected: data.rejected != null ? data.rejected : null,
              rejections: data.rejections ? JSON.stringify(data.rejections) : null,
              created_at: data.timestamp || null,
            });
            results.cycles++;
          } catch (err) {
            results.errors.push(`Cycle log line: ${err.message}`);
          }
        }
      });
      migrateCycles(lines);
      console.log(`[Migration]   Cycles: ${results.cycles} imported`);
    } else {
      console.log('[Migration]   No cycle_log.jsonl found');
    }
  } catch (err) {
    results.errors.push(`Cycle migration: ${err.message}`);
    console.error('[Migration]   Cycle migration failed:', err.message);
  }

  // 5. Migrate equity_curve.json
  console.log('[Migration] Importing equity curve...');
  try {
    const equityFile = path.join(HISTORY_DIR, 'equity_curve.json');
    if (fs.existsSync(equityFile)) {
      const data = JSON.parse(fs.readFileSync(equityFile, 'utf8'));
      const snapshots = data.snapshots || [];

      const insertSnapStmt = db.prepare(`
        INSERT OR IGNORE INTO equity_snapshots (date, equity, positions, buys, sells)
        VALUES (@date, @equity, @positions, @buys, @sells)
      `);

      const migrateSnapshots = db.transaction((snaps) => {
        for (const s of snaps) {
          insertSnapStmt.run({
            date: s.date || null,
            equity: s.equity != null ? s.equity : null,
            positions: s.positions != null ? s.positions : null,
            buys: s.buys != null ? s.buys : null,
            sells: s.sells != null ? s.sells : null,
          });
          results.equitySnapshots++;
        }
      });
      migrateSnapshots(snapshots);
      console.log(`[Migration]   Equity snapshots: ${results.equitySnapshots} imported`);
    } else {
      console.log('[Migration]   No equity_curve.json found');
    }
  } catch (err) {
    results.errors.push(`Equity curve migration: ${err.message}`);
    console.error('[Migration]   Equity curve migration failed:', err.message);
  }

  // 6. Migrate governor_state.json
  console.log('[Migration] Importing governor state...');
  try {
    const govFile = path.join(HISTORY_DIR, 'governor_state.json');
    if (fs.existsSync(govFile)) {
      const state = JSON.parse(fs.readFileSync(govFile, 'utf8'));
      saveGovernorState(state);
      results.governorState = true;
      console.log('[Migration]   Governor state: imported');
    } else {
      console.log('[Migration]   No governor_state.json found');
    }
  } catch (err) {
    results.errors.push(`Governor state migration: ${err.message}`);
    console.error('[Migration]   Governor state migration failed:', err.message);
  }

  // 7. Migrate engine_state.json
  console.log('[Migration] Importing engine state...');
  try {
    const engFile = path.join(HISTORY_DIR, 'engine_state.json');
    if (fs.existsSync(engFile)) {
      const state = JSON.parse(fs.readFileSync(engFile, 'utf8'));
      saveEngineState(state);
      results.engineState = true;
      console.log('[Migration]   Engine state: imported');
    } else {
      console.log('[Migration]   No engine_state.json found');
    }
  } catch (err) {
    results.errors.push(`Engine state migration: ${err.message}`);
    console.error('[Migration]   Engine state migration failed:', err.message);
  }

  // Summary
  console.log('\n[Migration] ── Summary ──────────────────────────────');
  console.log(`  Orders:             ${results.orders}`);
  console.log(`  Trades:             ${results.trades}`);
  console.log(`  Signal transitions: ${results.signalTransitions}`);
  console.log(`  Cycles:             ${results.cycles}`);
  console.log(`  Equity snapshots:   ${results.equitySnapshots}`);
  console.log(`  Governor state:     ${results.governorState ? 'Yes' : 'No'}`);
  console.log(`  Engine state:       ${results.engineState ? 'Yes' : 'No'}`);
  if (results.errors.length > 0) {
    console.log(`  Errors:             ${results.errors.length}`);
    for (const e of results.errors) console.log(`    - ${e}`);
  }
  console.log('[Migration] Original JSON files preserved as backup.');
  console.log('[Migration] Done.');

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════

function close() {
  if (db) {
    try {
      _stmts = {};
      db.close();
    } catch (err) {
      console.error('[Database] Error closing database:', err.message);
    }
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────
module.exports = {
  db,

  // Orders
  insertOrder,
  getOrderById,
  getOrdersBySymbol,

  // Trades (closed)
  insertTrade,
  getAllTrades,
  getTradesBySymbol,
  getTradeStats,
  isOrderProcessed,

  // Signals
  insertSignalTransition,
  getSignalHistory,

  // Cycles
  insertCycle,
  getRecentCycles,

  // Equity
  upsertEquitySnapshot,
  getEquityCurve,

  // Governor State
  getGovernorState,
  saveGovernorState,

  // Engine State
  getEngineState,
  saveEngineState,

  // Calibration
  insertCalibration,
  getLatestCalibration,
  getCalibrationHistory,

  // Migration
  migrateFromJSON,

  // Utility
  close,
};
